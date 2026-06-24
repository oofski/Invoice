import type { Env, VendorMappingRow } from "./types";
import {
  LOCATION_DICTIONARY,
  RULE2_LISA_VENDORS,
  RULE3_KARI_VENDORS,
  RULE4_LORI_VENDORS,
  RULE5_BONNIE_VENDORS,
  SUSAN_THRESHOLD,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
  CONFIDENCE_LEVEL,
  APPROVERS,
  VENDOR_CATEGORY,
  BONNIE_KEYWORDS,
  LISA_INVENTORY_KEYWORDS,
  KARI_WONKY_KEYWORDS,
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

function vendorInList(vendor: string, list: string[]): boolean {
  const n = normalizeVendor(vendor);
  if (!n) return false;
  return list.some((v) => {
    const nv = normalizeVendor(v);
    return nv && (n.includes(nv) || nv.includes(n));
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
    if (nv && (n.includes(nv) || nv.includes(n))) return cat;
  }
  return null;
}

export async function loadVendorMappings(env: Env): Promise<VendorMappingRow[]> {
  const r = await env.DB.prepare("SELECT * FROM vendor_mappings").all<VendorMappingRow>();
  return r.results ?? [];
}

export function findVendorMapping(
  vendor: string,
  rows: VendorMappingRow[],
): VendorMappingRow | null {
  const n = normalizeVendor(vendor);
  if (!n) return null;
  return (
    rows.find((r) => {
      const nv = normalizeVendor(r.vendor_name);
      return nv && (n.includes(nv) || nv.includes(n));
    }) ?? null
  );
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
  const r = await env.DB.prepare(
    "SELECT address, keywords, business, class, default_approver FROM location_mappings",
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
 * Matches the MOST-SPECIFIC non-Admin location: the one carrying the LONGEST
 * keyword that appears in the text (FIX 5b, v1.2.0). Longest-match wins so a
 * shared street address can't shadow a more specific signal — e.g. IBW's
 * "327 E St Paul 5th Floor" and "Institute of Beauty & Wellness" beat Neroli's
 * generic "327 E St Paul" / "Downtown", fixing the IBW-vs-Neroli collision at the
 * shared building. Tie on length keeps array order. Admin (generic keywords) is
 * still skipped. Case-insensitive substring match as before.
 */
export function matchLocation(text: string, locs: LocationRow[]): LocationRow | null {
  const hay = (text || "").toLowerCase();
  if (!hay) return null;
  let best: LocationRow | null = null;
  let bestLen = -1;
  for (const l of locs) {
    if (l.business === "Admin") continue; // Admin keywords ("Admin","Corporate") are too generic to match on
    for (const k of l.keywords) {
      if (!k) continue;
      if (hay.includes(k.toLowerCase()) && k.length > bestLen) {
        best = l;
        bestLen = k.length;
      }
    }
  }
  return best;
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
  /** Whether header-level sales tax is present (reserved; not yet rule-bearing). */
  salesTaxPresent?: boolean;
}): { approver: Approver; logic: string } {
  const { business, vendor, vendorMapping, total, descriptions, glCategories } =
    opts;

  // RULE 1 — high dollar or construction => Susan (kept on top)
  const hasConstruction = descriptions.some((d) => /construction/i.test(d));
  if (total > SUSAN_THRESHOLD || hasConstruction)
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
/** The brief's LEVEL 3 keyword rules (kept deliberately small/safe, ≥90% sure). */
function keywordCategory(desc: string): string | null {
  if (/\btuition\b/.test(desc)) return "Tuition Revenue";
  if (/\bconsultant\b/.test(desc)) return "Professional / Outside Services";
  if (/clean/.test(desc)) return "Repairs & Maintenance";
  if (/\brent\b/.test(desc)) return "Occupancy - Rent";
  if (/freight|shipping/.test(desc)) return "Freight";
  if (/software|\bit\b|computer|subscription|saas|license/.test(desc)) return "Computer & IT";
  return null;
}

/** True when a tax-isolation L1 match should fire (broadened, but not "taxable"/"tax-exempt"). */
function isTaxLine(desc: string): boolean {
  // Never treat "taxable" / "tax-exempt" / "non-taxable" as a tax line.
  if (/\btax(able|[- ]?exempt)\b/.test(desc) || /non[- ]?tax/.test(desc)) return false;
  // sales/use/state tax, "tax code", or a standalone tax line.
  if (/(sales|use|state)\s*tax/.test(desc)) return true;
  if (/tax\s*code/.test(desc)) return true;
  if (/^\s*tax\s*$/.test(desc)) return true;
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

/** High-signal product allowlist (any entity). Broadened a bit; harmless. */
const PRODUCT_ALLOW_RE =
  /\b(product|retail|backbar|shampoo|conditioner|color|aveda|sku|case|unit|bottle|jar|polish|lacquer|serum|cream|lotion|gel|mask|treatment|kit|wax|spray|oz|ml)\b/i;

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
    return !NON_PRODUCT_RE.test(desc);
  }
  return false;
}

/**
 * Ordered GL categorization hierarchy (Group B v1.1.4, spec §5):
 *   L1 tax isolation -> L2 absolute vendor match + vendor mapping
 *   -> L2.5 retail vs backbar (conservative) -> L3 keywords -> Reducto suggestion
 *   -> L4 entity default -> L5 manual review.
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
}): { category: string; confidence: ConfidenceLevel; logic: string; itemType?: ItemType } {
  const desc = (opts.description || "").toLowerCase();
  const { business, vendor, vendorMapping, salesTaxPresent, lineTax, amount } = opts;

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
  if (isTaxLine(desc)) {
    const r = gated("Sales/Use Tax", CONFIDENCE_LEVEL.HIGH, "LEVEL 1");
    if (r) return r;
  }

  // L2 — absolute vendor → category match (entity-gated). If the mapped category
  // is not valid for this entity, fall through rather than force an invalid one.
  const vCat = vendorCategory(vendor);
  if (vCat && isCategoryValidForEntity(business, vCat))
    return { category: vCat, confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2 VENDOR" };

  // L2 — admin vendor mapping (gl_override / inventory).
  if (vendorMapping) {
    const ov = vendorMapping.gl_override;
    if (ov && GL_CATEGORIES_FLAT.includes(ov))
      return { category: ov, confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2" };
    if (vendorMapping.is_inventory)
      return { category: "Retail / Product Costs", confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2" };
  }

  // L2.5 — DEFAULT tax-based coding for product-like lines (v1.1.8, broadened).
  // A product-like line defaults by tax signal: untaxed => "Retail / Product
  // Costs" (sold to guests, exempt from purchase tax); taxed => "Service Costs"
  // (backbar consumed in services). LOW confidence so it's flagged/reviewable.
  // The Aveda-only gate is dropped; per-line tax (lineTax) still takes priority
  // over the header signal. Explicit per-line Type (TYPE_GL) and manual edits run
  // later and still win. Entity-gated — falls through when invalid for the entity.
  if (isProductLike(desc, vendorMapping, business)) {
    const taxAbsent = lineTax != null ? lineTax === 0 : !salesTaxPresent;
    const taxPresent = lineTax != null ? lineTax > 0 : salesTaxPresent;
    // RETAIL: product-like + untaxed. Also tag item_type "Retail" (v1.1.8 N) so
    // the export tax recompute treats it as retail-exempt and the exec split
    // Type is pre-filled.
    if (taxAbsent) {
      const r = gated("Retail / Product Costs", CONFIDENCE_LEVEL.LOW, "L2.5 RETAIL", "Retail");
      if (r) return r;
    }
    // BACKBAR/SERVICE: product-like + taxed. Tag item_type "Backbar" (v1.1.8 N).
    if (taxPresent) {
      const r = gated("Service Costs", CONFIDENCE_LEVEL.LOW, "L2.5 BACKBAR", "Backbar");
      if (r) return r;
    }
    // Category invalid for entity — fall through.
  }

  // L3 — keyword rules (≥90% confident).
  const kw = keywordCategory(desc);
  if (kw) {
    const r = gated(kw, CONFIDENCE_LEVEL.MEDIUM, "LEVEL 3");
    if (r) return r;
  }

  // Reducto's suggestion (entity-gated, only if valid for this entity).
  const sugg = opts.suggestedCategory;
  if (sugg && sugg !== REQUIRES_MANUAL_REVIEW && isCategoryValidForEntity(business, sugg))
    return { category: sugg, confidence: CONFIDENCE_LEVEL.MEDIUM, logic: "REDUCTO" };

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
