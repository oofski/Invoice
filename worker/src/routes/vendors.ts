import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin } from "./helpers";
import { uuid, nowIso } from "../lib/util";
import type { VendorMappingRow } from "../lib/types";

export const vendors = new Hono<AppEnv>();

vendors.get("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT * FROM vendor_mappings ORDER BY vendor_name ASC",
  ).all<VendorMappingRow>();
  return c.json({
    vendors: (rows.results ?? []).map((v) => ({ ...v, is_inventory: !!v.is_inventory })),
  });
});

vendors.post("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const vendor_name = (b.vendor_name as string)?.trim();
  if (!vendor_name) return c.json({ error: "vendor_name required" }, 400);
  const id = uuid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(
      id, vendor_name, b.business_entity ?? null, b.class ?? null,
      b.default_approver ?? null, b.is_inventory ? 1 : 0, b.gl_override ?? null,
    ).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "Vendor already exists" }, 409);
    throw e;
  }
  return c.json({ vendor: { id, vendor_name } }, 201);
});

vendors.patch("/:id", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = ["vendor_name", "business_entity", "class", "default_approver", "is_inventory", "gl_override"];
  const sets: string[] = ["updated_at = ?"];
  const params: unknown[] = [nowIso()];
  for (const k of allowed) {
    if (k in b) {
      sets.push(`${k} = ?`);
      params.push(k === "is_inventory" ? (b[k] ? 1 : 0) : b[k]);
    }
  }
  params.push(c.req.param("id"));
  try {
    await c.env.DB.prepare(`UPDATE vendor_mappings SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...params).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "Vendor name already exists" }, 409);
    throw e;
  }
  return c.json({ ok: true });
});
