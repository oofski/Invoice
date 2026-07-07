/**
 * Currency formatting helper. Copied from the desktop renderer's
 * `formatCurrency` (desktop/renderer/src/lib/utils.ts:32) — standalone, no
 * cross-package import.
 */
export function formatCurrency(n: number | null | undefined): string {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/**
 * Parse a money-ish input string to a number. "" / invalid → 0. Used by the
 * split inputs where empty means "0 allocated".
 */
export function parseMoney(raw: string | null | undefined): number {
  if (!raw) return 0;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}
