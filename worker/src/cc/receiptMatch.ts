/**
 * CCRMS receipt auto-match (NEW; backend agent — Feature A §2).
 *
 * `matchReceiptToTransaction(env, normalized)` runs on the worker at drop time
 * (once per file, inside the inbox bulk loop). It resolves the cardholder (reusing
 * `matchCardholder` per card source, picking the best), queries that cardholder's
 * open transactions for an amount + date candidate, and returns a `MatchOutcome`:
 *
 *   - `{ kind:'matched', transactionId }` — a CONFIDENT single match → auto-attach.
 *   - `{ kind:'queued', candidateIds }`   — ambiguous / no match → manager inbox.
 *
 * NEVER throws — any failure degrades to `queued` (conservative bias: when in
 * doubt, queue; never wrong-auto-attach). Reuses `matchCardholder` / `toIsoDate`
 * READ-ONLY.
 */
import type { Env } from "../lib/types";
import { toIsoDate } from "../lib/util";
import { matchCardholder } from "./receiptExtract";
import type {
  CcSource,
  MatchConfidence,
  MatchOutcome,
  MatchResult,
  NormalizedReceipt,
} from "./ccTypes";

// --- §2 constants ----------------------------------------------------------

/**
 * Amount match tolerance (dollars). We try an EXACT ($0.00) match first; only if
 * that yields no rows do we widen to `$0.02` (covers cent rounding). Never wider —
 * amount is the strongest signal.
 */
export const AMOUNT_TOLERANCE = 0.02;

/**
 * Transaction-date window (± days). Receipts often predate posting, so the
 * candidate's `transaction_date` may drift from the receipt date by a few days.
 */
export const DATE_WINDOW_DAYS = 5;

/**
 * The receipt-statuses an auto-match candidate transaction can be in. v1.9.11
 * (M8): only PENDING (genuinely awaiting a receipt). UPLOADED means a receipt is
 * already attached, so auto-attaching a second one to it — often the WRONG tx
 * when it's the only in-window amount match — is exactly the false positive we
 * want to avoid. Managers can still manually attach to an UPLOADED tx.
 */
const OPEN_STATUSES = ["PENDING"] as const;

// --- candidate row shape ---------------------------------------------------

interface CandidateRow {
  id: string;
  vendor: string;
  amount: number;
  transaction_date: string;
  receipt_status: string;
}

/** Confidence rank for picking the better of the two cardholder matches. */
function rank(c: MatchConfidence): number {
  return c === "HIGH" ? 3 : c === "MEDIUM" ? 2 : 1;
}

/**
 * Picks the better of two cardholder matches: prefer a resolved `cardholder_id`,
 * then `MATCHED` over `NAME_MISMATCH`/`UNMATCHED`, then higher confidence.
 */
function better(
  a: { res: MatchResult; source: CcSource },
  b: { res: MatchResult; source: CcSource },
): { res: MatchResult; source: CcSource } {
  const aHas = a.res.cardholder_id != null;
  const bHas = b.res.cardholder_id != null;
  if (aHas !== bHas) return aHas ? a : b;
  // Both resolved (or both unresolved): prefer MATCHED, then higher confidence.
  const aMatched = a.res.match === "MATCHED";
  const bMatched = b.res.match === "MATCHED";
  if (aMatched !== bMatched) return aMatched ? a : b;
  return rank(b.res.confidence) > rank(a.res.confidence) ? b : a;
}

/** Shifts an ISO `YYYY-MM-DD` date by `days` (lexicographic-safe range bind). */
function shiftIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Resolves the cardholder + finds a candidate transaction for a dropped receipt,
 * then maps to a confident-match-or-queue outcome (§2). Never throws.
 */
export async function matchReceiptToTransaction(
  env: Env,
  normalized: NormalizedReceipt,
): Promise<MatchOutcome> {
  const UNRESOLVED: MatchResult = { cardholder_id: null, match: "UNMATCHED", confidence: "LOW" };
  try {
    // --- Step 1: resolve cardholder (run matchCardholder per source, pick best).
    const cap = await matchCardholder(env, normalized, "CAPITAL_ONE");
    const amex = await matchCardholder(env, normalized, "AMEX");
    const best = better(
      { res: cap, source: "CAPITAL_ONE" },
      { res: amex, source: "AMEX" },
    );
    const match = best.res;
    const cardholderId = match.cardholder_id;
    // `source_guess` is only meaningful when a cardholder actually resolved.
    const sourceGuess: CcSource | null = cardholderId ? best.source : null;

    // No cardholder → queue immediately, no candidates (manager can still assign).
    if (!cardholderId) {
      return {
        kind: "queued",
        candidateIds: [],
        cardholderId: null,
        sourceGuess: null,
        match,
      };
    }

    // --- Step 2: candidate transaction query (same cardholder, open, not payment).
    const total = typeof normalized.total === "number" ? normalized.total : null;
    if (total == null || !Number.isFinite(total)) {
      // No usable amount → cannot match on the strongest signal; queue, no candidates.
      return { kind: "queued", candidateIds: [], cardholderId, sourceGuess, match };
    }

    const receiptIso = toIsoDate(normalized.transaction_date);
    const statusPlaceholders = OPEN_STATUSES.map(() => "?").join(",");

    // Exact-amount first; widen to the tolerance only if that yields nothing.
    let rows = await queryCandidates(env, {
      cardholderId,
      total,
      tolerance: 0,
      statusPlaceholders,
      receiptIso,
    });
    if (rows.length === 0) {
      rows = await queryCandidates(env, {
        cardholderId,
        total,
        tolerance: AMOUNT_TOLERANCE,
        statusPlaceholders,
        receiptIso,
      });
    }

    const candidateIds = rows.map((r) => r.id);

    // --- Step 3: confidence → outcome.
    const dated = receiptIso != null;
    const matchedHighOrMedium =
      match.match === "MATCHED" && (match.confidence === "HIGH" || match.confidence === "MEDIUM");

    // CONFIDENT single match: exactly one candidate, the amount is exact
    // (`|amount − total| ≤ $0.02`), the receipt date is present & in-window, and
    // the cardholder match is a HIGH/MEDIUM MATCHED. Otherwise queue.
    const amountOk =
      rows.length === 1 && Math.abs(rows[0].amount - total) <= AMOUNT_TOLERANCE;

    const confident = rows.length === 1 && amountOk && dated && matchedHighOrMedium;

    if (confident) {
      return {
        kind: "matched",
        transactionId: rows[0].id,
        cardholderId,
        sourceGuess,
        match,
      };
    }

    // Ambiguous (>1, missing date, NAME_MISMATCH, etc.) or no match → queue.
    return { kind: "queued", candidateIds, cardholderId, sourceGuess, match };
  } catch (e) {
    console.error("[cc] matchReceiptToTransaction failed (degrading to queued):", e);
    return { kind: "queued", candidateIds: [], cardholderId: null, sourceGuess: null, match: UNRESOLVED };
  }
}

/**
 * Runs the candidate query for a cardholder at a given amount tolerance. When the
 * receipt has a parseable date, the `transaction_date ± DATE_WINDOW_DAYS` predicate
 * is applied; when it does not, the date predicate is dropped (amount-only) — the
 * confidence step then refuses to auto-attach a dateless candidate. Ordered by
 * closest amount then closest date. Returns at most 10 rows.
 */
async function queryCandidates(
  env: Env,
  args: {
    cardholderId: string;
    total: number;
    tolerance: number;
    statusPlaceholders: string;
    receiptIso: string | null;
  },
): Promise<CandidateRow[]> {
  const { cardholderId, total, tolerance, statusPlaceholders, receiptIso } = args;

  const where = [
    "cardholder_id = ?",
    "is_payment = 0",
    `receipt_status IN (${statusPlaceholders})`,
    "abs(amount - ?) <= ?",
  ];
  const binds: unknown[] = [cardholderId, ...OPEN_STATUSES, total, tolerance];

  if (receiptIso) {
    where.push("transaction_date >= ?", "transaction_date <= ?");
    binds.push(shiftIso(receiptIso, -DATE_WINDOW_DAYS), shiftIso(receiptIso, DATE_WINDOW_DAYS));
  }

  // ORDER BY closest amount, then closest date when we have one.
  const orderDate = receiptIso
    ? ", abs(julianday(transaction_date) - julianday(?)) ASC"
    : "";
  const sql =
    `SELECT id, vendor, amount, transaction_date, receipt_status
       FROM cc_transactions
      WHERE ${where.join(" AND ")}
      ORDER BY abs(amount - ?) ASC${orderDate}
      LIMIT 10`;
  const orderBinds: unknown[] = [total];
  if (receiptIso) orderBinds.push(receiptIso);

  const res = await env.DB.prepare(sql)
    .bind(...binds, ...orderBinds)
    .all<CandidateRow>();
  return res.results ?? [];
}
