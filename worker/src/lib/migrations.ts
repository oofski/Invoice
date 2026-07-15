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

/**
 * System-managed vendor → GL-category mappings. CATEGORY-ONLY by design: every row
 * sets ONLY `gl_override` + `is_inventory` and leaves `business_entity`, `class`,
 * and `default_approver` NULL — the invoice's ship-to + the routing rules decide
 * entity / class / approver PER INVOICE (v1.6.0), never the vendor. Mirrors the
 * bind shape of the prior inventory seeds (`bind(id, name, null, null, null,
 * is_inventory, gl_override)`) and SUPERSEDES the old SEED_INVENTORY_VENDORS —
 * AbbVie / OPI / Wella / Olive Garden are folded in here.
 *
 * `gl` MUST be a real account NAME from constants.ts (GL_CATEGORIES_FLAT /
 * ENTITY_COA). A PRODUCT override ("Retail / Product Costs") with is_inventory=1
 * runs the tax split (untaxed→Retail 5100, taxed→Service Costs / backbar 5000) and
 * stays entity-gated (Nala/Admin fall through to manual review). A NON-product
 * override is absolute (returned HIGH at L2). See
 * scratchpad/vendor-category-mapping-spec.md §A/§C/§D for the account choices,
 * entity-validity notes, and the Olive/Olivia reconciliation.
 */
interface ManagedVendor {
  id: string;
  /** token-safe vendor_name (fuller real name where a bare token would collide). */
  name: string;
  /** real GL account NAME (validated against GL_CATEGORIES_FLAT at coding time). */
  gl: string;
  inv: 0 | 1;
}

const SEED_MANAGED_VENDORS: ManagedVendor[] = [
  // — inventory / product distributors (is_inventory=1 → tax split, entity-gated) —
  { id: "ven-abbvie", name: "AbbVie", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-opi", name: "OPI", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-wella", name: "Wella", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-marlo", name: "Marlo Beauty Supply", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-ultraceuticals", name: "Ultraceuticals", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-concordance", name: "Concordance", gl: "Retail / Product Costs", inv: 1 },
  { id: "ven-cohere", name: "Cohere Beauty", gl: "Retail / Product Costs", inv: 1 },
  // FROMM: inventory (Retail/Product) mapping. Does NOT override the existing
  // VENDOR_CATEGORY["Fromm International"]="Kit Costs" rule — vendorCategory (L2
  // VENDOR) runs BEFORE this vendor-mapping block, so on IBW/Chicago FROMM still
  // codes Kit Costs; on Neroli/SKNBar (Kit Costs invalid) it falls to this row.
  { id: "ven-fromm", name: "Fromm International", gl: "Retail / Product Costs", inv: 1 },
  // §D: Olivia Garden = the professional beauty-tools brand → its own inventory row.
  { id: "ven-oliviagarden", name: "Olivia Garden", gl: "Retail / Product Costs", inv: 1 },
  // — facilities / maintenance / cleaning (non-product; salon/school COA) —
  { id: "ven-adelman", name: "Adelman", gl: "Repairs & Maintenance", inv: 0 },
  { id: "ven-avellas", name: "Avellas", gl: "Repairs & Maintenance", inv: 0 },
  { id: "ven-beautifulclean", name: "Beautiful Clean", gl: "Repairs & Maintenance", inv: 0 },
  { id: "ven-guthriefrey", name: "Guthrie & Frey", gl: "Repairs & Maintenance", inv: 0 },
  { id: "ven-fish", name: "Fish Window Cleaning", gl: "Repairs & Maintenance", inv: 0 }, // token-safe name (not "FISH")
  // — utilities / water treatment / occupancy —
  { id: "ven-culligan", name: "Culligan", gl: "Utilities", inv: 0 },
  // Billing-name variant for the same water-treatment service; "Culligan Total
  // Water" also lands on Utilities (it matches the ven-culligan token). token-safe.
  { id: "ven-totalwater", name: "Total Water Treatment Systems", gl: "Utilities", inv: 0 },
  { id: "ven-brixmor", name: "Brixmor", gl: "Occupancy - Rent", inv: 0 },
  { id: "ven-westplace", name: "West Place", gl: "Occupancy - Rent", inv: 0 },
  // — universal-account services (valid on EVERY entity incl Admin/Nala) —
  { id: "ven-imaginal", name: "Imaginal", gl: "Marketing", inv: 0 },
  { id: "ven-salescomm", name: "Salescomm", gl: "Telephone", inv: 0 },
  { id: "ven-stamm", name: "Stamm Technologies", gl: "Computer & IT", inv: 0 },
  { id: "ven-globalsight", name: "Global Sight", gl: "Computer & IT", inv: 0 },
  { id: "ven-gordonflesch", name: "Gordon Flesch", gl: "Computer & IT", inv: 0 },
  { id: "ven-togo", name: "TOGO", gl: "Computer & IT", inv: 0 },
  { id: "ven-ukg", name: "UKG", gl: "Computer & IT", inv: 0 }, // HR/payroll SaaS — NOT Payroll-Wages
  { id: "ven-deltadental", name: "Delta Dental", gl: "Insurance - Health", inv: 0 },
  { id: "ven-ctcsupplies", name: "CTC Supplies", gl: "Supplies", inv: 0 }, // consumed, not resold → inventory OFF
  { id: "ven-cintas", name: "Cintas", gl: "Supplies", inv: 0 },
  // — professional / amenities / education / equipment (salon/school-only COA) —
  { id: "ven-csc", name: "CSC", gl: "Professional / Outside Services", inv: 0 },
  { id: "ven-colectivo", name: "Colectivo", gl: "Guest Relations", inv: 0 },
  { id: "ven-pivotpoint", name: "Pivot Point", gl: "Kit Costs", inv: 1 }, // Kit Costs valid IBW/Chicago only
  { id: "ven-wash", name: "WASH Multifamily Laundry", gl: "Equipment Lease", inv: 0 }, // token-safe name (not "WASH")
  // — §D reconciliation: Olive Garden = the RESTAURANT (staff refreshments), NOT
  //   inventory. Repurposes the former inventory seed (was Retail/Product, inv=1).
  { id: "ven-olivegarden", name: "Olive Garden", gl: "Guest Relations", inv: 0 },
];

// System-managed vendor aliases — confirmed OCR spelling variants that should
// canonicalize onto an existing vendor_mappings row so they inherit its GL
// coding (vendor canonicalization). `alias_norm` is computed with the SAME
// normalizeVendor() that findVendorMapping uses, so the deterministic exact-
// equality lookup is guaranteed to hit. The canonical_id must be a fixed-id
// system seed, so the FK target always exists.
//
// NOTE (§D reconciliation): the former "Olivia Garden" → ven-olivegarden alias
// was REMOVED. Olivia Garden is a distinct professional beauty-tools vendor with
// its OWN mapping row (ven-oliviagarden), NOT an OCR misspelling of the Olive
// Garden restaurant — so aliasing it onto the (now restaurant) Olive Garden row
// would mis-canonicalize it. The stale row that prior deploys already wrote is
// removed by an explicit DELETE in ensureSeedData (below).
const SEED_VENDOR_ALIASES: { id: string; alias: string; canonical_id: string }[] = [
  // add confirmed OCR variants here as they surface
];

let schemaEnsured = false;

/**
 * Runtime SCHEMA migration (v1.2.9, extended v1.6.0). Applies the additive DDL the
 * archive / audit-clear features (v1.2.8) need — the nullable `invoices.archived_at`
 * column, its index, and the `audit_clear_cutoffs` table — plus the v1.6.0 additive
 * invoice columns (`shipping`, `location_ambiguous`, `reconciliation_delta`), so the
 * database upgrades ITSELF on the first request after deploy, with NO manual
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
/**
 * Additive `ALTER TABLE ... ADD COLUMN` that tolerates the expected "duplicate
 * column" / "already exists" error (SQLite ADD COLUMN is not idempotent) and
 * reports any unexpected failure so the caller can bail WITHOUT latching (retried
 * next request). Returns true when the column is present (added or already
 * existed), false on an unexpected error.
 */
async function addColumnTolerant(
  env: Env,
  ddl: string,
  label: string,
): Promise<boolean> {
  try {
    await env.DB.prepare(ddl).run();
    return true;
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e);
    if (/duplicate column|already exists/i.test(msg)) return true;
    console.error(`[migrations] ${label} failed (will retry):`, e);
    return false;
  }
}

export async function ensureSchema(env: Env): Promise<void> {
  if (schemaEnsured) return;
  // 1) Additive invoice columns, each guarded by the same tolerant ALTER pattern:
  //    tolerate "duplicate column" when it already exists; bail (without latching)
  //    on anything unexpected so it's retried next request. archived_at (v1.2.8);
  //    shipping / location_ambiguous / reconciliation_delta (v1.6.0 — header
  //    shipping capture, location-ambiguity flag, reconciliation guard).
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN archived_at TEXT", "add archived_at"))) return;
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN shipping REAL", "add shipping"))) return;
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN location_ambiguous INTEGER NOT NULL DEFAULT 0", "add location_ambiguous"))) return;
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN reconciliation_delta REAL", "add reconciliation_delta"))) return;
  // v1.9.8 — register the manual review check: who accepted the flags ("these are
  // fine") and when. Persists an accountable record that a human manually reviewed
  // a flagged invoice before it was cleared for export.
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN manually_reviewed_at TEXT", "add manually_reviewed_at"))) return;
  if (!(await addColumnTolerant(env, "ALTER TABLE invoices ADD COLUMN manually_reviewed_by TEXT", "add manually_reviewed_by"))) return;
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
      // System-managed vendor → category mappings (category-only; entity / class /
      // approver stay NULL — routing decides those per invoice). Fixed-id INSERT
      // OR REPLACE, so admin-created rows (other ids) are never touched.
      ...SEED_MANAGED_VENDORS.map((v) =>
        env.DB.prepare(
          "INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES (?,?,?,?,?,?,?)",
        ).bind(v.id, v.name, null, null, null, v.inv, v.gl),
      ),
      // §D reconciliation cleanup: remove the stale v1.3.6 "Olivia Garden" alias.
      // Olivia Garden now has its own row (ven-oliviagarden); the alias would
      // wrongly canonicalize it onto the (now restaurant) Olive Garden row, and
      // findVendorMapping checks aliases FIRST. INSERT OR REPLACE can't delete a
      // row prior deploys wrote, so delete it explicitly. Idempotent (no-op when
      // absent). vendor_aliases is created by ensureSchema, which runs first.
      env.DB.prepare("DELETE FROM vendor_aliases WHERE id = ?").bind("alias-oliviagarden"),
      // Vendor aliases — upserted AFTER the vendor rows above so the canonical_id
      // FK target exists in the same batch. `alias_norm` uses the SAME
      // normalizeVendor() the matcher computes, guaranteeing the lookup hits.
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
