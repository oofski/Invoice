import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin, user } from "./helpers";
import { uuid, nowIso } from "../lib/util";
import { normalizeVendor } from "../lib/rules";
import type { VendorMappingRow, VendorAliasRow } from "../lib/types";

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

// ---------------------------------------------------------------- VENDOR ALIASES
// Deterministic canonicalization of OCR vendor spelling variants onto a canonical
// vendor_mappings row. Lookup at coding time is exact-normalized-equality on
// alias_norm (see findVendorMapping); these routes manage the curated rows. All
// isStaffOrAdmin-gated, consistent with the rest of this router.

/** GET /api/vendors/aliases — list aliases joined to their canonical vendor name. */
vendors.get("/aliases", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT a.id, a.alias_text, a.alias_norm, a.canonical_id, a.created_by, a.created_at,
            v.vendor_name AS canonical_name
       FROM vendor_aliases a
       LEFT JOIN vendor_mappings v ON v.id = a.canonical_id
      ORDER BY v.vendor_name ASC, a.alias_text ASC`,
  ).all<VendorAliasRow & { canonical_name: string | null }>();
  return c.json({ aliases: rows.results ?? [] });
});

/**
 * POST /api/vendors/aliases { alias_text, canonical_id } — create an alias.
 * Computes alias_norm = normalizeVendor(alias_text). 400 on missing/blank
 * alias_text, an alias_text that normalizes to empty, or a canonical_id that
 * isn't an existing vendor_mappings row. 409 on alias_norm UNIQUE conflict.
 */
vendors.post("/aliases", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const alias_text = (b.alias_text as string)?.trim();
  const canonical_id = (b.canonical_id as string)?.trim();
  if (!alias_text) return c.json({ error: "alias_text required" }, 400);
  if (!canonical_id) return c.json({ error: "canonical_id required" }, 400);
  const alias_norm = normalizeVendor(alias_text);
  if (!alias_norm) return c.json({ error: "alias_text is empty after normalization" }, 400);
  const canon = await c.env.DB.prepare(
    "SELECT id, vendor_name FROM vendor_mappings WHERE id = ?",
  ).bind(canonical_id).first<{ id: string; vendor_name: string }>();
  if (!canon) return c.json({ error: "canonical_id is not a valid vendor" }, 400);
  const id = uuid();
  try {
    await c.env.DB.prepare(
      "INSERT INTO vendor_aliases (id, alias_text, alias_norm, canonical_id, created_by) VALUES (?,?,?,?,?)",
    ).bind(id, alias_text, alias_norm, canonical_id, user(c).id).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "Alias already exists" }, 409);
    throw e;
  }
  return c.json(
    { alias: { id, alias_text, alias_norm, canonical_id, canonical_name: canon.vendor_name } },
    201,
  );
});

/** DELETE /api/vendors/aliases/:id — remove an alias (reverts coding to default). */
vendors.delete("/aliases/:id", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  await c.env.DB.prepare("DELETE FROM vendor_aliases WHERE id = ?")
    .bind(c.req.param("id")).run();
  return c.body(null, 204);
});

/**
 * GET /api/vendors/suggest?vendor=... — ADVISORY ONLY fuzzy match for the admin
 * "create alias?" workflow. Returns top candidate vendor_mappings rows by
 * normalized token similarity. NEVER changes coding — coding only uses the
 * deterministic alias table. Guardrails to avoid short-name false positives:
 *   - ignore tokens < 4 chars on BOTH sides,
 *   - require >= 1 shared (>=4 char) token,
 *   - score = shared / union of the >=4-char token sets (Jaccard).
 */
vendors.get("/suggest", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const vendor = (c.req.query("vendor") ?? "").trim();
  const n = normalizeVendor(vendor);
  if (!n) return c.json({ suggestions: [] });
  const longTokens = (s: string) => new Set(s.split(" ").filter((t) => t.length >= 4));
  const qTokens = longTokens(n);
  if (qTokens.size === 0) return c.json({ suggestions: [] });
  const rows = await c.env.DB.prepare(
    "SELECT id, vendor_name FROM vendor_mappings",
  ).all<{ id: string; vendor_name: string }>();
  const scored = (rows.results ?? [])
    .map((r) => {
      const rTokens = longTokens(normalizeVendor(r.vendor_name));
      if (rTokens.size === 0) return null;
      let shared = 0;
      for (const t of qTokens) if (rTokens.has(t)) shared++;
      if (shared < 1) return null; // require >= 1 shared >=4-char token
      const union = new Set([...qTokens, ...rTokens]).size;
      const score = union > 0 ? shared / union : 0;
      return { canonical_id: r.id, vendor_name: r.vendor_name, score };
    })
    .filter((x): x is { canonical_id: string; vendor_name: string; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return c.json({ suggestions: scored });
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
