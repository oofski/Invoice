import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin, user, hasRole } from "./helpers";
import { parseJson, nowIso } from "../lib/util";
import { ROLES, AUDIT_ACTION } from "../lib/constants";
import { audit as writeAudit } from "../lib/db";
import type { UserRow, InvoiceRow } from "../lib/types";

export const audit = new Hono<AppEnv>();

/**
 * F3: per-user audit-view cutoff. Returns the user's cutoff_at (ISO) or null.
 * Wrapped in try/catch so a pre-migration DB (no audit_clear_cutoffs table) is
 * tolerated — absent table → no cutoff (all rows visible).
 */
async function getAuditCutoff(
  env: AppEnv["Bindings"],
  userId: string,
): Promise<string | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT cutoff_at FROM audit_clear_cutoffs WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ cutoff_at: string }>();
    return row?.cutoff_at ?? null;
  } catch {
    return null;
  }
}

/** True once the audit-cutoff migration (audit_clear_cutoffs table) has run. */
async function cutoffReady(env: AppEnv["Bindings"]): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1 FROM audit_clear_cutoffs LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

interface AuditRow {
  id: string;
  invoice_id: string | null;
  user_id: string | null;
  action: string;
  prev_value: string | null;
  new_value: string | null;
  note: string | null;
  created_at: string;
}

async function enrich(c: import("hono").Context<AppEnv>, rows: AuditRow[]) {
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter(Boolean))) as string[];
  const invIds = Array.from(new Set(rows.map((r) => r.invoice_id).filter(Boolean))) as string[];
  const nameById: Record<string, string> = {};
  const vendorById: Record<string, string> = {};
  if (userIds.length) {
    const us = await c.env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
    ).bind(...userIds).all<Pick<UserRow, "id" | "name">>();
    for (const u of us.results ?? []) nameById[u.id] = u.name;
  }
  if (invIds.length) {
    const iv = await c.env.DB.prepare(
      `SELECT id, vendor FROM invoices WHERE id IN (${invIds.map(() => "?").join(",")})`,
    ).bind(...invIds).all<Pick<InvoiceRow, "id" | "vendor">>();
    for (const i of iv.results ?? []) vendorById[i.id] = i.vendor;
  }
  return rows.map((e) => ({
    ...e,
    prev_value: parseJson(e.prev_value, null),
    new_value: parseJson(e.new_value, null),
    user_name: e.user_id ? (nameById[e.user_id] ?? "System") : "System",
    vendor: e.invoice_id ? (vendorById[e.invoice_id] ?? null) : null,
  }));
}

// GET / — global log with filters
audit.get("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  let sql = "SELECT * FROM audit_log WHERE 1=1";
  const params: (string | number)[] = [];
  const action = c.req.query("action");
  if (action) { sql += " AND action = ?"; params.push(action); }
  const userId = c.req.query("userId");
  if (userId) { sql += " AND user_id = ?"; params.push(userId); }
  const from = c.req.query("from");
  if (from) { sql += " AND created_at >= ?"; params.push(from); }
  const to = c.req.query("to");
  if (to) { sql += " AND created_at <= ?"; params.push(to); }

  // F3: apply this user's clear cutoff (a per-user read bookmark — never deletes
  // rows). ?showAll=1 bypasses it. AND-combined with the existing filters above.
  const showAll = !!c.req.query("showAll");
  if (!showAll) {
    const cutoff = await getAuditCutoff(c.env, user(c).id);
    if (cutoff) { sql += " AND created_at > ?"; params.push(cutoff); }
  }

  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Number(c.req.query("limit") ?? 500));
  const rows = await c.env.DB.prepare(sql).bind(...params).all<AuditRow>();
  return c.json({ entries: await enrich(c, rows.results ?? []) });
});

// POST /clear — set this user's audit-view cutoff (admin only). Never deletes
// or mutates audit_log rows; the cutoff is a per-user bookmark so each admin
// clears only their own view while the global log stays intact for everyone.
audit.post("/clear", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  if (!(await cutoffReady(c.env)))
    return c.json({ error: "Audit clear needs a one-time database setup — run the migration." }, 503);

  const u = user(c);
  const at = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO audit_clear_cutoffs (user_id, cutoff_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET cutoff_at = excluded.cutoff_at, updated_at = excluded.updated_at`,
  )
    .bind(u.id, at, at)
    .run();

  await writeAudit(c.env, {
    invoiceId: null,
    userId: u.id,
    action: AUDIT_ACTION.AUDIT_CLEARED,
    note: `Audit view cleared by ${u.name}`,
  });
  return c.json({ ok: true, cutoff_at: at });
});

// POST /clear/reset — drop this user's cutoff so the full view returns (admin only).
audit.post("/clear/reset", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  if (!(await cutoffReady(c.env)))
    return c.json({ error: "Audit clear needs a one-time database setup — run the migration." }, 503);
  await c.env.DB.prepare("DELETE FROM audit_clear_cutoffs WHERE user_id = ?")
    .bind(user(c).id)
    .run();
  return c.json({ ok: true });
});

// GET /:invoiceId — per-invoice trail
audit.get("/:invoiceId", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM audit_log WHERE invoice_id = ? ORDER BY created_at DESC",
  ).bind(c.req.param("invoiceId")).all<AuditRow>();
  return c.json({ entries: await enrich(c, rows.results ?? []) });
});
