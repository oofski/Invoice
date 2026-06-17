import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin } from "./helpers";
import { parseJson } from "../lib/util";
import type { UserRow, InvoiceRow } from "../lib/types";

export const audit = new Hono<AppEnv>();

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
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Number(c.req.query("limit") ?? 500));
  const rows = await c.env.DB.prepare(sql).bind(...params).all<AuditRow>();
  return c.json({ entries: await enrich(c, rows.results ?? []) });
});

// GET /:invoiceId — per-invoice trail
audit.get("/:invoiceId", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM audit_log WHERE invoice_id = ? ORDER BY created_at DESC",
  ).bind(c.req.param("invoiceId")).all<AuditRow>();
  return c.json({ entries: await enrich(c, rows.results ?? []) });
});
