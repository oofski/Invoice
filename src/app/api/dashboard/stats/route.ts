import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { hoursSince } from "@/lib/utils";
import { INVOICE_STATUS, OVERDUE_HOURS, ROLES } from "@/lib/constants";
import type { DashboardStats, InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/stats — six stat cards + entity/status breakdowns
 * (Brief §07/§08). Auth: accountant, admin.
 */
export const GET = withErrorHandling(async (_request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const admin = createAdminClient();

  const [{ data: invoiceData }, { data: reviewData }] = await Promise.all([
    admin
      .from("invoices")
      .select("id,status,business,total_amount,exported_at,created_at"),
    admin.from("line_items").select("invoice_id").eq("requires_review", true),
  ]);

  const invoices = (invoiceData as InvoiceRow[]) ?? [];
  const reviewInvoiceIds = new Set(
    ((reviewData as { invoice_id: string }[]) ?? []).map((r) => r.invoice_id),
  );

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let totalPending = 0;
  let awaitingApproval = 0;
  let exportReady = 0;
  let rejected = 0;
  let exportedThisMonth = 0;
  let overdueCount = 0;

  const byEntity: Record<string, { count: number; total: number }> = {};
  const byStatus: Record<string, number> = {};

  for (const i of invoices) {
    byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;

    const entity = i.business || "Unassigned";
    byEntity[entity] = byEntity[entity] ?? { count: 0, total: 0 };
    byEntity[entity].count += 1;
    byEntity[entity].total += Number(i.total_amount ?? 0);

    if (
      i.status === INVOICE_STATUS.PROCESSING ||
      i.status === INVOICE_STATUS.PENDING_APPROVAL
    ) {
      totalPending += 1;
    }
    if (i.status === INVOICE_STATUS.PENDING_APPROVAL) {
      awaitingApproval += 1;
      if (hoursSince(i.created_at) >= OVERDUE_HOURS) overdueCount += 1;
    }
    if (i.status === INVOICE_STATUS.APPROVED && !reviewInvoiceIds.has(i.id)) {
      exportReady += 1;
    }
    if (i.status === INVOICE_STATUS.REJECTED) rejected += 1;
    if (
      i.status === INVOICE_STATUS.EXPORTED &&
      i.exported_at &&
      new Date(i.exported_at) >= monthStart
    ) {
      exportedThisMonth += 1;
    }
  }

  const needsReview = reviewInvoiceIds.size;

  const stats: DashboardStats = {
    totalPending,
    awaitingApproval,
    needsReview,
    exportReady,
    rejected,
    exportedThisMonth,
    overdueCount,
    byEntity: Object.entries(byEntity).map(([entity, v]) => ({
      entity,
      count: v.count,
      total: v.total,
    })),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({
      status,
      count,
    })),
  };

  return ok(stats);
});
