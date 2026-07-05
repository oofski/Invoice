import type { Env, VendorMappingRow } from "./types";
import {
  LOCATION_DICTIONARY,
  RULE2_LISA_VENDORS,
  RULE3_KARI_VENDORS,
  RULE4_LORI_VENDORS,
  RULE5_BONNIE_VENDORS,
  SUSAN_THRESHOLD,
  CAPITAL_EQUIPMENT_THRESHOLD,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
  CONFIDENCE_LEVEL,
  APPROVERS,
  VENDOR_CATEGORY,
  BONNIE_KEYWORDS,
  LISA_INVENTORY_KEYWORDS,
  isCategoryValidForEntity,
  type Approver,
  type BusinessEntity,
  type ClassName,
  type ConfidenceLevel,
  type ItemType,
} from "./constants";

/**
 * Deterministic routing + GL coding — replaces Claude Prompts 1, 2 and the bulk
 * of Prompt 3. All of this logic was already rule-based in the brief; here it
 * runs as code against the admin-editable `vendor_mappings` / `location_mappings`
 * tables (seeded from the same constants). Reducto's per-line `suggested_category`
 * fills the gap only when no deterministic rule fires.
 */

// --------------------------------------------------------------- vendor matching
export function normalizeVendor(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/\b(llc|inc|co|corp|ltd|company)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * True when one normalized name's token sequence is a contiguous subsequence of
 * the other's (FIX-3, v1.6.0). Both inputs are `normalizeVendor()` outputs
 * (space-separated tokens). Returns true iff every token of `b` appears, in
 * order and adjacent, inside `a` — so "fish" is NOT contained in "fisher
 * scientific" (token boundary), but "olive garden" is contained in "olive garden
 * llc" (which normalizes to "olive garden"). Empty `b` never matches.
 */
function tokenContains(a: string, b: string): boolean {
  const at = a.split(" ").filter(Boolean);
  const bt = b.split(" ").filter(Boolean);
  if (!bt.length || bt.length > at.length) return false;
  for (let i = 0; i + bt.length <= at.length; i++) {
    let ok = true;
    for (let j = 0; j < bt.length; j++) {
      if (at[i + j] !== bt[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function vendorInList(vendor: string, list: string[]): boolean {
  const n = normalizeVendor(vendor);
  if (!n) return false;
  return list.some((v) => {
    const nv = normalizeVendor(v);
    return Boolean(nv) && (tokenContains(n, nv) || tokenContains(nv, n));
  });
}

/**
 * L2 absolute vendor → category lookup (Categorization Hierarchy Level 2). Does a
 * normalized substring match of the invoice vendor against `VENDOR_CATEGORY`
 * keys. Returns the mapped category NAME or null. Entity-validity gating is the
 * caller's responsibility (codeLineItem only uses the result when valid for the
 * entity, otherwise it falls through).
 */
export function vendorCategory(vendor: string): string | null {
  const n = normalizeVendor(vendor);
  if (!n) return null;
  for (const [key, cat] of Object.entries(VENDOR_CATEGORY)) {
    const nv = normalizeVendor(key);
    if (nv && (tokenContains(n, nv) || tokenContains(nv, n))) return cat;
  }
  return null;
}

export async function loadVendorMappings(env: Env): Promise<VendorMappingRow[]> {
  // ORDER BY vendor_name gives the token-match fallback a deterministic priority
  // (first row on a length tie is alphabetically stable) — FIX-3, v1.6.0.
  const r = await env.DB.prepare(
    "SELECT * FROM vendor_mappings ORDER BY vendor_name",
  ).all<VendorMappingRow>();
  return r.results ?? [];
}

/** A normalized alias -> canonical vendor mapping id (vendor canonicalization). */
export interface VendorAliasLookup {
  alias_norm: string;
  canonical_id: string;
}

/**
 * Loads the deterministic vendor-alias lookup rows. Tolerant: if the
 * `vendor_aliases` table is absent (pre-migration isolate / fresh DB before
 * ensureSchema ran), returns [] rather than throwing — mirroring how
 * loadLocations falls back, so the matcher degrades to its existing behavior.
 */
export async function loadVendorAliases(env: Env): Promise<VendorAliasLookup[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT alias_norm, canonical_id FROM vendor_aliases",
    ).all<VendorAliasLookup>();
    return r.results ?? [];
  } catch {
    return [];
  }
}

export function findVendorMapping(
  vendor: string,
  rows: VendorMappingRow[],
  aliases?: VendorAliasLookup[],
): VendorMappingRow | null {
  const n = normalizeVendor(vendor);
  if (!n) return null;
  // 1) ALIAS RESOLUTION (deterministic, exact normalized equality) — runs first.
  //    A curated alias is a whole-name canonicalization, so we match by exact
  //    equality (NOT substring) to avoid re-introducing loose merges. On a hit,
  //    return the canonical vendor_mappings row.
  if (aliases?.length) {
    const hit = aliases.find((a) => a.alias_norm === n);
    if (hit) {
      const canon = rows.find((r) => r.id === hit.canonical_id);
      if (canon) return canon;
    }
  }
  // 2) TOKEN-BOUNDARY match (FIX-3, v1.6.0) — replaces the loose two-way substring
  //    test that let "FISH" match "Fisher Scientific". Deterministic priority:
  //    exact normalized equality wins outright; otherwise the longest matching
  //    vendor_name (most specific) wins; ties resolve to the first row (rows arrive
  //    ORDER BY vendor_name).
  let best: VendorMappingRow | null = null;
  let bestLen = -1;
  for (const r of rows) {
    const nv = normalizeVendor(r.vendor_name);
    if (!nv) continue;
    if (nv === n) return r; // exact normalized equality
    if (tokenContains(n, nv) || tokenContains(nv, n)) {
      if (nv.length > bestLen) {
        best = r;
        bestLen = nv.length;
      }
    }
  }
  return best;
}

// ------------------------------------------------------------- location matching
export interface LocationRow {
  address: string;
  keywords: string[];
  business: string;
  class: string;
  default_approver: string;
}

export async function loadLocations(env: Env): Promise<LocationRow[]> {
  // ORDER BY id makes the deterministic tie-break (first-in-locs-order) stable and
  // independent of physical row order (FIX-1/L2, v1.6.0).
  const r = await env.DB.prepare(
    "SELECT address, keywords, business, class, default_approver FROM location_mappings ORDER BY id",
  ).all<{
    address: string;
    keywords: string;
    business: string;
    class: string;
    default_approver: string;
  }>();
  const rows = (r.results ?? []).map((x) => ({ ...x, keywords: safeArray(x.keywords) }));
  if (rows.length) return rows;
  // Fallback to the seed constants if the table wasn't populated.
  return LOCATION_DICTIONARY.map((l) => ({
    address: l.address,
    keywords: [...l.keywords],
    business: l.business,
    class: l.class,
    default_approver: l.default_approver,
  }));
}

function safeArray(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Canonicalizes location text for matching (FIX-1/L5, v1.6.0). Applied to BOTH the
 * haystack and every keyword before `.includes()` so trivial formatting/OCR
 * variance can't drop a signal. Rules, in order:
 *   1. lowercase; replace `&` with ` and `;
 *   2. street-suffix long→short, word-bounded (lane→ln, street→st, avenue→ave,
 *      drive→dr, road→rd, boulevard→blvd, suite→ste, floor→fl, highway→hwy,
 *      court→ct, place→pl);
 *   3. replace every non-[a-z0-9] run with a single space; trim.
 */
const LOCATION_SUFFIXES: Record<string, string> = {
  lane: "ln",
  street: "st",
  avenue: "ave",
  drive: "dr",
  road: "rd",
  boulevard: "blvd",
  suite: "ste",
  floor: "fl",
  highway: "hwy",
  court: "ct",
  place: "pl",
};

export function normalizeLocationText(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(
      /\b(lane|street|avenue|drive|road|boulevard|suite|floor|highway|court|place)\b/g,
      (m) => LOCATION_SUFFIXES[m],
    )
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface LocationMatch {
  loc: LocationRow | null;
  /** true when the best evidence was a keyword shared by 2+ locations AND no unique keyword broke the tie */
  ambiguous: boolean;
  /** true when the winner matched at least one keyword unique to it */
  unique: boolean;
}

/**
 * Scored location matcher (FIX-1, v1.6.0). Unique keywords (present in exactly one
 * location's list) outrank keywords shared across locations, so two co-branded
 * campuses no longer collapse to a longest-shared-keyword tie broken by row order.
 * Ship-to is matched first; the full-text blob is a fallback only. Deterministic:
 * highest tier, then longest matched keyword, then first in `locs` order. Sets
 * `ambiguous` when the winner rested on shared-only evidence with a genuine tie
 * across different (business, class) pairs, and `unique` when it matched a
 * location-unique keyword. Admin rows are skipped in matching (unchanged).
 */
export function matchLocationScored(
  shipTo: string,
  fullText: string,
  locs: LocationRow[],
): LocationMatch {
  // 1) Keyword uniqueness over ALL loaded locations (data-driven; admin-added
  //    locations participate automatically). A normalized keyword present in
  //    exactly one location's list is UNIQUE, otherwise SHARED.
  const locCountByKw = new Map<string, number>();
  for (const l of locs) {
    const seen = new Set<string>();
    for (const k of l.keywords) {
      const nk = normalizeLocationText(k);
      if (!nk || seen.has(nk)) continue;
      seen.add(nk);
      locCountByKw.set(nk, (locCountByKw.get(nk) ?? 0) + 1);
    }
  }
  const isUnique = (nk: string): boolean => (locCountByKw.get(nk) ?? 0) === 1;

  type Scored = { loc: LocationRow; idx: number; tier: number; len: number };

  const scorePass = (text: string): Scored[] => {
    const hay = normalizeLocationText(text);
    if (!hay) return [];
    const out: Scored[] = [];
    locs.forEach((l, idx) => {
      if (l.business === "Admin") return; // Admin keywords are too generic to match on
      let tier = 0; // 2 = matched a UNIQUE keyword; 1 = matched only SHARED keywords
      let len = 0; // longest matched keyword length within that tier
      for (const k of l.keywords) {
        const nk = normalizeLocationText(k);
        if (!nk || !hay.includes(nk)) continue;
        const kwTier = isUnique(nk) ? 2 : 1;
        if (kwTier > tier) {
          tier = kwTier;
          len = nk.length;
        } else if (kwTier === tier && nk.length > len) {
          len = nk.length;
        }
      }
      if (tier > 0) out.push({ loc: l, idx, tier, len });
    });
    return out;
  };

  // 2) ship-to pass first; 3) full-text fallback only if ship-to matched nothing.
  let scored = scorePass(shipTo);
  if (!scored.length) scored = scorePass(fullText);
  if (!scored.length) return { loc: null, ambiguous: false, unique: false };

  // 4) winner: highest tier, then longest len, then first in `locs` order.
  let winner = scored[0];
  for (const s of scored) {
    if (
      s.tier > winner.tier ||
      (s.tier === winner.tier && s.len > winner.len) ||
      (s.tier === winner.tier && s.len === winner.len && s.idx < winner.idx)
    ) {
      winner = s;
    }
  }

  // 5) flags. unique = tier 2. ambiguous only when the winner rested on shared-only
  //    evidence AND ≥2 locations with different (business, class) tie on (tier, len).
  const unique = winner.tier === 2;
  let ambiguous = false;
  if (winner.tier === 1) {
    const tied = scored.filter(
      (s) => s.tier === winner.tier && s.len === winner.len,
    );
    const distinct = new Set(tied.map((s) => `${s.loc.business}|${s.loc.class}`));
    ambiguous = distinct.size >= 2;
  }
  return { loc: winner.loc, ambiguous, unique };
}

/**
 * @deprecated Use {@link matchLocationScored}. Thin backward-compat wrapper kept
 * so existing callers / harnesses compile — passes the same text as both the
 * ship-to and full-text arguments and returns only the matched location.
 */
export function matchLocation(text: string, locs: LocationRow[]): LocationRow | null {
  return matchLocationScored(text, text, locs).loc;
}

// --------------------------------------------------------------- approver routing
const KNOWN_RULE_VENDORS = [
  ...RULE2_LISA_VENDORS,
  ...RULE3_KARI_VENDORS,
  ...RULE4_LORI_VENDORS,
  ...RULE5_BONNIE_VENDORS,
];

/**
 * Personnel routing rules, in strict priority order (Group B v1.1.4, spec §4).
 * Susan stays on top; Bonnie is an org-wide safety net that overrides entity
 * rules; schools (IBW/Chicago) split between Lisa (inventory/supply) and Kari
 * (everything else); salons (Neroli/SKNBar) route to Lori; then the admin-
 * configured per-vendor default, falling back to Bonnie as the catch-all.
 */
export function routeApprover(opts: {
  business: BusinessEntity;
  vendor: string;
  vendorMapping: VendorMappingRow | null;
  total: number;
  descriptions: string[];
  /** Coded GL categories of this invoice's lines (any REQUIRES_MANUAL_REVIEW => Bonnie). */
  glCategories?: string[];
  /** accepted for API stability; NOT rule-bearing — do not rely on it for routing. */
  salesTaxPresent?: boolean;
  /** Σ amounts of lines coded "Equipment & Fixtures" — capital-aware senior routing (FIX-12, v1.6.0). */
  equipmentTotal?: number;
}): { approver: Approver; logic: string } {
  const { business, vendor, vendorMapping, total, descriptions, glCategories } =
    opts;

  // RULE 1 — high dollar (>=, so exactly $10k escalates), construction, OR a
  // capital-equipment total at/above the threshold => Susan (kept on top). FIX-12.
  const hasConstruction = descriptions.some((d) => /construction/i.test(d));
  if (
    total >= SUSAN_THRESHOLD ||
    hasConstruction ||
    (opts.equipmentTotal ?? 0) >= CAPITAL_EQUIPMENT_THRESHOLD
  )
    return { approver: "Susan", logic: "RULE 1" };

  // RULE 2 — Bonnie safety net (org-wide; overrides entity rules below):
  //   building/facility/renovation keywords, Bonnie vendors, any line that
  //   needs manual review, or the Admin/Nala (corporate) entities.
  const hasBonnieKeyword = descriptions.some((d) => BONNIE_KEYWORDS.test(d));
  const needsManualReview = glCategories?.includes(REQUIRES_MANUAL_REVIEW) ?? false;
  if (
    hasBonnieKeyword ||
    vendorInList(vendor, RULE5_BONNIE_VENDORS) ||
    needsManualReview ||
    business === "Admin" ||
    business === "Nala"
  )
    return { approver: "Bonnie", logic: "RULE 2" };

  const isIbwChicago = business === "IBW" || business === "Chicago";

  // RULE 3 — Schools (IBW/Chicago): Lisa for inventory/supply, else Kari.
  if (isIbwChicago) {
    const isLisa =
      vendorInList(vendor, RULE2_LISA_VENDORS) ||
      Boolean(vendorMapping?.is_inventory) ||
      descriptions.some((d) => LISA_INVENTORY_KEYWORDS.test(d));
    if (isLisa) return { approver: "Lisa", logic: "RULE 3 LISA" };
    // Kari covers RULE3_KARI_VENDORS, wonky/recurring items, or unknown vendor.
    return { approver: "Kari", logic: "RULE 3 KARI" };
  }

  // RULE 4 — Salons (Neroli/SKNBar): Lori. (Major building expenses already
  // siphoned to Bonnie in RULE 2.)
  if (business === "Neroli" || business === "SKNBar")
    return { approver: "Lori", logic: "RULE 4" };

  // RULE 5 — admin-configured per-vendor default (if a valid approver), else
  // Bonnie as the org-wide catch-all.
  const vm = vendorMapping?.default_approver;
  if (vm && (APPROVERS as readonly string[]).includes(vm))
    return { approver: vm as Approver, logic: "RULE 5 VENDOR MAP" };
  return { approver: "Bonnie", logic: "RULE 5 CATCH-ALL" };
}

// ------------------------------------------------------- GL account resolution
/**
 * Resolves the GL account to use for an invoice/allocation/line, in priority:
 *   1. vendor mapping's gl_override (if a valid GL category)
 *   2. vendor mapping flagged as inventory -> "Retail / Product Costs"
 *   3. the supplied line GL category (if a valid GL category)
 *   4. otherwise REQUIRES_MANUAL_REVIEW
 */
export function resolveGlAccount(
  vendorMapping: VendorMappingRow | null | undefined,
  lineGlCategory?: string | null,
): string {
  const ov = vendorMapping?.gl_override;
  if (ov && GL_CATEGORIES_FLAT.includes(ov)) return ov;
  if (vendorMapping?.is_inventory) return "Retail / Product Costs";
  if (lineGlCategory && GL_CATEGORIES_FLAT.includes(lineGlCategory))
    return lineGlCategory;
  return REQUIRES_MANUAL_REVIEW;
}

// ------------------------------------------------------------------- GL coding

/**
 * Utility / municipal-service / occupancy-fee expense lines (v1.2.6). Qualifier-
 * gated: bare "water"/"charge"/"fee"/"service" NEVER match alone — each needs a
 * utility-specific neighbor — so real products ("Micellar Water", "Cucumber Water
 * Spray", "Cleansing Milk", "Hand Sanitizer Gel", "Water-based serum") are NOT
 * caught. Used to (a) exclude these from the salon product default and (b) drive
 * the L3 "Utilities" keyword category. Single source of truth for both.
 */
const UTILITY_EXPENSE_RE =
  /\b(water\s*(volume|service|usage|consumption|meter|base|readiness|distribution|charge)|sewer\w*|sewage|storm\s*water|septic|utilit\w*|electric\w*|natural\s*gas|energy\s*(charge|fee)|power\s*(charge|usage)|kwh|therm|waste\s*(water|management|disposal|collection)|\btrash\b|\bgarbage\b|\brefuse\b|recycl\w*|public\s*fire|fire\s*(fee|protection|line|service)|assessment|readiness\s*to\s*serve)/i;

/**
 * Service / repair / labor / trade lines (v1.2.6). A salon line describing a
 * repair, installation, plumbing/electrical/HVAC trade, inspection, or labor is
 * NOT a product and NOT backbar — it is Repairs & Maintenance. Word-bounded; NO
 * bare "service" (so "Shampoo Service Pack" / a "Service" product stay product;
 * "service call" requires the second word). Single source of truth for both the
 * salon product-default carve-out and the L3 "Repairs & Maintenance" category.
 */
const SERVICE_REPAIR_RE =
  /\b(repair\w*|replac\w*|reinstall\w*|install\w*|\blabor\b|service\s*call|diverter|cartridge|plumb\w*|\bleak\w*|fixture|faucet|valve|\bhvac\b|electrical\s*work|handy\s*man|handyman|maintenance|inspection|troubleshoot\w*|caulk\w*|grout|drywall|technician)\b/i;

/** Durable-goods / fixtures / furniture lines → "Equipment & Fixtures" (L2.4, v1.6.0). Word-bounded. */
const EQUIPMENT_RE =
  /\b(locker(s)?|fixture(s)?|furniture|equipment|chair(s)?|stool(s)?|station(s)?|workstation(s)?|cabinet(s|ry)?|casework|shelving|shelf|shelves|desk(s)?)\b/i;
/** Guard: repair/labor context wins over the equipment noun (a "fixture replacement labor" line is R&M). */
const EQUIPMENT_REPAIR_GUARD_RE =
  /\b(repair\w*|replac\w*|reinstall\w*|labor|service\s*call|leak\w*|maintenance|inspection|troubleshoot\w*)\b/i;

/** Freight / shipping / carrier lines (v1.2.7) → Freight. Word-bounded carriers. */
const FREIGHT_RE = /\b(freight|shipping|postage|courier|parcel|fedex|ups|usps|dhl)\b/i;

/**
 * Tariff / duty / customs / surcharge / generic-fee lines (v1.2.7) → "Penalties &
 * Fees" (the user's "fees" bucket). The fee terms were moved OUT of
 * UTILITY_EXPENSE_RE so a tariff/fuel/late surcharge is a fee, not a utility.
 */
const FEE_RE =
  /(\btariff\b|\bcustoms\b|import\s*dut(y|ies)|\bdut(y|ies)\b|sur\s?charge|\blate\s*fee\b|finance\s*charge|franchise\s*fee|connection\s*fee)/i;

/**
 * Product GL categories whose retail-vs-backbar choice is owned by the TAX split
 * (L2.5), NOT by a Reducto suggestion (FIX-5, v1.6.0). A Reducto suggestion for
 * one of these falls through to L2.5 so tax remains the primary rule; any other
 * (non-product) Reducto suggestion outranks the L2.5 default.
 */
const PRODUCT_CATEGORIES = new Set(["Retail / Product Costs", "Service Costs"]);

/**
 * The non-product EXPENSE category for a line by its description, or null — using
 * the product-safe regexes above (qualifier/word-bounded; NOT the loose /clean/,
 * which would catch "Cleansing Milk"). SINGLE SOURCE OF TRUTH (v1.2.7): used by the
 * salon product-default carve-out, the inventory-vendor branch, AND L3
 * keywordCategory, so every coding path recognizes the same non-product line types
 * consistently — closing the gap where an inventory vendor blanket-coded freight /
 * utility / repair / fee lines as product.
 */
function expenseCategory(desc: string): string | null {
  if (UTILITY_EXPENSE_RE.test(desc)) return "Utilities";
  if (SERVICE_REPAIR_RE.test(desc)) return "Repairs & Maintenance";
  if (FREIGHT_RE.test(desc)) return "Freight";
  if (FEE_RE.test(desc)) return "Penalties & Fees";
  return null;
}

/** Tax-line helpers (v1.2.6): a jurisdiction word + a percentage => a tax line. */
const JURISDICTION_RE = /\b(city|county|state|village|town|township|municipal|parish|borough)\b/i;
const PERCENT_RE = /\d+(?:\.\d+)?\s*%/;

/** The brief's LEVEL 3 keyword rules (kept deliberately small/safe, ≥90% sure). */
function keywordCategory(desc: string): string | null {
  // Non-product expense lines (utilities / repairs / freight / fees) first — so they
  // win over the generic /clean/ rule below and never fall to the entity default.
  const e = expenseCategory(desc);
  if (e) return e;
  if (/\btuition\b/.test(desc)) return "Tuition Revenue";
  if (/\bconsultant\b/.test(desc)) return "Professional / Outside Services";
  if (/clean/.test(desc)) return "Repairs & Maintenance";
  if (/\brent\b/.test(desc)) return "Occupancy - Rent";
  if (/software|\bit\b|computer|subscription|saas|license/.test(desc)) return "Computer & IT";
  return null;
}

/**
 * True when a tax-isolation L1 match should fire (broadened, but not "taxable"/
 * "tax-exempt"). v1.2.6: also catches a jurisdiction/percentage tax line written
 * without the word "tax" (e.g. "Milwaukee City (7.9%)") — a percent sign AND
 * either a jurisdiction word OR a line amount equal to the invoice's header tax.
 */
function isTaxLine(
  desc: string,
  opts?: { lineAmount?: number | null; headerTax?: number | null },
): boolean {
  // Never treat "taxable" / "tax-exempt" / "non-taxable" as a tax line.
  if (/\btax(able|[- ]?exempt)\b/.test(desc) || /non[- ]?tax/.test(desc)) return false;
  // sales/use/state tax, "tax code", or a standalone tax line.
  if (/(sales|use|state)\s*tax/.test(desc)) return true;
  if (/tax\s*code/.test(desc)) return true;
  if (/^\s*tax\s*$/.test(desc)) return true;
  // A percentage line that is jurisdiction-labeled OR whose amount equals the
  // invoice's header sales tax (within a cent) is a tax line. Low false-positive:
  // a bare percent with no jurisdiction and amount != header tax does NOT match
  // (so "10% off" / "20% Glycolic Peel" are never mis-flagged).
  if (PERCENT_RE.test(desc)) {
    if (JURISDICTION_RE.test(desc)) return true;
    const amt = opts?.lineAmount;
    const ht = opts?.headerTax;
    if (amt != null && ht != null && ht > 0 && Math.abs(amt - ht) <= 0.01) return true;
  }
  return false;
}


/**
 * Conservative non-product denylist for the SALON broad default (FIX 1, v1.2.0).
 * A salon (Neroli/SKNBar) line that doesn't look like a service / fee / occupancy
 * line is treated as a product. The denylist is biased toward product: a false
 * "product" merely yields the desired Retail/Backbar L2.5 default (still LOW /
 * reviewable), while a false "non-product" would mis-route a real good. Word-
 * boundary care: "cleaning" (the service) NOT bare "clean" (so "Cleansing Milk" /
 * "Cleanser" stay product); NO bare "tax" (L1 isolates tax; bare "tax" would catch
 * "taxable").
 */
const NON_PRODUCT_RE =
  /\b(rent|lease|freight|shipping|postage|courier|delivery|consult\w*|professional service|outside service|labor|install\w*|repair|maintenance|cleaning|janitor|software|subscription|saas|licen[sc]e|utilit\w*|electric\w*|telephone|phone|internet|insurance|payroll|wage|salary|interest|bank fee|processing fee|accounting|legal|tuition|education|training|marketing|advertis\w*|depreciat\w*|amortiz\w*|donation|membership|dues|occupancy|property tax|cam\b)/i;

/**
 * High-signal product allowlist (any entity). Tightened v1.6.0 (FIX-4): the bare
 * attribute words `color, spray, oz, ml, case, unit, kit, treatment` were removed
 * because they describe non-products too ("COLOR 949 JET BLACK", "TOUCH-UP SPRAY
 * PAINT", "Installation Kit", "WASTEWATER TREATMENT") and were forcing durable /
 * expense lines into the retail/backbar split.
 */
const PRODUCT_ALLOW_RE =
  /\b(product|retail|backbar|shampoo|conditioner|aveda|sku|bottle|jar|polish|lacquer|serum|cream|lotion|gel|mask|wax)\b/i;

/**
 * True when a line looks product-like (drives the L2.5 retail/backbar split).
 *  - vendor mapping flagged inventory => always product.
 *  - narrow high-signal allowlist (any entity) => product (no behavior change for
 *    non-salon entities).
 *  - SALON (Neroli/SKNBar) broad default: NOT clearly a service/fee/occupancy line
 *    (i.e. NOT NON_PRODUCT_RE) => product. Bias toward product (FIX 1, v1.2.0).
 *  - Other entities (IBW/Chicago/Admin/Nala): allowlist only — unchanged.
 */
function isProductLike(
  desc: string,
  vendorMapping: VendorMappingRow | null,
  business: BusinessEntity,
): boolean {
  if (vendorMapping?.is_inventory) return true;
  if (PRODUCT_ALLOW_RE.test(desc)) return true;
  if (business === "Neroli" || business === "SKNBar") {
    // A recognized non-product expense (utility / repair / freight / fee) is NEVER
    // a product, in either tax direction — it gets its own L3 category, not the
    // retail/backbar split (v1.2.6, broadened v1.2.7 to freight + fees).
    if (expenseCategory(desc)) return false;
    return !NON_PRODUCT_RE.test(desc);
  }
  return false;
}

/**
 * SOFT, product-overlapping keyword terms (v1.6.0 FIX-5 guard). These words appear
 * INSIDE legitimate salon PRODUCT names — "Bond REPAIR Treatment", "REPAIR Serum",
 * "REPAIRing Mask", "CLEANSing Milk", "CLEANSER", "Facial CLEANSER" — so ON THEIR
 * OWN they are too weak to pull a product line into R&M. The service form "cleaning"
 * (office cleaning) is deliberately EXCLUDED (only "cleans*" / bare "clean"), as are
 * the trade/install terms — those remain strong non-product signals coded via L3.
 */
const SOFT_KEYWORD_RE = /\b(repair\w*|cleans\w*|clean)\b/i;

/**
 * STRONG (non-soft) trade/expense terms — SERVICE_REPAIR_RE minus the bare "repair"
 * family — and the NON_PRODUCT denylist minus "repair". A salon line carrying ANY of
 * these is a GENUINE expense (faucet / leak / labor / install / plumbing / utilities
 * / freight / fees / rent / cleaning / …), so a co-occurring soft keyword must NOT
 * reclassify it as a product. Kept in sync with SERVICE_REPAIR_RE / NON_PRODUCT_RE
 * (only the bare "repair" alternative is dropped).
 */
const STRONG_SERVICE_REPAIR_RE =
  /\b(replac\w*|reinstall\w*|install\w*|\blabor\b|service\s*call|diverter|cartridge|plumb\w*|\bleak\w*|fixture|faucet|valve|\bhvac\b|electrical\s*work|handy\s*man|handyman|maintenance|inspection|troubleshoot\w*|caulk\w*|grout|drywall|technician)\b/i;
const STRONG_NON_PRODUCT_RE =
  /\b(rent|lease|freight|shipping|postage|courier|delivery|consult\w*|professional service|outside service|labor|install\w*|maintenance|cleaning|janitor|software|subscription|saas|licen[sc]e|utilit\w*|electric\w*|telephone|phone|internet|insurance|payroll|wage|salary|interest|bank fee|processing fee|accounting|legal|tuition|education|training|marketing|advertis\w*|depreciat\w*|amortiz\w*|donation|membership|dues|occupancy|property tax|cam\b)/i;

/** True when `desc` carries a STRONG (non-soft) expense / non-product signal. */
function hasStrongNonProductSignal(desc: string): boolean {
  return (
    UTILITY_EXPENSE_RE.test(desc) ||
    STRONG_SERVICE_REPAIR_RE.test(desc) ||
    FREIGHT_RE.test(desc) ||
    FEE_RE.test(desc) ||
    STRONG_NON_PRODUCT_RE.test(desc)
  );
}

/**
 * FIX-5 regression guard (v1.6.0). True when a line matches a SOFT product-overlapping
 * keyword AND is product-like, so the L3 keyword branch must DEFER to the L2.5 product
 * tax split rather than mis-coding a product to R&M/Utilities. Product-like =
 *   - carries a kept product word (PRODUCT_ALLOW_RE, any entity), OR
 *   - belongs to a salon/spa product-defaulting entity (Neroli/SKNBar) AND shows NO
 *     strong (non-soft) expense/non-product signal — i.e. it would otherwise reach the
 *     salon broad product default.
 * Such lines then code exactly as they did in v1.5.0 (Retail / Product Costs LOW when
 * untaxed, Service Costs LOW when taxed). Strong keyword rules (utilities, freight,
 * fees, real trade repairs, install, rent, software, tuition, consultant) and genuine
 * non-product lines are untouched; non-salon entities keep allowlist-only behavior.
 */
function softKeywordShouldDeferToProduct(
  desc: string,
  business: BusinessEntity,
): boolean {
  if (!SOFT_KEYWORD_RE.test(desc)) return false;
  if (PRODUCT_ALLOW_RE.test(desc)) return true;
  if (business === "Neroli" || business === "SKNBar")
    return !hasStrongNonProductSignal(desc);
  return false;
}

/**
 * Ordered GL categorization hierarchy (Group B v1.1.4, reordered v1.6.0 FIX-5):
 *   L0 discount -> L1 tax isolation -> L2 absolute vendor match + vendor mapping
 *   -> L2.4 equipment -> L3 keywords -> Reducto suggestion
 *   -> L2.5 retail vs backbar (conservative, LOW) -> L4 entity default
 *   -> L5 manual review. Evidence (keyword/model) now outranks the L2.5 product
 *   default; a product-category Reducto suggestion still defers to the tax split.
 *
 * EVERY concrete-category return is entity-gated via `isCategoryValidForEntity`:
 * if a level's category isn't in this entity's COA (canonical or legacy) the
 * level is skipped and we fall through, ultimately to L5 manual review. This
 * guarantees a coded line always exports with a real account number for its
 * entity (e.g. a Nala/Admin "state tax"/"rent"/"tuition" line has no such admin
 * account, so it routes to manual review rather than a bare unmapped name).
 */
export function codeLineItem(opts: {
  description: string;
  vendor: string;
  vendorMapping: VendorMappingRow | null;
  business: BusinessEntity;
  suggestedCategory?: string;
  salesTaxPresent: boolean;
  /** Per-line tax amount when itemized; null/undefined => fall back to header tax. */
  lineTax?: number | null;
  /** Line amount (signed). A negative amount is a discount/credit (v1.1.8 L0). */
  amount?: number | null;
  /** Invoice header sales tax — lets L1 recognize a jurisdiction/% tax line (v1.2.6). */
  headerTax?: number | null;
}): { category: string; confidence: ConfidenceLevel; logic: string; itemType?: ItemType } {
  const desc = (opts.description || "").toLowerCase();
  const { business, vendor, vendorMapping, salesTaxPresent, lineTax, amount, headerTax } = opts;

  type Coded = { category: string; confidence: ConfidenceLevel; logic: string; itemType?: ItemType };
  // Returns a concrete-category result ONLY if it is valid for this entity's COA
  // (canonical or legacy); otherwise null so the caller falls through to the next
  // level — never code a line to a category the entity can't export with a number.
  // `itemType` (v1.1.8 N) is set only by the L2.5 default-tax branches so the
  // auto-tagged Retail/Backbar Type persists (drives per-line export tax + exec split).
  const gated = (
    category: string,
    confidence: ConfidenceLevel,
    logic: string,
    itemType?: ItemType,
  ): Coded | null =>
    isCategoryValidForEntity(business, category)
      ? { category, confidence, logic, ...(itemType ? { itemType } : {}) }
      : null;

  // Tax-based retail/backbar split — THE primary product-coding rule. The presence
  // of sales tax decides retail vs backbar for a PRODUCT line: untaxed => "Retail /
  // Product Costs" (5100, retail / resale-exempt, item_type Retail); taxed =>
  // "Service Costs" (5000, backbar consumed in services, item_type Backbar). A
  // per-line tax amount (lineTax) takes priority over the header signal. Returns
  // null when neither signal resolves or the category is invalid for the entity
  // (so the caller falls through). Used by BOTH the known-vendor L2 path (HIGH) and
  // the unknown-vendor L2.5 default (LOW).
  const taxAbsent = lineTax != null ? lineTax === 0 : !salesTaxPresent;
  const taxPresent = lineTax != null ? lineTax > 0 : salesTaxPresent;
  const taxSplit = (confidence: ConfidenceLevel, tag: string): Coded | null => {
    if (taxPresent) return gated("Service Costs", confidence, `${tag} BACKBAR`, "Backbar");
    if (taxAbsent) return gated("Retail / Product Costs", confidence, `${tag} RETAIL`, "Retail");
    return null;
  };

  // L0 — discount isolation (v1.1.8). A negative-amount line is a discount /
  // credit. For school entities whose COA carries "Discounts" (IBW, Chicago)
  // code it to that tracked account (HIGH). For entities WITHOUT a Discounts
  // account, gated() returns null and we fall through — the pipeline post-pass
  // nets the discount into the invoice's dominant positive line's GL.
  if (amount != null && amount < 0) {
    const r = gated("Discounts", CONFIDENCE_LEVEL.HIGH, "LEVEL 0 DISCOUNT");
    if (r) return r;
  }

  // L1 — tax isolation (absolute, never overridden) — but only if valid for entity.
  if (isTaxLine(desc, { lineAmount: amount, headerTax })) {
    const r = gated("Sales/Use Tax", CONFIDENCE_LEVEL.HIGH, "LEVEL 1");
    if (r) return r;
  }

  // L2 — absolute vendor → category match (entity-gated). If the mapped category
  // is not valid for this entity, fall through rather than force an invalid one.
  const vCat = vendorCategory(vendor);
  if (vCat && isCategoryValidForEntity(business, vCat))
    return { category: vCat, confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2 VENDOR" };

  // L2 — admin vendor mapping. An explicit gl_override to a NON-product category
  // (Freight, Computer & IT, …) is an absolute override and wins as-is. But a
  // vendor flagged as inventory — OR overridden to a PRODUCT category (Retail /
  // Product Costs or Service Costs) — only tells us "this is a product line"; the
  // retail-vs-backbar choice is then made by TAX (the primary rule above), NOT
  // forced to Retail. (Fix: is_inventory previously forced Retail HIGH and ignored
  // sales tax, so a taxed supplies invoice — e.g. CTC Supplies with $18.54 tax —
  // wrongly coded to 5100 Retail instead of 5000 Service Costs / backbar.)
  if (vendorMapping) {
    const ov = vendorMapping.gl_override;
    const ovIsProduct =
      ov === "Retail / Product Costs" || ov === "Service Costs";
    if (ov && GL_CATEGORIES_FLAT.includes(ov) && !ovIsProduct)
      return { category: ov, confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2" };
    if (ovIsProduct || vendorMapping.is_inventory) {
      // v1.2.7 ROOT-CAUSE FIX: a product vendor still bills NON-product lines —
      // freight, tariffs/fees, utilities, repairs. Previously this branch ran the
      // tax split on EVERY line (inspecting only tax, never the description) and
      // returned BEFORE any line-level recognition, so e.g. a Pivot Point invoice
      // coded shipping + tariff to Retail at HIGH confidence. Now: read the line
      // first — a clear product (allowlist) takes the tax split; a recognized
      // expense (utility/repair/freight/fee) gets its real category; only an
      // unrecognized line falls to the product tax split.
      if (!PRODUCT_ALLOW_RE.test(desc)) {
        // Equipment carve-out (v1.6.0): an inventory vendor's locker/fixture line
        // must not blanket-code to product. Entity-gated (Nala/Admin fall through).
        if (EQUIPMENT_RE.test(desc) && !EQUIPMENT_REPAIR_GUARD_RE.test(desc)) {
          const r = gated(
            "Equipment & Fixtures",
            CONFIDENCE_LEVEL.MEDIUM,
            "LEVEL 2 EQUIPMENT",
            "Equipment",
          );
          if (r) return r;
        }
        const e = expenseCategory(desc);
        if (e) {
          const r = gated(e, CONFIDENCE_LEVEL.MEDIUM, "LEVEL 2 EXPENSE");
          if (r) return r;
        }
      }
      // Genuine product (or unrecognized line) → tax decides retail vs backbar.
      const r = taxSplit(CONFIDENCE_LEVEL.HIGH, "LEVEL 2 TAX");
      if (r) return r;
    }
  }

  // L2.4 — durable goods / fixtures / furniture (v1.6.0). Placed after the vendor-
  // mapping L2 block and before every heuristic. Entity-gated: Nala/Admin have no
  // Equipment & Fixtures account and fall through.
  if (EQUIPMENT_RE.test(desc) && !EQUIPMENT_REPAIR_GUARD_RE.test(desc)) {
    const r = gated(
      "Equipment & Fixtures",
      CONFIDENCE_LEVEL.MEDIUM,
      "L2.4 EQUIPMENT",
      "Equipment",
    );
    if (r) return r;
  }

  // L3 — keyword rules (≥90% confident). Runs BEFORE the L2.5 product default
  // (FIX-5, v1.6.0) so hard keyword evidence outranks the generic tax-split guess.
  // GUARD (v1.6.0 hotfix): a SOFT product-overlapping keyword (/clean/, /repair/) must
  // NOT preempt L2.5 for a product-like line — a salon "Cleansing Milk" / "Repair
  // Serum" / "Bond Repair Treatment" is a product, not R&M. Those lines fall through
  // to L2.5 and code as they did in v1.5.0. Strong keyword rules (utilities, freight,
  // fees, real trade repairs, install) and non-product lines still code via L3.
  const kw = keywordCategory(desc);
  if (kw && !softKeywordShouldDeferToProduct(desc, business)) {
    const r = gated(kw, CONFIDENCE_LEVEL.MEDIUM, "LEVEL 3");
    if (r) return r;
  }

  // Reducto's suggestion (entity-gated). Runs BEFORE L2.5 (FIX-5) so a correct
  // model read (e.g. Equipment & Fixtures) is reachable — BUT a PRODUCT-category
  // suggestion (Retail / Product Costs or Service Costs) falls through to L2.5 so
  // the TAX split stays the retail-vs-backbar authority.
  const sugg = opts.suggestedCategory;
  if (
    sugg &&
    sugg !== REQUIRES_MANUAL_REVIEW &&
    !PRODUCT_CATEGORIES.has(sugg) &&
    isCategoryValidForEntity(business, sugg)
  )
    return { category: sugg, confidence: CONFIDENCE_LEVEL.MEDIUM, logic: "REDUCTO" };

  // L2.5 — DEFAULT tax-based coding for an UNKNOWN-vendor product-like line. Now
  // runs AFTER keyword + Reducto evidence (FIX-5). Same tax split as the known-
  // vendor path above, but LOW confidence (heuristic) so it's flagged/reviewable.
  // item_type Retail/Backbar is tagged so the export tax recompute + exec split
  // Type follow. Explicit per-line Type and manual edits run later and still win.
  // Entity-gated — falls through when invalid for entity.
  // The soft-keyword guard also ADMITS product lines whose only non-product signal is
  // a bare soft keyword (e.g. "Bond Repair Treatment" — no kept allowlist word after
  // FIX-4 removed "treatment") to the salon broad product default, so they code as
  // v1.5.0 did instead of falling to the L4 entity default.
  if (
    isProductLike(desc, vendorMapping, business) ||
    softKeywordShouldDeferToProduct(desc, business)
  ) {
    const r = taxSplit(CONFIDENCE_LEVEL.LOW, "L2.5");
    if (r) return r;
  }

  // L4 — entity default (concrete, LOW confidence — not forced to manual review).
  // Gated for safety/consistency: the entity defaults below are all valid for
  // their entity, so gating doesn't change them, but the professional-services /
  // contractor branch can fire for any entity and must be entity-checked.
  if (/professional services|contractor/.test(desc)) {
    const r = gated("Professional / Outside Services", CONFIDENCE_LEVEL.LOW, "LEVEL 4");
    if (r) return r;
  }
  if (business === "SKNBar") {
    const r = gated("Service Costs", CONFIDENCE_LEVEL.LOW, "LEVEL 4");
    if (r) return r;
  }
  if (business === "IBW" || business === "Chicago") {
    const r = gated("Student Expenses", CONFIDENCE_LEVEL.LOW, "LEVEL 4");
    if (r) return r;
  }
  if (business === "Neroli") {
    const r = gated("Repairs & Maintenance", CONFIDENCE_LEVEL.LOW, "LEVEL 4");
    if (r) return r;
  }

  // L5 — manual review.
  return { category: REQUIRES_MANUAL_REVIEW, confidence: CONFIDENCE_LEVEL.MANUAL_REVIEW, logic: "LEVEL 5" };
}
