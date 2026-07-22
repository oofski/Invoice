import type { Env, UserRow, AuthUser } from "./types";
import { uuid } from "./util";

/**
 * Email + password auth using WebCrypto PBKDF2 (no native deps — runs in
 * Workers). Sessions are opaque bearer tokens stored in the `sessions` table.
 */

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPassword(
  password: string,
  saltHex?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return { hash: toHex(bits), salt: toHex(salt.buffer) };
}

export async function verifyPassword(
  password: string,
  hash: string,
  salt: string,
): Promise<boolean> {
  const computed = await hashPassword(password, salt);
  // constant-time-ish compare
  if (computed.hash.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++)
    diff |= computed.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export async function createSession(
  env: Env,
  userId: string,
): Promise<string> {
  const token = uuid() + uuid().replace(/-/g, "");
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(token, userId, expires)
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

/** Resolves the bearer token to an active user, or null. */
export async function userFromToken(
  env: Env,
  token: string | null,
): Promise<AuthUser | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(token, new Date().toISOString())
    .first<UserRow>();
  if (!row || !row.is_active) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    entity_access: row.entity_access ? JSON.parse(row.entity_access) : null,
    must_change_password: !!row.must_change_password,
  };
}

export function bearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
