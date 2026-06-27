/**
 * CCRMS Capital One ingestion (NEW; owned by A2).
 *
 * The renderer parses the Capital One CSV (hand-rolled, §7 overview) into an
 * array of loosely-typed rows and POSTs them to `/uploads/preview`. This module
 * takes ONE such parsed row and normalizes it into a source-agnostic
 * `StagedTxRow` ready to stage on the batch (and later insert):
 *
 *   - Payment/Credit-category rows  → `is_payment=1` (excluded from receipt
 *     tracking; the reminder/dashboard logic ignores payments).
 *   - Credit-column rows (negative / refund) → `is_credit=1` +
 *     `receipt_status='NOT_REQUIRED'` (a refund needs no receipt).
 *   - dedup key via `capOneDedupKey` (date + last-4 + vendor + amount).
 *   - the card last-4 is matched against the active cardholder registry.
 *
 * Server NEVER trusts a client-supplied amount sign/total — it recomputes the
 * signed amount from the Debit/Credit columns. Imports A1's frozen helpers only.
 */
import type { Env } from "../lib/types";
import { roundCents, capOneDedupKey } from "./ccRules";
import type { CcReceiptStatus, StagedTxRow } from "./ccTypes";
import { parseAmount, toIsoDate } from "../lib/util";

/**
 * A single Capital One CSV row as parsed by the renderer (`CcUploadPage`'s
 * `parseCapOneCsv`). The renderer owns the CSV parse and emits NORMALIZED
 * snake_case keys (NOT the raw Capital One header names): `transaction_date`,
 * `posted_date`, `card_last4`, `vendor`, `category`, `debit`, `credit`, `amount`.
 * Field access is tolerant of casing/whitespace AND of the raw-header aliases via
 * `pick()`, so a hand-built row using header names still works.
 */
export interface CapOneParsedRow {
  [key: string]: string | number | null | undefined;
}

/** Categories Capital One uses for cardholder payments (never need a receipt). */
const PAYMENT_CATEGORY = /payment|autopay|pymt|thank you/i;

/** Normalize a key for tolerant matching: lower-case, spaces/underscores/punct → single space. */
function normKey(k: string): string {
  return k.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Tolerant accessor: case / space / underscore / punctuation-insensitive key
 * lookup over a parsed row. Matches the renderer's snake_case keys
 * (`transaction_date`, `card_last4`) as well as raw-header aliases
 * ("Transaction Date", "Card No.").
 */
function pick(row: CapOneParsedRow, ...names: string[]): string {
  const want = names.map(normKey);
  for (const k of Object.keys(row)) {
    if (want.includes(normKey(k))) {
      const v = row[k];
      return v == null ? "" : String(v).trim();
    }
  }
  return "";
}

/** Digits-only last-4 from a "Card No." style column. */
function last4(v: string): string {
  return v.replace(/\D/g, "").slice(-4);
}

/** An active-cardholder registry row used for last-4 matching. */
interface RegistryCardholder {
  id: string;
  cap_one_last4: string | null;
}

/**
 * Loads the active cardholder registry's Cap One last-4 → id map once per
 * preview/confirm pass (so per-row matching is O(1) without N queries).
 */
export async function loadCapOneRegistry(env: Env): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const res = await env.DB.prepare(
      "SELECT id, cap_one_last4 FROM cc_cardholders WHERE is_active = 1 AND cap_one_last4 IS NOT NULL",
    ).all<RegistryCardholder>();
    for (const ch of res.results ?? []) {
      if (ch.cap_one_last4) map.set(ch.cap_one_last4, ch.id);
    }
  } catch (e) {
    console.error("[cc] loadCapOneRegistry failed:", e);
  }
  return map;
}

/**
 * Normalizes a parsed Capital One row → `StagedTxRow`. Returns `null` for a row
 * with no usable date AND no vendor AND no amount (a blank/footer row).
 *
 * @param row       one renderer-parsed Cap One CSV row
 * @param registry  active-cardholder last-4 → id map (from `loadCapOneRegistry`)
 */
export function normalizeCapOneRow(
  row: CapOneParsedRow,
  registry: Map<string, string>,
): StagedTxRow | null {
  // The renderer sends normalized snake_case keys (`transaction_date`,
  // `card_last4`, …); raw Capital One header names are also accepted as aliases.
  const txDate =
    toIsoDate(pick(row, "transaction_date", "Transaction Date", "Trans Date", "Date")) ?? "";
  const postedDate = toIsoDate(pick(row, "posted_date", "Posted Date", "Post Date")) || null;
  const vendor = pick(row, "vendor", "Description", "Merchant", "Payee");
  const category = pick(row, "category", "Category") || null;
  const cardDigits = last4(
    pick(row, "card_last4", "Card No.", "Card No", "Card Number", "Last 4", "Card"),
  );

  // Capital One exports a "Debit" column for charges and a "Credit" column for
  // refunds/payments. Recompute the signed amount server-side (never trust a
  // client total). A charge is a positive amount; a credit is recorded positive
  // with `is_credit=1` so totals/UX read the magnitude.
  const debitStr = pick(row, "debit", "Debit", "Amount");
  const creditStr = pick(row, "credit", "Credit");
  const debit = debitStr ? parseAmount(debitStr) : 0;
  const credit = creditStr ? parseAmount(creditStr) : 0;

  const hasCredit = Number.isFinite(credit) && roundCents(credit) > 0;
  const rawAmount = hasCredit ? credit : debit;
  const amount = roundCents(Math.abs(Number.isFinite(rawAmount) ? rawAmount : 0));

  // Blank / footer row guard: no date AND no vendor AND no amount → skip.
  if (!txDate && !vendor && amount === 0) return null;

  const isPayment = PAYMENT_CATEGORY.test(category ?? "") || PAYMENT_CATEGORY.test(vendor);
  const isCredit = hasCredit && !isPayment;

  let receiptStatus: CcReceiptStatus = "PENDING";
  if (isPayment) receiptStatus = "NOT_REQUIRED";
  else if (isCredit) receiptStatus = "NOT_REQUIRED";

  const cardholderId = cardDigits ? registry.get(cardDigits) ?? null : null;

  const dedup_key = capOneDedupKey({
    transaction_date: txDate,
    cap_one_last4: cardDigits,
    vendor,
    amount,
  });

  return {
    source: "CAPITAL_ONE",
    cardholder_id: cardholderId,
    transaction_date: txDate,
    posted_date: postedDate,
    vendor: vendor || "(no description)",
    description: null,
    category,
    amount,
    is_credit: isCredit,
    is_payment: isPayment,
    receipt_status: receiptStatus,
    in_qb: false,
    exp_acct: null,
    dedup_key,
    splits: [],
    is_duplicate: false,
    card_digits: cardDigits || null,
  };
}
