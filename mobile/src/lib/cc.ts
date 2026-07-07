/**
 * CC (credit-card) entity-split contract — 7 entities in Amex template order.
 *
 * STANDALONE COPY. These values are copied VERBATIM from the worker/desktop
 * source so this mobile app imports nothing from `desktop/` or `worker/`. This
 * mirrors the existing convention (the desktop renderer already re-declares the
 * CC contract locally in `desktop/renderer/src/cc/ccApi.ts` rather than
 * importing from the worker).
 *
 * Sources of truth (kept in sync manually — tiny + stable):
 *   - CC_ENTITIES / order / labels : desktop/renderer/src/cc/ccApi.ts:648
 *                                    worker/src/cc/ccConstants.ts:19,80
 *   - roundCents                   : worker/src/cc/ccRules.ts:16
 *   - validateSplits (mirror)      : worker/src/cc/ccRules.ts:40
 */

export interface CcEntityDef {
  /** DB `cc_entity_splits.entity_name` value. */
  canonical: string;
  /** CC display label (Amex template wording; differs from invoice/QBO labels). */
  label: string;
}

/**
 * The 7 canonical CC entities in TEMPLATE / display order (Amex template cols
 * G–M). The split screen and validation iterate in this order.
 * Copied verbatim from desktop/renderer/src/cc/ccApi.ts:648.
 */
export const CC_ENTITIES: CcEntityDef[] = [
  { canonical: "Nala", label: "Nala Beauty Brands" },
  { canonical: "UrbanAyurveda", label: "Urban Ayurveda" },
  { canonical: "SKNBar", label: "Skn Bar Rx" },
  { canonical: "Admin", label: "Admin" },
  { canonical: "IBW", label: "Institute" },
  { canonical: "Chicago", label: "Institute Chicago" },
  { canonical: "Neroli", label: "Neroli" },
];

const CC_ENTITY_SET: ReadonlySet<string> = new Set(
  CC_ENTITIES.map((e) => e.canonical),
);

/** True when `name` is one of the 7 canonical CC entity names. */
export function isCcEntity(name: string | null | undefined): boolean {
  return !!name && CC_ENTITY_SET.has(name);
}

export const CC_ENTITY_LABEL: Record<string, string> = Object.fromEntries(
  CC_ENTITIES.map((e) => [e.canonical, e.label]),
);

/** Resolve a stored canonical entity_name to its CC display label. */
export function ccEntityLabel(canonical: string): string {
  return CC_ENTITY_LABEL[canonical] ?? canonical;
}

/**
 * Rounds to cents (2 dp). Copied verbatim from worker/src/cc/ccRules.ts:16
 * (`Math.round(n * 100) / 100`). The exact-to-cent split gate compares with
 * this so the client lock matches the server's `validateSplits`.
 */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** One entity-split row as sent to the server. */
export interface EntitySplitInput {
  entity_name: string;
  amount: number;
}

export interface SplitValidation {
  ok: boolean;
  error?: string;
}

/**
 * Client-side mirror of the server `validateSplits` (worker/src/cc/ccRules.ts:40):
 *   - every `entity_name` must be one of the 7 canonical CC_ENTITIES;
 *   - every `amount` must be finite and ≥ 0 (negatives rejected; 0 allowed);
 *   - roundCents(Σ amounts) === roundCents(amount) — exact-to-cent.
 * Never throws. The mobile Submit button is locked until this returns ok.
 */
export function validateSplits(
  amount: number,
  rows: EntitySplitInput[],
): SplitValidation {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "At least one entity split is required." };
  }
  let sum = 0;
  for (const r of rows) {
    if (!r || typeof r.entity_name !== "string" || !isCcEntity(r.entity_name)) {
      return { ok: false, error: `Unknown entity: ${r?.entity_name ?? "(missing)"}` };
    }
    const a = typeof r.amount === "number" ? r.amount : Number(r.amount);
    if (!Number.isFinite(a)) {
      return { ok: false, error: `Invalid amount for ${r.entity_name}` };
    }
    if (roundCents(a) < 0) {
      return { ok: false, error: `Amounts cannot be negative (${r.entity_name})` };
    }
    sum += a;
  }
  if (roundCents(sum) !== roundCents(amount)) {
    return { ok: false, error: "Splits must sum to the transaction amount." };
  }
  return { ok: true };
}

// ===========================================================================
// LINE-CODING MODEL (entity × location × GL) — mobile mirror of the server
// model in worker/src/cc/ccLines.ts + ccTypes.ts. STANDALONE COPY (no imports
// from worker/ or desktop/). This unifies the mobile split onto the existing
// `cc_line_allocations` model so one payload serves both the quick split and
// the line-by-line split, and rolls up to the ledger for free.
// ===========================================================================

/**
 * Entity → locations/campuses map. Copied VERBATIM from
 * worker/src/lib/constants.ts:151 `BUSINESS_CLASSES`. Location strings are exact
 * (note "North Shore" with a space). Entities NOT present here (UrbanAyurveda)
 * fall back to `[entity]` via `locationsFor`.
 */
export const BUSINESS_CLASSES: Record<string, string[]> = {
  Neroli: ["Mequon", "Downtown", "Eastside", "North Shore", "Brookfield"],
  SKNBar: ["Shorewood", "Pewaukee"],
  IBW: ["Milwaukee", "Madison"],
  Chicago: ["Chicago"],
  Admin: ["Admin"],
  Nala: ["Nala"],
};

/**
 * The campuses/locations for a CC entity — `BUSINESS_CLASSES[entity]` when
 * present, else `[entity]` (UrbanAyurveda). Mirrors ccLines.ts `locationsFor`.
 */
export function locationsFor(entity: string): string[] {
  const classes = BUSINESS_CLASSES[entity];
  return classes && classes.length ? classes : [entity];
}

/** O(1) check that `location` is a valid campus for `entity`. */
export function isLocationFor(entity: string, location: string): boolean {
  return locationsFor(entity).includes(location);
}

/**
 * CC entity display order (worker/src/cc/ccConstants.ts CC_ENTITY_ORDER). The
 * mobile `CC_ENTITIES` array is already declared in this exact order, so this is
 * just its canonical-name projection for callers that want the plain list.
 */
export const CC_ENTITY_ORDER: string[] = CC_ENTITIES.map((e) => e.canonical);

/** The three GL-category labels an allocation may carry (§3.5). ONLY these. */
export const SERVICE_COSTS = "Service Costs";
export const RETAIL_COSTS = "Retail / Product Costs";
export const SALES_USE_TAX = "Sales/Use Tax";
export const ALLOWED_GL_CATEGORIES: ReadonlySet<string> = new Set([
  SERVICE_COSTS,
  RETAIL_COSTS,
  SALES_USE_TAX,
]);

/** A synthetic line_index for the (single) TAX line so it sorts last. */
export const TAX_LINE_INDEX = 99;

/** A line's kind: a normal item line, or the single per-receipt sales-tax line. */
export type CcLineKind = "ITEM" | "TAX";

/**
 * One per-line allocation slice (entity × location × GL). Mirrors the server DTO
 * `LineAllocation` in worker/src/cc/ccTypes.ts:338.
 */
export interface LineAllocation {
  id?: string;
  entity_name: string;
  location: string;
  gl_category: string;
  amount: number;
  is_tax?: boolean;
}

/**
 * A receipt line with its allocations. Mirrors the server DTO `ReceiptLine` in
 * worker/src/cc/ccTypes.ts:348 (the PUT /transactions/:id/lines body shape).
 */
export interface ReceiptLine {
  id?: string;
  client_id?: string;
  receipt_id?: string | null;
  line_index?: number;
  kind: CcLineKind;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount: number;
  is_coded?: boolean;
  allocations: LineAllocation[];
}

function toNum(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

export interface LineCodingValidation {
  ok: boolean;
  error?: string;
}

/**
 * Client-side mirror of the server `validateLineCoding` (worker/src/cc/ccLines.ts:155),
 * exact-to-cent like `validateSplits`:
 *   - every allocation's `entity_name` ∈ CC_ENTITIES; `location` ∈ locationsFor(entity);
 *     `gl_category` ∈ the allowed set; amount finite & ≥ 0;
 *   - per line: roundCents(Σ alloc.amount) === roundCents(line.amount);
 *   - whole tx: roundCents(Σ all alloc.amount) === roundCents(txAmount).
 * Never throws. The mobile Submit button is locked until this returns ok.
 */
export function validateLineCoding(
  txAmount: number,
  lines: ReceiptLine[],
): LineCodingValidation {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { ok: false, error: "At least one line is required." };
  }

  let txSum = 0;
  for (const line of lines) {
    if (!line || typeof line !== "object") {
      return { ok: false, error: "Invalid line entry." };
    }
    const lineAmt = toNum(line.amount);
    if (!Number.isFinite(lineAmt)) {
      return { ok: false, error: `Invalid amount for line "${line.description ?? ""}"` };
    }
    const allocs = Array.isArray(line.allocations) ? line.allocations : [];
    let lineSum = 0;
    for (const a of allocs) {
      if (!a || typeof a.entity_name !== "string" || !isCcEntity(a.entity_name)) {
        return { ok: false, error: `Unknown entity: ${a?.entity_name ?? "(missing)"}` };
      }
      if (typeof a.location !== "string" || !isLocationFor(a.entity_name, a.location)) {
        return {
          ok: false,
          error: `Pick a location for ${ccEntityLabel(a.entity_name)}.`,
        };
      }
      if (typeof a.gl_category !== "string" || !ALLOWED_GL_CATEGORIES.has(a.gl_category)) {
        return { ok: false, error: `Invalid category: ${a?.gl_category ?? "(missing)"}` };
      }
      const amt = toNum(a.amount);
      if (!Number.isFinite(amt)) {
        return { ok: false, error: `Invalid amount for ${a.entity_name} / ${a.location}` };
      }
      if (roundCents(amt) < 0) {
        return { ok: false, error: `Amounts cannot be negative (${a.entity_name})` };
      }
      lineSum += amt;
    }
    if (roundCents(lineSum) !== roundCents(lineAmt)) {
      return {
        ok: false,
        error: `Each line's allocations must sum to the line amount.`,
      };
    }
    txSum += lineAmt;
  }

  if (roundCents(txSum) !== roundCents(txAmount)) {
    return { ok: false, error: "Lines must sum to the transaction amount." };
  }
  return { ok: true };
}

/**
 * Quick-split builder: represents the WHOLE receipt total as ONE synthetic ITEM
 * line carrying the per-(entity,location) allocations. `gl_category` defaults to
 * "Service Costs" (the accountant refines GL on desktop). $0 allocations dropped.
 */
export function buildQuickLines(
  total: number,
  allocations: LineAllocation[],
): ReceiptLine[] {
  const cleaned = allocations
    .map((a) => ({
      entity_name: a.entity_name,
      location: a.location,
      gl_category: a.gl_category || SERVICE_COSTS,
      amount: roundCents(toNum(a.amount)),
      is_tax: a.is_tax ?? false,
    }))
    .filter((a) => a.amount !== 0);
  return [
    {
      line_index: 0,
      kind: "ITEM",
      description: "Receipt total",
      amount: roundCents(total),
      allocations: cleaned,
    },
  ];
}

/** A minimal line descriptor for the line-by-line builder (OCR or edited). */
export interface LineDescriptor {
  description?: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount?: number | null;
}

/**
 * Line-by-line builder: one ITEM line per OCR/edited line descriptor (carrying
 * its own allocations from `perLineAllocations[i]`), plus one TAX line
 * (kind:'TAX', gl "Sales/Use Tax") when `tax` is present and > $0.
 */
export function buildLineByLine(
  ocrLines: LineDescriptor[],
  perLineAllocations: LineAllocation[][],
  tax?: { amount: number; allocations: LineAllocation[] } | null,
): ReceiptLine[] {
  const lines: ReceiptLine[] = ocrLines.map((li, i) => ({
    line_index: i,
    kind: "ITEM" as const,
    description: li.description || `Item ${i + 1}`,
    quantity: li.quantity ?? null,
    unit_price: li.unit_price ?? null,
    amount: roundCents(typeof li.amount === "number" ? li.amount : 0),
    allocations: (perLineAllocations[i] ?? [])
      .map((a) => ({
        entity_name: a.entity_name,
        location: a.location,
        gl_category: a.gl_category || SERVICE_COSTS,
        amount: roundCents(toNum(a.amount)),
        is_tax: a.is_tax ?? false,
      }))
      .filter((a) => a.amount !== 0),
  }));

  if (tax && roundCents(tax.amount) > 0) {
    lines.push({
      line_index: TAX_LINE_INDEX,
      kind: "TAX",
      description: "Sales Tax",
      amount: roundCents(tax.amount),
      allocations: (tax.allocations ?? [])
        .map((a) => ({
          entity_name: a.entity_name,
          location: a.location,
          gl_category: a.gl_category || SALES_USE_TAX,
          amount: roundCents(toNum(a.amount)),
          is_tax: true,
        }))
        .filter((a) => a.amount !== 0),
    });
  }
  return lines;
}
