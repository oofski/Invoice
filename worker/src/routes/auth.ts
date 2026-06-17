import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { user } from "./helpers";
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  bearer,
} from "../lib/auth";
import { uuid } from "../lib/util";
import { ROLES } from "../lib/constants";
import type { UserRow } from "../lib/types";

// Public auth routes (no auth middleware).
export const authPublic = new Hono<AppEnv>();

/** POST /api/auth/bootstrap — create the FIRST admin (only when no users exist). */
authPublic.post("/bootstrap", async (c) => {
  const count = await c.env.DB.prepare("SELECT COUNT(*) as n FROM users").first<{
    n: number;
  }>();
  if ((count?.n ?? 0) > 0)
    return c.json({ error: "Already initialized" }, 409);

  const body = await c.req.json().catch(() => ({}));
  const { name, email, password } = body as Record<string, string>;
  if (!name || !email || !password || password.length < 8)
    return c.json({ error: "name, email and password (8+ chars) required" }, 400);

  const { hash, salt } = await hashPassword(password);
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO users (id, name, email, role, password_hash, password_salt, is_active)
     VALUES (?,?,?,?,?,?,1)`,
  )
    .bind(id, name, email.toLowerCase(), ROLES.ADMIN, hash, salt)
    .run();
  const token = await createSession(c.env, id);
  return c.json({ token, user: { id, name, email, role: ROLES.ADMIN } }, 201);
});

/** POST /api/auth/login */
authPublic.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, password } = body as Record<string, string>;
  if (!email || !password)
    return c.json({ error: "email and password required" }, 400);

  const row = await c.env.DB.prepare(
    "SELECT * FROM users WHERE email = ?",
  )
    .bind(email.toLowerCase())
    .first<UserRow & { password_hash: string; password_salt: string }>();

  if (!row || !row.is_active || !row.password_hash)
    return c.json({ error: "Invalid email or password" }, 401);

  const ok = await verifyPassword(password, row.password_hash, row.password_salt);
  if (!ok) return c.json({ error: "Invalid email or password" }, 401);

  const token = await createSession(c.env, row.id);
  return c.json({
    token,
    user: {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role,
      must_change_password: !!row.must_change_password,
    },
  });
});

// Authenticated auth routes (mounted behind the auth middleware).
export const authProtected = new Hono<AppEnv>();

authProtected.get("/me", (c) => c.json({ user: user(c) }));

authProtected.post("/logout", async (c) => {
  const token = bearer(c.req.header("authorization"));
  if (token) await destroySession(c.env, token);
  return c.json({ ok: true });
});

authProtected.post("/change-password", async (c) => {
  const u = user(c);
  const body = await c.req.json().catch(() => ({}));
  const { newPassword } = body as Record<string, string>;
  if (!newPassword || newPassword.length < 8)
    return c.json({ error: "newPassword (8+ chars) required" }, 400);
  const { hash, salt } = await hashPassword(newPassword);
  await c.env.DB.prepare(
    "UPDATE users SET password_hash=?, password_salt=?, must_change_password=0 WHERE id=?",
  )
    .bind(hash, salt, u.id)
    .run();
  return c.json({ ok: true });
});
