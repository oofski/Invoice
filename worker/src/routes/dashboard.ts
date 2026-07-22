import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin } from "./helpers";
import { hoursSince } from "../lib/util";
import { INVOICE_STATUS, OVERDUE_HOURS } from "../lib/constants";
import type { InvoiceRow } from "../lib/types";

export const dashboard = new Hono<AppEnv>();

dashboard.get("/stats", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);

  // Exclude archived (e.g. "Cleared") invoices so the KPI counters drop the
  // moment an invoice is archived — matching /analytics and the invoices list,
  // which already filter archived_at IS NULL. Gated on the archive migration
  // having run (archiveReady) so this is a no-op on pre-migration databases.
  const archived = await archiveReady(c.env);
  const invRows = await c.env.DB.prepare(
    `SELECT id, status, business, total_amount, exported_at, created_at FROM invoices${
      archived ? " WHERE archived_at IS NULL" : ""
    }`,
  ).all<InvoiceRow>();
  const reviewRows = await c.env.DB.prepare(
    archived
      ? `SELECT DISTINCT li.invoice_id AS invoice_id
           FROM line_items li
           JOIN invoices i ON i.id = li.invoice_id
          WHERE li.requires_review = 1 AND i.archived_at IS NULL`
      : "SELECT DISTINCT invoice_id FROM line_items WHERE requires_review = 1",
  ).all<{ invoice_id: string }>();

  const invoices = invRows.results ?? [];
  const reviewIds = new Set((reviewRows.results ?? []).map((r) => r.invoice_id));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  let totalPending = 0, awaitingApproval = 0, exportReady = 0, rejected = 0,
    exportedThisMonth = 0, overdueCount = 0, needsRouting = 0;
  const byEntity: Record<string, { count: number; total: number }> = {};
  const byStatus: Record<string, number> = {};

  for (const i of invoices) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    const entity = i.business || "Unassigned";
    byEntity[entity] = byEntity[entity] ?? { count: 0, total: 0 };
    byEntity[entity].count++;
    byEntity[entity].total += Number(i.total_amount ?? 0);

    if (i.status === INVOICE_STATUS.PROCESSING || i.status === INVOICE_STATUS.PENDING_APPROVAL) totalPending++;
    if (i.status === INVOICE_STATUS.PENDING_APPROVAL) {
      awaitingApproval++;
      if (hoursSince(i.created_at) >= OVERDUE_HOURS) overdueCount++;
    }
    if (i.status === INVOICE_STATUS.NEEDS_REVIEW) needsRouting++;
    if (i.status === INVOICE_STATUS.APPROVED && !reviewIds.has(i.id)) exportReady++;
    if (i.status === INVOICE_STATUS.REJECTED) rejected++;
    if (i.status === INVOICE_STATUS.EXPORTED && i.exported_at && new Date(i.exported_at) >= monthStart)
      exportedThisMonth++;
  }

  return c.json({
    totalPending, awaitingApproval, needsReview: reviewIds.size, needsRouting, exportReady,
    rejected, exportedThisMonth, overdueCount,
    byEntity: Object.entries(byEntity).map(([entity, v]) => ({ entity, count: v.count, total: v.total })),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
  });
});

// ----- analytics helpers ----------------------------------------------

/** Round to cents (money-safe compare with the rest of the app). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

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

/** True once the invoices.archived_at column exists (the F3 archive migration). */
async function archiveReady(env: AppEnv["Bindings"]): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT archived_at FROM invoices LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a period filter (created_at date-range + archive exclusion) for the
 * invoices table. `alias` qualifies the columns for JOIN queries ("" for none).
 * `date(created_at)` normalizes the ISO timestamp so `to` is day-inclusive.
 */
function periodFilter(
  alias: string,
  from: string | null,
  to: string | null,
  archived: boolean,
): { and: string; params: string[] } {
  const p = alias ? `${alias}.` : "";
  const clauses: string[] = [];
  const params: string[] = [];
  if (from) { clauses.push(`date(${p}created_at) >= ?`); params.push(from); }
  if (to) { clauses.push(`date(${p}created_at) <= ?`); params.push(to); }
  if (archived) clauses.push(`${p}archived_at IS NULL`);
  // v1.9.11 (M7): REJECTED invoices are never payable — exclude them from every
  // analytics rollup (Total AP, trend, entity/vendor/GL spend) so payables aren't
  // overstated. (PROCESSING is transient and left in; it becomes payable.)
  clauses.push(`${p}status != ?`); params.push(INVOICE_STATUS.REJECTED);
  return { and: clauses.length ? ` AND ${clauses.join(" AND ")}` : "", params };
}

// ----- GET /analytics --------------------------------------------------
// Server-side aggregations for the dashboard charts: period totals + entity /
// vendor / GL-category rollups (all scoped to ?from&to + archived exclusion),
// plus a trailing-N-months AP trend (independent of from/to, like the KPIs on
// /stats stay). SQL GROUP BY — never the LIMIT-500 list — so numbers are exact
// at any scale. Archived invoices are excluded by default (archived_at IS NULL).
dashboard.get("/analytics", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);

  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;
  const months = clampInt(c.req.query("months"), 12, 1, 24);
  const vendorLimit = clampInt(c.req.query("vendorLimit"), 8, 1, 50);
  const archived = await archiveReady(c.env);

  const period = periodFilter("", from, to, archived);

  // ----- Period totals -------------------------------------------------
  const totalsRow = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS total_spend, COUNT(*) AS invoice_count
       FROM invoices WHERE 1=1${period.and}`,
  )
    .bind(...period.params)
    .first<{ total_spend: number; invoice_count: number }>();
  const totalSpend = round2(totalsRow?.total_spend ?? 0);
  const invoiceCount = totalsRow?.invoice_count ?? 0;
  const totals = {
    total_spend: totalSpend,
    invoice_count: invoiceCount,
    avg_amount: invoiceCount > 0 ? round2(totalSpend / invoiceCount) : 0,
  };

  // ----- Monthly AP trend (trailing N months, archive-filtered) -------
  const { keys, startDate } = trailingMonths(months);
  const trend = periodFilter("", startDate, null, archived);
  const monthlyRows = await c.env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
            COALESCE(SUM(total_amount), 0) AS spend,
            COUNT(*) AS invoice_count
       FROM invoices WHERE 1=1${trend.and}
      GROUP BY month`,
  )
    .bind(...trend.params)
    .all<{ month: string; spend: number; invoice_count: number }>();
  const byMonth = new Map<string, { spend: number; invoice_count: number }>();
  for (const r of monthlyRows.results ?? []) {
    byMonth.set(r.month, { spend: r.spend ?? 0, invoice_count: r.invoice_count ?? 0 });
  }
  const monthly = keys.map((month) => {
    const row = byMonth.get(month);
    return {
      month,
      spend: round2(row?.spend ?? 0),
      invoice_count: row?.invoice_count ?? 0,
    };
  });

  // ----- Spend by entity (business) -----------------------------------
  const entityRows = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(business), ''), 'Unassigned') AS entity,
            COALESCE(SUM(total_amount), 0) AS spend,
            COUNT(*) AS count
       FROM invoices WHERE 1=1${period.and}
      GROUP BY entity
      ORDER BY spend DESC`,
  )
    .bind(...period.params)
    .all<{ entity: string; spend: number; count: number }>();
  const byEntity = (entityRows.results ?? []).map((r) => ({
    entity: r.entity,
    spend: round2(r.spend ?? 0),
    count: r.count ?? 0,
  }));

  // ----- Top vendors ---------------------------------------------------
  const vendorRows = await c.env.DB.prepare(
    // v1.9.11 (M16): group case/whitespace-insensitively so "Cintas", "cintas",
    // and "Cintas " collapse into one bar instead of splitting a vendor's spend
    // across rows. (Full alias/OCR-variant canonicalization is a larger change.)
    `SELECT MAX(vendor) AS vendor, COALESCE(SUM(total_amount), 0) AS spend, COUNT(*) AS count
       FROM invoices WHERE 1=1${period.and}
      GROUP BY lower(trim(vendor))
      ORDER BY spend DESC
      LIMIT ?`,
  )
    .bind(...period.params, vendorLimit)
    .all<{ vendor: string; spend: number; count: number }>();
  const topVendors = (vendorRows.results ?? []).map((r) => ({
    vendor: r.vendor,
    spend: round2(r.spend ?? 0),
    count: r.count ?? 0,
  }));

  // ----- Spend by GL category (line_items join) -----------------------
  const glPeriod = periodFilter("i", from, to, archived);
  const glRows = await c.env.DB.prepare(
    `SELECT COALESCE(NULLIF(TRIM(li.gl_category), ''), 'Uncategorized') AS category,
            COALESCE(SUM(li.amount), 0) AS spend
       FROM line_items li
       JOIN invoices i ON i.id = li.invoice_id
      WHERE 1=1${glPeriod.and}
        AND li.id NOT IN (SELECT split_parent_id FROM line_items WHERE split_parent_id IS NOT NULL)
      GROUP BY category
      ORDER BY spend DESC`,
  )
    .bind(...glPeriod.params)
    .all<{ category: string; spend: number }>();
  const byGlCategory = (glRows.results ?? []).map((r) => ({
    category: r.category,
    spend: round2(r.spend ?? 0),
  }));

  return c.json({
    from,
    to,
    months,
    totals,
    monthly,
    by_entity: byEntity,
    top_vendors: topVendors,
    by_gl_category: byGlCategory,
  });
});
