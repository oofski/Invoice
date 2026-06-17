import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { hasRole, isStaffOrAdmin } from "./helpers";
import { hashPassword } from "../lib/auth";
import { uuid } from "../lib/util";
import { ALL_ROLES, ROLES } from "../lib/constants";
import type { UserRow } from "../lib/types";

export const users = new Hono<AppEnv>();

// GET / — list (accountant + admin)
users.get("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT id, name, email, role, entity_access, is_active, must_change_password, created_at FROM users ORDER BY role, name",
  ).all<UserRow>();
  return c.json({
    users: (rows.results ?? []).map((u) => ({
      ...u,
      is_active: !!u.is_active,
      entity_access: u.entity_access ? JSON.parse(u.entity_access) : null,
    })),
  });
});

// POST / — create user with a temporary password (admin only)
users.post("/", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = (b.name as string)?.trim();
  const email = (b.email as string)?.trim().toLowerCase();
  const role = b.role as string;
  if (!name || !email || !role) return c.json({ error: "name, email, role required" }, 400);
  if (!ALL_ROLES.includes(role as never)) return c.json({ error: "Invalid role" }, 400);

  // Temp password: provided or generated; user must change on first login.
  const tempPassword =
    (b.password as string) || uuid().slice(0, 10) + "A9!";
  const { hash, salt } = await hashPassword(tempPassword);
  const id = uuid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO users (id, name, email, role, entity_access, password_hash, password_salt, must_change_password, is_active)
       VALUES (?,?,?,?,?,?,?,1,1)`,
    ).bind(
      id, name, email, role,
      Array.isArray(b.entity_access) ? JSON.stringify(b.entity_access) : null,
      hash, salt,
    ).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "Email already exists" }, 409);
    throw e;
  }
  // Return the temp password to the admin so they can share it securely.
  return c.json({ user: { id, name, email, role }, tempPassword }, 201);
});

// PATCH /:id — update role/entity/active/name (admin only)
users.patch("/:id", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if ("role" in b) {
    if (!ALL_ROLES.includes(b.role as never)) return c.json({ error: "Invalid role" }, 400);
    sets.push("role = ?"); params.push(b.role);
  }
  if ("entity_access" in b) {
    sets.push("entity_access = ?");
    params.push(Array.isArray(b.entity_access) ? JSON.stringify(b.entity_access) : null);
  }
  if ("is_active" in b) { sets.push("is_active = ?"); params.push(b.is_active ? 1 : 0); }
  if ("name" in b) { sets.push("name = ?"); params.push(b.name); }
  if (!sets.length) return c.json({ error: "No updatable fields" }, 400);
  params.push(c.req.param("id"));
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  return c.json({ ok: true });
});
