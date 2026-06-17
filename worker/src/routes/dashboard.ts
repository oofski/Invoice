import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { isStaffOrAdmin } from "./helpers";
import { hoursSince } from "../lib/util";
import { INVOICE_STATUS, OVERDUE_HOURS } from "../lib/constants";
import type { InvoiceRow } from "../lib/types";

export const dashboard = new Hono<AppEnv>();

dashboard.get("/stats", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);

  const invRows = await c.env.DB.prepare(
    "SELECT id, status, business, total_amount, exported_at, created_at FROM invoices",
  ).all<InvoiceRow>();
  const reviewRows = await c.env.DB.prepare(
    "SELECT DISTINCT invoice_id FROM line_items WHERE requires_review = 1",
  ).all<{ invoice_id: string }>();

  const invoices = invRows.results ?? [];
  const reviewIds = new Set((reviewRows.results ?? []).map((r) => r.invoice_id));
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  let totalPending = 0, awaitingApproval = 0, exportReady = 0, rejected = 0,
    exportedThisMonth = 0, overdueCount = 0;
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
    if (i.status === INVOICE_STATUS.APPROVED && !reviewIds.has(i.id)) exportReady++;
    if (i.status === INVOICE_STATUS.REJECTED) rejected++;
    if (i.status === INVOICE_STATUS.EXPORTED && i.exported_at && new Date(i.exported_at) >= monthStart)
      exportedThisMonth++;
  }

  return c.json({
    totalPending, awaitingApproval, needsReview: reviewIds.size, exportReady,
    rejected, exportedThisMonth, overdueCount,
    byEntity: Object.entries(byEntity).map(([entity, v]) => ({ entity, count: v.count, total: v.total })),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
  });
});
