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
