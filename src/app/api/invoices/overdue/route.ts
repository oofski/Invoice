import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { hoursSince } from "@/lib/utils";
import { INVOICE_STATUS, OVERDUE_HOURS, ROLES } from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoices/overdue — invoices PENDING_APPROVAL for over 72h
 * (Brief §07/§08). Auth: accountant, admin.
 */
export const GET = withErrorHandling(async (_request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);

  const cutoff = new Date(
    Date.now() - OVERDUE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("invoices")
    .select("*")
    .eq("status", INVOICE_STATUS.PENDING_APPROVAL)
    .lte("created_at", cutoff)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const invoices = ((data as InvoiceRow[]) ?? []).map((i) => ({
    ...i,
    hours_pending: Math.round(hoursSince(i.created_at)),
  }));
  return ok({ invoices, thresholdHours: OVERDUE_HOURS });
});
