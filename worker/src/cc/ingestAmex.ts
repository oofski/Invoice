/**
 * CCRMS Amex ingestion (NEW; owned by A2).
 *
 * The renderer parses the Amex XLSX workbook (`cc/amexWorkbook.ts`, §7 overview):
 * one sheet per cardholder, header-by-name on Row 3, data from Row 4, blank /
 * totals-footer rows dropped. Each parsed row carries the transaction fields, the
 * `HAVE RECEIPT` / `IN QB` flags, and the per-entity amount columns (keyed by
 * their template/display label, e.g. "Nala Beauty Brands").
 *
 * This module normalizes ONE such parsed row → a source-agnostic `StagedTxRow`,
 * mapping each entity column header → canonical `entity_name` via
 * `amexLabelToCanonical`, and recomputing the charge total server-side from the
 * CHARGE column (XLSX formula results are ignored). A "blank template" sheet
 * yields zero rows upstream; this function returns `null` for any blank/footer
 * row so the caller drops it.
 *
 * Imports A1's frozen helpers only.
 */
import { roundCents, amexDedupKey } from "./ccRules";
import { amexLabelToCanonical, isCcEntity } from "./ccConstants";
import type { Env } from "../lib/types";
import type { CcReceiptStatus, EntitySplitInput, StagedTxRow } from "./ccTypes";
import { parseAmount, toIsoDate } from "../lib/util";

/**
 * A single Amex sheet row as parsed by the renderer (`cc/amexWorkbook.ts`). The
 * renderer owns the SheetJS parse and emits NORMALIZED keys: `sheet_name`,
 * `transaction_date`, `vendor`, `amount`, `exp_acct`, `have_receipt`, `in_qb`,
 * and `splits` (an array of `{entity_name, amount}` keyed by CANONICAL entity
 * name). For robustness this module ALSO tolerates raw-header keys ("Date",
 * "Charge", "HAVE RECEIPT") and an `entities` label→amount map / flattened
 * label keys, so a hand-built row still ingests.
 */
export interface AmexParsedRow {
  [key: string]: unknown;
  /** The cardholder sheet name (e.g. "Lori 36158") — resolved to a cardholder server-side. */
  sheet_name?: string | null;
  /** Canonical-keyed per-entity splits from the renderer parse. */
  splits?: { entity_name: string; amount: number }[];
  /** Entity-column amounts keyed by template/display label (e.g. "Skn Bar Rx") — fallback shape. */
  entities?: Record<string, unknown>;
  /** Optionally pre-resolved by a caller; otherwise resolved here from sheet_name. */
  cardholder_id?: string | null;
  amex_last5?: string | null;
  amex_sheet_name?: string | null;
}

/** An Amex cardholder registry entry keyed for sheet-name / last-5 resolution. */
export interface AmexRegistryEntry {
  id: string;
  amex_last5: string | null;
  amex_sheet_name: string | null;
}

/** Normalize a key for tolerant matching: lower-case, non-alphanumerics → single space. */
function normKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Tolerant accessor: case / space / underscore / punctuation-insensitive key
 * lookup over a parsed row (matches `transaction_date` AND "Transaction Date").
 */
function pick(row: Record<string, unknown>, ...names: string[]): string {
  const want = names.map(normKey);
  for (const k of Object.keys(row)) {
    if (want.includes(normKey(k))) {
      const v = row[k];
      return v == null ? "" : String(v).trim();
    }
  }
  return "";
}

/**
 * Loads the active Amex cardholder registry (rows that carry an `amex_last5` or
 * `amex_sheet_name`). Used to resolve a sheet name like "Lori 36158" → the
 * cardholder id server-side (the renderer only knows the sheet name). Mirrors
 * `loadCapOneRegistry`.
 */
export async function loadAmexRegistry(env: Env): Promise<AmexRegistryEntry[]> {
  try {
    const res = await env.DB.prepare(
      `SELECT id, amex_last5, amex_sheet_name FROM cc_cardholders
        WHERE is_active = 1 AND (amex_last5 IS NOT NULL OR amex_sheet_name IS NOT NULL)`,
    ).all<AmexRegistryEntry>();
    return res.results ?? [];
  } catch (e) {
    console.error("[cc] loadAmexRegistry failed:", e);
    return [];
  }
}

/**
 * Resolves a sheet name (e.g. "Lori 36158") to an Amex registry entry. Matches in
 * priority order: exact `amex_sheet_name`, then any last-5 digit run in the sheet
 * name equal to a registry `amex_last5`. Returns null when nothing matches.
 */
export function resolveAmexCardholder(
  sheetName: string,
  registry: AmexRegistryEntry[],
): AmexRegistryEntry | null {
  const sheet = sheetName.trim();
  if (!sheet) return null;
  const sheetNorm = normKey(sheet);
  // 1) exact (normalized) amex_sheet_name match.
  for (const e of registry) {
    if (e.amex_sheet_name && normKey(e.amex_sheet_name) === sheetNorm) return e;
  }
  // 2) last-5 digit run embedded in the sheet name (e.g. "...36158").
  const digitRuns = sheet.match(/\d{5}/g) ?? [];
  for (const run of digitRuns) {
    for (const e of registry) {
      if (e.amex_last5 && e.amex_last5 === run) return e;
    }
  }
  return null;
}

/** True when an Amex 'x'-style flag column is set ('x', 'X', 'yes', '1', true). */
function isFlagSet(v: unknown): boolean {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "x" || s === "yes" || s === "y" || s === "true" || s === "1";
}

/**
 * Extracts the canonical entity splits from a parsed Amex row. Priority:
 *   1. The renderer's `splits` array (already keyed by CANONICAL entity name) —
 *      this is the normal path from `cc/amexWorkbook.ts`.
 *   2. Fallback: a nested `entities` label→amount map, else the row's own
 *      top-level keys, mapped label → canonical via `amexLabelToCanonical`.
 * Keeps only non-zero amounts; amounts are recomputed (rounded) server-side and
 * summed by canonical entity.
 */
export function extractAmexSplits(row: AmexParsedRow): EntitySplitInput[] {
  const byEntity = new Map<string, number>();

  // 1) Renderer's canonical splits array.
  if (Array.isArray(row.splits)) {
    for (const s of row.splits) {
      const canonical = s?.entity_name;
      if (!isCcEntity(canonical)) continue;
      const amt = roundCents(parseAmount(s.amount == null ? "" : String(s.amount)));
      if (!Number.isFinite(amt) || amt === 0) continue;
      byEntity.set(canonical, roundCents((byEntity.get(canonical) ?? 0) + amt));
    }
    if (byEntity.size) {
      return [...byEntity.entries()].map(([entity_name, amount]) => ({ entity_name, amount }));
    }
  }

  // 2) Fallback: label-keyed `entities` map or flattened top-level label keys.
  const source: Record<string, unknown> =
    row.entities && typeof row.entities === "object"
      ? (row.entities as Record<string, unknown>)
      : row;
  for (const [label, raw] of Object.entries(source)) {
    const canonical = amexLabelToCanonical(label);
    if (!canonical) continue;
    const amt = roundCents(parseAmount(raw == null ? "" : String(raw)));
    if (!Number.isFinite(amt) || amt === 0) continue;
    byEntity.set(canonical, roundCents((byEntity.get(canonical) ?? 0) + amt));
  }

  return [...byEntity.entries()].map(([entity_name, amount]) => ({ entity_name, amount }));
}

/**
 * Normalizes a parsed Amex row → `StagedTxRow` (with derived entity splits).
 * Returns `null` for a blank/totals-footer row (DATE null AND VENDOR null AND
 * CHARGE null-or-0) so the caller drops it — a blank template thus produces zero
 * staged rows.
 *
 * The cardholder is resolved SERVER-SIDE from the sheet name (e.g. "Lori 36158")
 * against the active Amex registry — the renderer only knows the sheet name, not
 * the cardholder id.
 *
 * @param row       one renderer-parsed Amex sheet row (carries `sheet_name`)
 * @param registry  active Amex cardholder registry (from `loadAmexRegistry`)
 */
export function normalizeAmexRow(
  row: AmexParsedRow,
  registry: AmexRegistryEntry[] = [],
): StagedTxRow | null {
  // Renderer keys: transaction_date, vendor, amount, exp_acct, have_receipt,
  // in_qb, sheet_name, splits. Raw header names are accepted as aliases too.
  const txDate =
    toIsoDate(pick(row, "transaction_date", "Date", "Transaction Date")) ?? "";
  const postedDate = toIsoDate(pick(row, "posted_date", "Posted Date", "Post Date")) || null;
  const vendor = pick(row, "vendor", "Description", "Merchant", "Payee");
  const expAcct = pick(row, "exp_acct", "Exp Acct", "Expense Account") || null;
  const category = pick(row, "category", "Category") || expAcct;

  // Recompute the charge server-side (ignore XLSX Total/Difference formulas).
  const chargeStr = pick(row, "amount", "Charge", "Amount");
  const amount = roundCents(Math.abs(chargeStr ? parseAmount(chargeStr) : 0));

  // Blank / totals-footer guard: no date AND no vendor AND no charge → skip.
  if (!txDate && !vendor && amount === 0) return null;

  const haveReceiptRaw =
    (row as Record<string, unknown>)["have_receipt"] ??
    (row as Record<string, unknown>)["HAVE RECEIPT"] ??
    (row as Record<string, unknown>)["Have Receipt"] ??
    pick(row, "have_receipt", "HAVE RECEIPT", "Have Receipt");
  const inQbRaw =
    (row as Record<string, unknown>)["in_qb"] ??
    (row as Record<string, unknown>)["IN QB"] ??
    (row as Record<string, unknown>)["In QB"] ??
    pick(row, "in_qb", "IN QB", "In QB");
  const haveReceipt = isFlagSet(haveReceiptRaw);
  const inQb = isFlagSet(inQbRaw);

  const receiptStatus: CcReceiptStatus = haveReceipt ? "RECEIVED" : "PENDING";

  // Resolve the cardholder from the sheet name (server-side registry lookup).
  const sheetName = pick(row, "sheet_name", "Sheet", "Sheet Name");
  const resolved = sheetName ? resolveAmexCardholder(sheetName, registry) : null;
  const cardholderId = row.cardholder_id ?? resolved?.id ?? null;
  const amexLast5 = row.amex_last5 ?? resolved?.amex_last5 ?? null;
  const amexSheet =
    row.amex_sheet_name ?? resolved?.amex_sheet_name ?? (sheetName || null);

  const dedup_key = amexDedupKey({
    transaction_date: txDate,
    amex_last5: amexLast5,
    amex_sheet_name: amexSheet,
    vendor,
    amount,
  });

  return {
    source: "AMEX",
    cardholder_id: cardholderId,
    transaction_date: txDate,
    posted_date: postedDate,
    vendor: vendor || "(no description)",
    description: null,
    category,
    amount,
    is_credit: false,
    is_payment: false,
    receipt_status: receiptStatus,
    in_qb: inQb,
    exp_acct: expAcct,
    dedup_key,
    splits: extractAmexSplits(row),
    is_duplicate: false,
    // For the unmatched-cards banner: report the sheet name when no cardholder resolved.
    card_digits: cardholderId ? null : amexLast5 || sheetName || null,
  };
}
