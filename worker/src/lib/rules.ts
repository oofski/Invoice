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
  type Approver,
  type BusinessEntity,
  type ClassName,
  type ConfidenceLevel,
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

/** Matches the first non-Admin location whose keyword appears in the text. */
export function matchLocation(text: string, locs: LocationRow[]): LocationRow | null {
  const hay = (text || "").toLowerCase();
  if (!hay) return null;
  for (const l of locs) {
    if (l.business === "Admin") continue; // Admin keywords ("Admin","Corporate") are too generic to match on
    if (l.keywords.some((k) => k && hay.includes(k.toLowerCase()))) return l;
  }
  return null;
}

// --------------------------------------------------------------- approver routing
const KNOWN_RULE_VENDORS = [
  ...RULE2_LISA_VENDORS,
  ...RULE3_KARI_VENDORS,
  ...RULE4_LORI_VENDORS,
  ...RULE5_BONNIE_VENDORS,
];

/** Prompt 2 routing rules, in strict priority order (Brief §05). */
export function routeApprover(opts: {
  business: BusinessEntity;
  vendor: string;
  vendorMapping: VendorMappingRow | null;
  total: number;
  descriptions: string[];
}): { approver: Approver; logic: string } {
  const { business, vendor, vendorMapping, total, descriptions } = opts;

  // RULE 1 — high dollar or construction => Susan
  const hasConstruction = descriptions.some((d) => /construction/i.test(d));
  if (total > SUSAN_THRESHOLD || hasConstruction) return { approver: "Susan", logic: "RULE 1" };

  const isIbwChicago = business === "IBW" || business === "Chicago";
  const isNeroliSkn = business === "Neroli" || business === "SKNBar";

  // RULE 2 — IBW/Chicago + Lisa vendors
  if (isIbwChicago && vendorInList(vendor, RULE2_LISA_VENDORS)) return { approver: "Lisa", logic: "RULE 2" };

  // RULE 3 — IBW/Chicago + Kari vendors OR unknown vendor
  const knownVendor = vendorMapping != null || vendorInList(vendor, KNOWN_RULE_VENDORS);
  if (isIbwChicago && (vendorInList(vendor, RULE3_KARI_VENDORS) || !knownVendor))
    return { approver: "Kari", logic: "RULE 3" };

  // RULE 4 — Neroli/SKNBar + Lori vendors
  if (isNeroliSkn && vendorInList(vendor, RULE4_LORI_VENDORS)) return { approver: "Lori", logic: "RULE 4" };

  // RULE 5 — Bonnie vendors OR Admin entity
  if (vendorInList(vendor, RULE5_BONNIE_VENDORS) || business === "Admin")
    return { approver: "Bonnie", logic: "RULE 5" };

  // Admin-configured per-vendor default, then catch-all.
  const vm = vendorMapping?.default_approver;
  if (vm && (APPROVERS as readonly string[]).includes(vm))
    return { approver: vm as Approver, logic: "VENDOR MAP" };
  return { approver: "Bonnie", logic: "CATCH-ALL" };
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
/** The brief's LEVEL 3 keyword rules (kept deliberately small/safe). */
function keywordCategory(desc: string): string | null {
  if (/clean/.test(desc)) return "Repairs & Maintenance";
  if (/\brent\b/.test(desc)) return "Occupancy - Rent";
  if (/freight|shipping/.test(desc)) return "Freight";
  if (/software|\bit\b|computer|subscription|saas|license/.test(desc)) return "Computer & IT";
  return null;
}

/**
 * 5-level GL hierarchy with Reducto's suggestion slotted between the keyword
 * level and the entity fallback (Brief §05/§13):
 *   L1 tax -> L2 vendor map -> L3 keywords -> Reducto suggestion -> L4 entity -> L5 manual.
 */
export function codeLineItem(opts: {
  description: string;
  vendorMapping: VendorMappingRow | null;
  business: BusinessEntity;
  suggestedCategory?: string;
}): { category: string; confidence: ConfidenceLevel; logic: string } {
  const desc = (opts.description || "").toLowerCase();

  // LEVEL 1 — tax isolation (never overridden)
  if (/(sales|use)\s*tax/.test(desc)) return { category: "Sales/Use Tax", confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 1" };

  // LEVEL 2 — vendor mapping (gl_override / inventory)
  if (opts.vendorMapping) {
    const ov = opts.vendorMapping.gl_override;
    if (ov && GL_CATEGORIES_FLAT.includes(ov))
      return { category: ov, confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2" };
    if (opts.vendorMapping.is_inventory)
      return { category: "Retail / Product Costs", confidence: CONFIDENCE_LEVEL.HIGH, logic: "LEVEL 2" };
  }

  // LEVEL 3 — keyword rules
  const kw = keywordCategory(desc);
  if (kw) return { category: kw, confidence: CONFIDENCE_LEVEL.MEDIUM, logic: "LEVEL 3" };

  // Reducto's suggestion (only if it's a valid allowed category)
  const sugg = opts.suggestedCategory;
  if (sugg && sugg !== REQUIRES_MANUAL_REVIEW && GL_CATEGORIES_FLAT.includes(sugg))
    return { category: sugg, confidence: CONFIDENCE_LEVEL.MEDIUM, logic: "REDUCTO" };

  // LEVEL 4 — entity fallback
  if (opts.business === "SKNBar")
    return { category: "Service Costs", confidence: CONFIDENCE_LEVEL.LOW, logic: "LEVEL 4" };
  if (opts.business === "IBW" && /student|tuition|kit/.test(desc))
    return { category: "Student Expenses", confidence: CONFIDENCE_LEVEL.LOW, logic: "LEVEL 4" };

  // LEVEL 5 — manual review
  return { category: REQUIRES_MANUAL_REVIEW, confidence: CONFIDENCE_LEVEL.MANUAL_REVIEW, logic: "LEVEL 5" };
}
