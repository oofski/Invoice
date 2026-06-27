/**
 * CCRMS money + validation rules (NEW).
 *
 *   - `roundCents`        — 2-dp rounding (matches the invoice module's idiom).
 *   - `validateSplits`    — exact-to-cent split validation against `CC_ENTITIES`.
 *   - `capOneDedupKey` /
 *     `amexDedupKey`      — deterministic per-source UNIQUE keys (one shared
 *                           `idx_cc_tx_dedup` index serves both; the source is
 *                           encoded into the key so the two namespaces never
 *                           collide).
 */
import { isCcEntity } from "./ccConstants";
import type { EntitySplitInput } from "./ccTypes";

/** Rounds to cents (2 dp). Mirrors `roundCents` in `routes/invoices.ts`. */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Formats a number as a `$X.XX` string for user-facing error messages. */
export function fmtMoney(n: number): string {
  return `$${roundCents(n).toFixed(2)}`;
}

/** Result of a split validation. */
export interface SplitValidation {
  ok: boolean;
  error?: string;
}

/**
 * Validates entity-split rows against a transaction `amount` (§4):
 *   - every `entity_name` must be one of the 7 canonical `CC_ENTITIES`;
 *   - every `amount` must be a finite number ≥ 0 (negatives rejected; 0 allowed);
 *   - `roundCents(Σ amounts) === roundCents(amount)` — exact-to-cent.
 *
 * Returns `{ ok:true }` or `{ ok:false, error }` with the §4 error string. Never
 * throws.
 */
export function validateSplits(amount: number, rows: EntitySplitInput[]): SplitValidation {
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
    const diff = roundCents(Math.abs(roundCents(amount) - roundCents(sum)));
    return {
      ok: false,
      error: `Splits must sum to the transaction amount (${fmtMoney(amount)}); difference is ${fmtMoney(diff)}`,
    };
  }
  return { ok: true };
}

/** Lower-cases, trims, and collapses internal whitespace for dedup tokens. */
function normToken(v: string | number | null | undefined): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/** Normalizes an amount to a stable signed 2-dp string for dedup keys. */
function normAmount(n: number): string {
  return roundCents(n).toFixed(2);
}

/**
 * Deterministic UNIQUE dedup key for a Capital One transaction. Encodes the
 * source so it shares the single `idx_cc_tx_dedup` index without colliding with
 * Amex keys. Keyed on (date, last-4, vendor, amount).
 */
export function capOneDedupKey(input: {
  transaction_date: string;
  cap_one_last4?: string | null;
  vendor: string;
  amount: number;
}): string {
  return [
    "capone",
    normToken(input.transaction_date),
    normToken(input.cap_one_last4 ?? ""),
    normToken(input.vendor),
    normAmount(input.amount),
  ].join("|");
}

/**
 * Deterministic UNIQUE dedup key for an Amex transaction. Keyed on (date,
 * sheet/last-5, vendor, amount). Use the cardholder's `amex_last5` (or the Amex
 * sheet name when last-5 is unavailable) so two cardholders' identical charges
 * don't collapse.
 */
export function amexDedupKey(input: {
  transaction_date: string;
  amex_last5?: string | null;
  amex_sheet_name?: string | null;
  vendor: string;
  amount: number;
}): string {
  const ident = input.amex_last5 || input.amex_sheet_name || "";
  return [
    "amex",
    normToken(input.transaction_date),
    normToken(ident),
    normToken(input.vendor),
    normAmount(input.amount),
  ].join("|");
}
