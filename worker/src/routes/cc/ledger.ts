/**
 * CCRMS accountant ledger route (NEW).
 *
 *   - GET /ledger?cycle_start&cycle_end — manager/CC-accountant-only per-cardholder
 *     split-matrix ledger for one statement cycle. Reproduces the accountant's
 *     manual per-cardholder workbook (one section per cardholder + a Summary
 *     rollup) from `cc_transactions` pivoted against `cc_entity_splits`.
 *
 * §2 preamble (identical to `dashboard.ts`): flag gate (404), migration gate
 * (503), manager role gate (403). Cycle resolution is identical to
 * `dashboard.ts` /summary: explicit query → latest batch period → last 30 days.
 *
 * Universe mirrors the dashboard EXACTLY (in-cycle on `transaction_date`,
 * `is_payment = 0`, credits kept, archived kept) so ledger totals reconcile with
 * the dashboard KPIs. The per-entity pivot reads ONLY `cc_entity_splits` (the
 * authoritative allocation — line coding re-derives it), joined to
 * `cc_transactions` (the `dashboard.ts` "spend by entity" idiom WITHOUT its
 * GROUP BY so we keep per-tx rows), then assembled in JS.
 *
 * The mounter imports this file by the fixed name `ledger`
 * (`cc.route("/ledger", ledger)`).
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { roundCents } from "../../cc/ccRules";
import { CC_ENTITY_ORDER, ccEntityLabel } from "../../cc/ccConstants";
import { isCcEnabled, ccReady } from "../../cc/flag";

export const ledger = new Hono<AppEnv>();

const MIGRATION_MSG =
  "Credit Cards needs a one-time database setup — run the migration.";

/** Builds the "CapOne ••2277 / Amex ••36158" card label for a cardholder. */
function cardLabel(capLast4: string | null, amexLast5: string | null): string {
  const parts: string[] = [];
  if (capLast4) parts.push(`CapOne ••${capLast4}`);
  if (amexLast5) parts.push(`Amex ••${amexLast5}`);
  return parts.join(" / ");
}

// ----- Response shapes (PINNED — the renderer's CcLedgerResponse mirrors these) -

interface LedgerEntityColumn {
  entity_name: string;
  label: string;
}

interface LedgerRow {
  transaction_id: string;
  have_receipt: boolean;
  in_qb: boolean;
  date: string; // transaction_date (YYYY-MM-DD)
  vendor: string;
  charge: number;
  entities: Record<string, number>; // omits blank entities
  total: number;
  difference: number;
  notes: string | null;
}

interface LedgerCardholder {
  cardholder_id: string | null;
  name: string;
  card: string;
  tab_name: string; // "<name> <last4>"
  rows: LedgerRow[];
  totals: {
    per_entity: Record<string, number>;
    total: number;
    difference: number;
  };
}

interface LedgerSummaryCardholder {
  cardholder_id: string | null;
  name: string;
  card: string;
  total: number;
  difference: number;
}

interface LedgerSummary {
  per_cardholder: LedgerSummaryCardholder[];
  per_entity_totals: Record<string, number>;
  grand_total: number;
  grand_difference: number;
}

// Internal accumulator per cardholder group.
interface Group {
  cardholder_id: string | null;
  name: string;
  card: string;
  tab_name: string;
  rows: LedgerRow[];
  perEntity: Record<string, number>;
  chargeSum: number;
}

const UNMATCHED_KEY = "__unmatched__";

// ----- GET /ledger (manager only) -------------------------------------
ledger.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  // ----- Resolve the cycle window (identical to dashboard /summary) ----
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

  const cycleParams = [cycleStart, cycleEnd];
  const inCycle =
    "transaction_date >= ? AND transaction_date <= ? AND is_payment = 0";

  // ----- In-cycle, non-payment transactions (archived kept) ------------
  // LEFT JOIN so UNMATCHED (NULL cardholder) rows still surface. Ordered by
  // date/created_at so per-cardholder rows land in statement order; cardholder
  // grouping + name ordering is applied in JS below.
  const txRows = await c.env.DB.prepare(
    `SELECT
        t.id               AS transaction_id,
        t.cardholder_id    AS cardholder_id,
        t.transaction_date AS transaction_date,
        t.vendor           AS vendor,
        t.amount           AS amount,
        t.receipt_status   AS receipt_status,
        t.in_qb            AS in_qb,
        t.notes            AS notes,
        t.created_at       AS created_at,
        ch.first_name      AS first_name,
        ch.last_name       AS last_name,
        ch.cap_one_last4   AS cap_one_last4,
        ch.amex_last5      AS amex_last5
       FROM cc_transactions t
       LEFT JOIN cc_cardholders ch ON ch.id = t.cardholder_id
      WHERE t.${inCycle}
      ORDER BY t.transaction_date ASC, t.created_at ASC`,
  )
    .bind(...cycleParams)
    .all<{
      transaction_id: string;
      cardholder_id: string | null;
      transaction_date: string;
      vendor: string;
      amount: number;
      receipt_status: string;
      in_qb: number;
      notes: string | null;
      created_at: string;
      first_name: string | null;
      last_name: string | null;
      cap_one_last4: string | null;
      amex_last5: string | null;
    }>();

  // ----- Per-tx entity pivot (the dashboard join, WITHOUT GROUP BY) ----
  const splitRows = await c.env.DB.prepare(
    `SELECT s.transaction_id AS transaction_id,
            s.entity_name    AS entity_name,
            s.amount         AS amount
       FROM cc_entity_splits s
       JOIN cc_transactions t ON t.id = s.transaction_id
      WHERE t.${inCycle}`,
  )
    .bind(...cycleParams)
    .all<{ transaction_id: string; entity_name: string; amount: number }>();

  const splitsByTx = new Map<string, Record<string, number>>();
  for (const s of splitRows.results ?? []) {
    let map = splitsByTx.get(s.transaction_id);
    if (!map) {
      map = {};
      splitsByTx.set(s.transaction_id, map);
    }
    map[s.entity_name] = roundCents((map[s.entity_name] ?? 0) + (s.amount ?? 0));
  }

  // ----- Assemble cardholder groups ------------------------------------
  const groups = new Map<string, Group>();

  for (const t of txRows.results ?? []) {
    const key = t.cardholder_id ?? UNMATCHED_KEY;
    let g = groups.get(key);
    if (!g) {
      const name =
        `${t.first_name ?? ""} ${t.last_name ?? ""}`.trim() || "UNMATCHED";
      const last4 = t.cap_one_last4 ?? t.amex_last5;
      g = {
        cardholder_id: t.cardholder_id,
        name,
        card: cardLabel(t.cap_one_last4, t.amex_last5),
        tab_name: last4 ? `${name} ${last4}` : name,
        rows: [],
        perEntity: {},
        chargeSum: 0,
      };
      groups.set(key, g);
    }

    const entities = splitsByTx.get(t.transaction_id) ?? {};
    const charge = roundCents(t.amount ?? 0);
    let rowTotal = 0;
    for (const v of Object.values(entities)) rowTotal += v;
    const total = roundCents(rowTotal);

    g.rows.push({
      transaction_id: t.transaction_id,
      have_receipt:
        t.receipt_status === "RECEIVED" || t.receipt_status === "UPLOADED",
      in_qb: t.in_qb === 1,
      date: t.transaction_date,
      vendor: t.vendor,
      charge,
      entities,
      total,
      difference: roundCents(charge - total),
      notes: t.notes,
    });

    for (const [entity, amt] of Object.entries(entities)) {
      g.perEntity[entity] = roundCents((g.perEntity[entity] ?? 0) + amt);
    }
    g.chargeSum = roundCents(g.chargeSum + charge);
  }

  // Order: matched cardholders by name (case-insensitive), UNMATCHED last.
  const ordered: Group[] = [];
  const matched = [...groups.values()].filter((g) => g.cardholder_id !== null);
  matched.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
  ordered.push(...matched);
  const unmatched = groups.get(UNMATCHED_KEY);
  if (unmatched) ordered.push(unmatched);

  // ----- Build response + cross-cardholder summary ---------------------
  const entityColumns: LedgerEntityColumn[] = CC_ENTITY_ORDER.map((entity) => ({
    entity_name: entity,
    label: ccEntityLabel(entity),
  }));

  const perCardholderSummary: LedgerSummaryCardholder[] = [];
  const perEntityTotals: Record<string, number> = {};
  let grandTotalAcc = 0;
  let grandDifferenceAcc = 0;

  const cardholders: LedgerCardholder[] = ordered.map((g) => {
    let entityTotal = 0;
    for (const v of Object.values(g.perEntity)) entityTotal += v;
    const total = roundCents(entityTotal);
    const difference = roundCents(g.chargeSum - total);

    for (const [entity, amt] of Object.entries(g.perEntity)) {
      perEntityTotals[entity] = roundCents((perEntityTotals[entity] ?? 0) + amt);
    }
    grandTotalAcc = roundCents(grandTotalAcc + total);
    grandDifferenceAcc = roundCents(grandDifferenceAcc + difference);

    perCardholderSummary.push({
      cardholder_id: g.cardholder_id,
      name: g.name,
      card: g.card,
      total,
      difference,
    });

    return {
      cardholder_id: g.cardholder_id,
      name: g.name,
      card: g.card,
      tab_name: g.tab_name,
      rows: g.rows,
      totals: { per_entity: g.perEntity, total, difference },
    };
  });

  const summary: LedgerSummary = {
    per_cardholder: perCardholderSummary,
    per_entity_totals: perEntityTotals,
    grand_total: grandTotalAcc,
    grand_difference: grandDifferenceAcc,
  };

  return c.json({
    cycle_start: cycleStart,
    cycle_end: cycleEnd,
    entity_columns: entityColumns,
    cardholders,
    summary,
  });
});
