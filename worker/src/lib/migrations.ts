import type { Env } from "./types";
import { normalizeVendor } from "./rules";

/**
 * Runtime seed/migration (v1.2.1). Applies the idempotent mapping upserts that
 * previously required a manual `npm run db:init` (wrangler) run — so location
 * keyword and managed-vendor changes go live automatically on deploy, with no
 * manual step.
 *
 * SAFETY: only SYSTEM-MANAGED rows with fixed ids are touched (INSERT OR REPLACE).
 * Admin-created vendor mappings (which use other ids) and ALL invoice / line-item
 * / user data are never affected — this only upserts the handful of mapping rows
 * the application code owns. Mirrors the `-- live-migration` block in
 * db/schema.sql; keep the two in sync (append a row here when its code-owned
 * keywords/values change).
 *
 * Runs once per Worker isolate, lazily on the first request, and NEVER throws —
 * a failure just logs and is retried on the next request (so a transient D1
 * hiccup can't take the API down).
 */

interface SeedLocation {
  id: string;
  address: string;
  keywords: string[];
  business: string;
  class: string;
  default_approver: string;
}

// System-managed location rows whose keywords are owned by the code (the IBW
// schools, which share the 327 E St Paul building with Neroli and must match on
// the school NAME — v1.2.0 FIX 5). The other locations are unchanged since the
// initial seed, so only these need to be kept in sync at runtime.
const SEED_LOCATIONS: SeedLocation[] = [
  {
    id: "loc-milwaukee",
    address: "327 E St Paul 5th Floor",
    keywords: [
      "327 E St Paul 5th Floor",
      "IBW-Milwaukee",
      "IBW Milwaukee",
      "Institute of Beauty & Wellness",
      "Institute of Beauty and Wellness",
      "Institute of Beauty",
      "IBW",
    ],
    business: "IBW",
    class: "Milwaukee",
    default_approver: "Kari",
  },
  {
    id: "loc-madison",
    address: "7021 Tree Ln",
    keywords: [
      "7021 Tree Ln",
      "IBW-Madison",
      "IBW Madison",
      "Madison",
      "Institute of Beauty & Wellness",
      "Institute of Beauty and Wellness",
      "Institute of Beauty",
      "IBW",
    ],
    business: "IBW",
    class: "Madison",
    default_approver: "Kari",
  },
];

// System-managed inventory/retail vendor mappings — cosmetic/product distributors
// that should code to Retail / Product Costs with HIGH confidence (v1.1.7/v1.2.0).
const SEED_INVENTORY_VENDORS: { id: string; name: string }[] = [
  { id: "ven-olivegarden", name: "Olive Garden" },
  { id: "ven-wella", name: "Wella" },
  { id: "ven-abbvie", name: "AbbVie" },
  { id: "ven-opi", name: "OPI" },
];

// System-managed vendor aliases — confirmed OCR spelling variants that should
// canonicalize onto an existing vendor_mappings row so they inherit its GL
// coding (vendor canonicalization). `alias_norm` is computed with the SAME
// normalizeVendor() that findVendorMapping uses, so the deterministic exact-
// equality lookup is guaranteed to hit. The canonical_id must be a fixed-id
// system seed (here ven-olivegarden), so the FK target always exists.
const SEED_VENDOR_ALIASES: { id: string; alias: string; canonical_id: string }[] = [
  { id: "alias-oliviagarden", alias: "Olivia Garden", canonical_id: "ven-olivegarden" },
  // add more confirmed OCR variants here as they surface
];

let schemaEnsured = false;

/**
 * Runtime SCHEMA migration (v1.2.9). Applies the additive DDL the archive /
 * audit-clear features (v1.2.8) need — the nullable `invoices.archived_at`
 * column, its index, and the `audit_clear_cutoffs` table — so the database
 * upgrades ITSELF on the first request after deploy, with NO manual
 * `wrangler d1 execute` step on anyone's part.
 *
 * SAFETY: purely additive. `ADD COLUMN` only adds a new nullable column (no data
 * is read, moved, or dropped); the CREATE statements are IF NOT EXISTS. Existing
 * invoice / line-item / audit / user data is never touched. Mirrors the
 * `-- live-migration` DDL appended to db/schema.sql (which is used by a fresh
 * `db:init`); keep the two in sync.
 *
 * Idempotency: `ADD COLUMN` is NOT idempotent in SQLite — it errors once the
 * column exists, which we detect and ignore. Runs once per isolate, never throws
 * (a transient failure just logs and retries on the next request).
 */
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaEnsured) return;
  // 1) Add the archive column. Tolerate the expected "duplicate column" error
  //    when it already exists; bail (without latching) on anything unexpected so
  //    it's retried next request.
  try {
    await env.DB.prepare("ALTER TABLE invoices ADD COLUMN archived_at TEXT").run();
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (!/duplicate column|already exists/i.test(msg)) {
      console.error("[migrations] add archived_at failed (will retry):", e);
      return;
    }
  }
  // 2) Index + cutoff table + vendor_aliases — all naturally idempotent
  //    (CREATE … IF NOT EXISTS). vendor_aliases canonicalizes OCR vendor spelling
  //    variants onto a vendor_mappings row (additive + reversible).
  try {
    await env.DB.batch([
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_invoices_archived ON invoices(archived_at)",
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS audit_clear_cutoffs (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, cutoff_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS vendor_aliases (id TEXT PRIMARY KEY, alias_text TEXT NOT NULL, alias_norm TEXT NOT NULL UNIQUE, canonical_id TEXT NOT NULL REFERENCES vendor_mappings(id) ON DELETE CASCADE, created_by TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_vendor_aliases_norm ON vendor_aliases(alias_norm)",
      ),
    ]);
    schemaEnsured = true;
  } catch (e) {
    console.error("[migrations] ensureSchema failed (will retry):", e);
  }
}

let ensured = false;

/**
 * Idempotently upserts the system-managed mapping rows into D1. No-op after the
 * first successful run in this isolate. Safe to call on every request.
 */
export async function ensureSeedData(env: Env): Promise<void> {
  if (ensured) return;
  try {
    const stmts = [
      ...SEED_LOCATIONS.map((l) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO location_mappings (id, address, keywords, business, class, default_approver) VALUES (?,?,?,?,?,?)",
        ).bind(
          l.id,
          l.address,
          JSON.stringify(l.keywords),
          l.business,
          l.class,
          l.default_approver,
        ),
      ),
      ...SEED_INVENTORY_VENDORS.map((v) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES (?,?,?,?,?,?,?)",
        ).bind(v.id, v.name, null, null, null, 1, "Retail / Product Costs"),
      ),
      // Vendor aliases — upserted AFTER the inventory vendors above so the
      // canonical_id FK target exists in the same batch. `alias_norm` uses the
      // SAME normalizeVendor() the matcher computes, guaranteeing the lookup hits.
      ...SEED_VENDOR_ALIASES.map((a) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO vendor_aliases (id, alias_text, alias_norm, canonical_id) VALUES (?,?,?,?)",
        ).bind(a.id, a.alias, normalizeVendor(a.alias), a.canonical_id),
      ),
    ];
    await env.DB.batch(stmts);
    ensured = true;
  } catch (e) {
    // Never break a request on a seed failure — log and retry next request.
    console.error("[migrations] ensureSeedData failed (will retry):", e);
  }
}
