import type { Env } from "./types";

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
    ];
    await env.DB.batch(stmts);
    ensured = true;
  } catch (e) {
    // Never break a request on a seed failure — log and retry next request.
    console.error("[migrations] ensureSeedData failed (will retry):", e);
  }
}
