/**
 * CCRMS dashboard route (NEW — Agent A3).
 *
 *   - GET /dashboard/summary — manager-only cycle rollup. The cycle defaults to
 *     the latest upload batch's period (else the last 30 days). Aggregates over
 *     in-cycle, NON-PAYMENT transactions: totals, per-cardholder receipt
 *     progress (with `last_notified_at`), and a recent-activity feed.
 *
 * §2 preamble: flag gate (404), migration gate (503), manager role gate (403).
 * The mounter (A2) imports this file by the fixed name `dashboard`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { roundCents } from "../../cc/ccRules";
import { ccEntityLabel } from "../../cc/ccConstants";
import { isCcEnabled, ccReady } from "../../cc/flag";

export const dashboard = new Hono<AppEnv>();

const MIGRATION_MSG =
  "Credit Cards needs a one-time database setup — run the migration.";

interface CardholderBreakdown {
  cardholder_id: string;
  name: string;
  card: string;
  open: number;
  received: number;
  pct_complete: number;
  last_notified_at: string | null;
}

interface RecentActivity {
  type: string;
  text: string;
  at: string;
}

/** Formats a number as `$X.XX` for activity text. */
function money(n: number): string {
  return `$${roundCents(n).toFixed(2)}`;
}

/** Builds the "CapOne ••2277 / Amex ••36158" card label for a cardholder. */
function cardLabel(capLast4: string | null, amexLast5: string | null): string {
  const parts: string[] = [];
  if (capLast4) parts.push(`CapOne ••${capLast4}`);
  if (amexLast5) parts.push(`Amex ••${amexLast5}`);
  return parts.join(" / ");
}

// ----- GET /summary (manager only) ------------------------------------
dashboard.get("/summary", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  // ----- Resolve the cycle window -------------------------------------
  // Explicit query overrides; else the latest batch period; else last 30 days.
  let cycleStart = c.req.query("cycle_start") ?? null;
  let cycleEnd = c.req.query("cycle_end") ?? null;

  if (!cycleStart || !cycleEnd) {
    const latest = await c.env.DB.prepare(
      `SELECT period_start, period_end
         FROM cc_upload_batches
        WHERE period_start IS NOT NULL AND period_end IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ period_start: string | null; period_end: string | null }>();
    if (latest?.period_start && latest?.period_end) {
      cycleStart = cycleStart ?? latest.period_start;
      cycleEnd = cycleEnd ?? latest.period_end;
    }
  }
  if (!cycleStart || !cycleEnd) {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 3_600_000);
    cycleStart = cycleStart ?? start.toISOString().slice(0, 10);
    cycleEnd = cycleEnd ?? now.toISOString().slice(0, 10);
  }

  // In-cycle, non-payment transactions are the universe for every aggregate.
  // (Credits are kept — they count toward spend/total visibility; only true
  // card payments are excluded.)
  const cycleParams = [cycleStart, cycleEnd];
  const inCycle =
    "transaction_date >= ? AND transaction_date <= ? AND is_payment = 0 AND archived_at IS NULL";

  // ----- Headline totals ----------------------------------------------
  const totalsRow = await c.env.DB.prepare(
    `SELECT
        COUNT(*) AS total_transactions,
        SUM(CASE WHEN receipt_status IN ('RECEIVED','UPLOADED') THEN 1 ELSE 0 END) AS receipts_received,
        SUM(CASE WHEN receipt_status = 'PENDING' THEN 1 ELSE 0 END) AS receipts_pending,
        COALESCE(SUM(amount), 0) AS total_spend
      FROM cc_transactions
      WHERE ${inCycle}`,
  )
    .bind(...cycleParams)
    .first<{
      total_transactions: number;
      receipts_received: number;
      receipts_pending: number;
      total_spend: number;
    }>();

  const totalTransactions = totalsRow?.total_transactions ?? 0;
  const receiptsReceived = totalsRow?.receipts_received ?? 0;
  const receiptsPending = totalsRow?.receipts_pending ?? 0;
  const totalSpend = roundCents(totalsRow?.total_spend ?? 0);

  // ----- Per-cardholder breakdown -------------------------------------
  // "open" = still-pending receipts; "received" = received-or-uploaded. Joined
  // so even cardholders with rows but no matched name still surface. Inactive
  // cardholders are kept if they carry in-cycle transactions (historical view).
  const breakdownRows = await c.env.DB.prepare(
    `SELECT
        ch.id   AS cardholder_id,
        trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) AS name,
        ch.cap_one_last4 AS cap_one_last4,
        ch.amex_last5    AS amex_last5,
        SUM(CASE WHEN t.receipt_status = 'PENDING' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN t.receipt_status IN ('RECEIVED','UPLOADED') THEN 1 ELSE 0 END) AS received,
        COUNT(*) AS total
      FROM cc_transactions t
      JOIN cc_cardholders ch ON ch.id = t.cardholder_id
      WHERE t.transaction_date >= ? AND t.transaction_date <= ? AND t.is_payment = 0 AND t.archived_at IS NULL
      GROUP BY ch.id
      ORDER BY open DESC, name ASC`,
  )
    .bind(...cycleParams)
    .all<{
      cardholder_id: string;
      name: string;
      cap_one_last4: string | null;
      amex_last5: string | null;
      open: number;
      received: number;
      total: number;
    }>();

  // Latest notification timestamp per cardholder (across all time).
  const notifRows = await c.env.DB.prepare(
    `SELECT cardholder_id, MAX(created_at) AS last_notified_at
       FROM cc_notifications
      GROUP BY cardholder_id`,
  ).all<{ cardholder_id: string; last_notified_at: string | null }>();
  const lastNotified = new Map<string, string | null>();
  for (const r of notifRows.results ?? []) {
    lastNotified.set(r.cardholder_id, r.last_notified_at);
  }

  const cardholderBreakdown: CardholderBreakdown[] = (breakdownRows.results ?? []).map(
    (r) => {
      const total = r.total ?? 0;
      const received = r.received ?? 0;
      const pct = total > 0 ? roundCents((received / total) * 100) : 0;
      return {
        cardholder_id: r.cardholder_id,
        name: (r.name || "").trim() || "UNMATCHED",
        card: cardLabel(r.cap_one_last4, r.amex_last5),
        open: r.open ?? 0,
        received,
        pct_complete: pct,
        last_notified_at: lastNotified.get(r.cardholder_id) ?? null,
      };
    },
  );

  // ----- Recent activity feed -----------------------------------------
  // Two streams merged + sorted by time: receipts uploaded and reminders sent.
  const recentActivity: RecentActivity[] = [];

  const recentReceipts = await c.env.DB.prepare(
    `SELECT r.created_at AS at, r.file_name AS file_name,
            t.vendor AS vendor, t.amount AS amount,
            trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) AS name
       FROM cc_receipts r
       JOIN cc_transactions t ON t.id = r.transaction_id
       LEFT JOIN cc_cardholders ch ON ch.id = t.cardholder_id
      ORDER BY r.created_at DESC LIMIT 10`,
  ).all<{
    at: string;
    file_name: string;
    vendor: string;
    amount: number;
    name: string | null;
  }>();
  for (const r of recentReceipts.results ?? []) {
    const who = (r.name || "").trim() || "Someone";
    recentActivity.push({
      type: "RECEIPT_UPLOADED",
      text: `${who} uploaded a receipt for ${r.vendor} ${money(r.amount)}`,
      at: r.at,
    });
  }

  const recentNotifs = await c.env.DB.prepare(
    `SELECT n.created_at AS at, n.delivery AS delivery,
            trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) AS name
       FROM cc_notifications n
       LEFT JOIN cc_cardholders ch ON ch.id = n.cardholder_id
      ORDER BY n.created_at DESC LIMIT 10`,
  ).all<{ at: string; delivery: string; name: string | null }>();
  for (const r of recentNotifs.results ?? []) {
    const who = (r.name || "").trim() || "a cardholder";
    recentActivity.push({
      type: "REMINDER_SENT",
      text: `Reminder sent to ${who}`,
      at: r.at,
    });
  }

  recentActivity.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const recentActivityTop = recentActivity.slice(0, 15);

  return c.json({
    total_transactions: totalTransactions,
    receipts_received: receiptsReceived,
    receipts_pending: receiptsPending,
    total_spend: totalSpend,
    cardholder_breakdown: cardholderBreakdown,
    recent_activity: recentActivityTop,
  });
});

// ----- analytics helpers ----------------------------------------------

/** Clamp a query int to [min,max], falling back to `def` when absent/invalid. */
function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Build the trailing-N-months window ending in the current calendar month.
 * Returns the ordered "YYYY-MM" keys (oldest→newest) and the first-of-month
 * lower-bound date ("YYYY-MM-01") for a `>=` SQL filter.
 */
function trailingMonths(months: number): { keys: string[]; startDate: string } {
  const now = new Date();
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return { keys, startDate: `${keys[0]}-01` };
}

interface CcMonthlyPoint {
  month: string;
  spend: number;
  tx_count: number;
  receipts_received: number;
  receipts_total: number;
  completion_pct: number;
}

// ----- GET /analytics (manager only) ----------------------------------
// Cycle-scoped KPIs + entity/category donuts, plus a trailing-N-months combo
// series (spend bars + receipt-completion% line) that spans cycles. The universe
// mirrors /summary EXACTLY (in-cycle, is_payment = 0, credits kept, archived
// excluded) so Total Spend / counts reconcile with the summary KPI cards. The
// monthly series is trailing-N-months regardless of the selected cycle.
dashboard.get("/analytics", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  // ----- Resolve the cycle window (identical to /summary) --------------
  let cycleStart = c.req.query("cycle_start") ?? null;
  let cycleEnd = c.req.query("cycle_end") ?? null;
  if (!cycleStart || !cycleEnd) {
    const latest = await c.env.DB.prepare(
      `SELECT period_start, period_end
         FROM cc_upload_batches
        WHERE period_start IS NOT NULL AND period_end IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ period_start: string | null; period_end: string | null }>();
    if (latest?.period_start && latest?.period_end) {
      cycleStart = cycleStart ?? latest.period_start;
      cycleEnd = cycleEnd ?? latest.period_end;
    }
  }
  if (!cycleStart || !cycleEnd) {
    const now = new Date();
    const start = new Date(now.getTime() - 30 * 24 * 3_600_000);
    cycleStart = cycleStart ?? start.toISOString().slice(0, 10);
    cycleEnd = cycleEnd ?? now.toISOString().slice(0, 10);
  }
  const cycleParams = [cycleStart, cycleEnd];
  const inCycle =
    "transaction_date >= ? AND transaction_date <= ? AND is_payment = 0 AND archived_at IS NULL";

  const months = clampInt(c.req.query("months"), 12, 1, 24);

  // ----- KPIs (cycle-scoped, non-payment) -----------------------------
  const kpiRow = await c.env.DB.prepare(
    `SELECT
        COUNT(*) AS total_transactions,
        SUM(CASE WHEN in_qb = 1 THEN 1 ELSE 0 END) AS in_qb_count,
        SUM(CASE WHEN in_qb = 0 THEN 1 ELSE 0 END) AS not_in_qb_count,
        SUM(CASE WHEN cardholder_id IS NULL THEN 1 ELSE 0 END) AS unmatched_count
      FROM cc_transactions
      WHERE ${inCycle}`,
  )
    .bind(...cycleParams)
    .first<{
      total_transactions: number;
      in_qb_count: number;
      not_in_qb_count: number;
      unmatched_count: number;
    }>();

  const kpis = {
    total_transactions: kpiRow?.total_transactions ?? 0,
    in_qb_count: kpiRow?.in_qb_count ?? 0,
    not_in_qb_count: kpiRow?.not_in_qb_count ?? 0,
    unmatched_count: kpiRow?.unmatched_count ?? 0,
  };

  // ----- Monthly combo series (trailing N months, non-payment) --------
  const { keys, startDate } = trailingMonths(months);
  const monthlyRows = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', transaction_date) AS month,
            COALESCE(SUM(amount), 0) AS spend,
            COUNT(*) AS tx_count,
            SUM(CASE WHEN receipt_status IN ('RECEIVED','UPLOADED') THEN 1 ELSE 0 END) AS receipts_received
       FROM cc_transactions
      WHERE transaction_date >= ? AND is_payment = 0 AND archived_at IS NULL
      GROUP BY month`,
  )
    .bind(startDate)
    .all<{ month: string; spend: number; tx_count: number; receipts_received: number }>();

  const byMonth = new Map<string, { spend: number; tx_count: number; receipts_received: number }>();
  for (const r of monthlyRows.results ?? []) {
    byMonth.set(r.month, {
      spend: r.spend ?? 0,
      tx_count: r.tx_count ?? 0,
      receipts_received: r.receipts_received ?? 0,
    });
  }
  const monthly: CcMonthlyPoint[] = keys.map((month) => {
    const row = byMonth.get(month);
    const txCount = row?.tx_count ?? 0;
    const received = row?.receipts_received ?? 0;
    return {
      month,
      spend: roundCents(row?.spend ?? 0),
      tx_count: txCount,
      receipts_received: received,
      receipts_total: txCount,
      completion_pct: txCount > 0 ? roundCents((received / txCount) * 100) : 0,
    };
  });

  // ----- Spend by entity (cycle-scoped, from cc_entity_splits) --------
  const entityRows = await c.env.DB.prepare(
    `SELECT s.entity_name AS entity_name, COALESCE(SUM(s.amount), 0) AS spend
       FROM cc_entity_splits s
       JOIN cc_transactions t ON t.id = s.transaction_id
      WHERE t.transaction_date >= ? AND t.transaction_date <= ? AND t.is_payment = 0 AND t.archived_at IS NULL
      GROUP BY s.entity_name
      ORDER BY spend DESC`,
  )
    .bind(...cycleParams)
    .all<{ entity_name: string; spend: number }>();
  const byEntity = (entityRows.results ?? []).map((r) => ({
    entity_name: r.entity_name,
    label: ccEntityLabel(r.entity_name),
    spend: roundCents(r.spend ?? 0),
  }));

  // ----- Spend by category (cycle-scoped, non-payment) ----------------
  const categoryRows = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
            COALESCE(SUM(amount), 0) AS spend
       FROM cc_transactions
      WHERE ${inCycle}
      GROUP BY category
      ORDER BY spend DESC`,
  )
    .bind(...cycleParams)
    .all<{ category: string; spend: number }>();
  const byCategory = (categoryRows.results ?? []).map((r) => ({
    category: r.category,
    spend: roundCents(r.spend ?? 0),
  }));

  return c.json({
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    months,
    kpis,
    monthly,
    by_entity: byEntity,
    by_category: byCategory,
  });
});
