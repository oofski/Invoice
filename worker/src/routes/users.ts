import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { hasRole, isStaffOrAdmin, user } from "./helpers";
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

// POST /:id/reset-password — issue a new temporary password (admin only)
users.post("/:id/reset-password", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const target = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!target) return c.json({ error: "Not found" }, 404);

  const tempPassword = uuid().slice(0, 10) + "A9!";
  const { hash, salt } = await hashPassword(tempPassword);
  await c.env.DB.prepare(
    "UPDATE users SET password_hash=?, password_salt=?, must_change_password=1 WHERE id=?",
  )
    .bind(hash, salt, id)
    .run();
  // Returned to the admin to share securely; the user must change it on login.
  return c.json({ tempPassword });
});

// DELETE /:id — remove a user (admin only)
users.delete("/:id", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const me = user(c);
  if (id === me.id)
    return c.json({ error: "You can't delete your own account" }, 400);

  const target = await c.env.DB.prepare("SELECT id, role FROM users WHERE id = ?")
    .bind(id)
    .first<{ id: string; role: string }>();
  if (!target) return c.json({ error: "Not found" }, 404);

  if (target.role === ROLES.ADMIN) {
    const admins = await c.env.DB.prepare(
      "SELECT COUNT(*) as n FROM users WHERE role = ? AND is_active = 1",
    )
      .bind(ROLES.ADMIN)
      .first<{ n: number }>();
    if ((admins?.n ?? 0) <= 1)
      return c.json({ error: "Can't delete the last active admin" }, 400);
  }

  // Null out FK references first so the delete can't fail, then delete the user
  // (sessions cascade). Invoices/approvals/exports keep their history.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invoices SET submitted_by = NULL WHERE submitted_by = ?").bind(id),
    c.env.DB.prepare("UPDATE approvals SET assigned_to = NULL WHERE assigned_to = ?").bind(id),
    c.env.DB.prepare("UPDATE exports SET exported_by = NULL WHERE exported_by = ?").bind(id),
    c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});
