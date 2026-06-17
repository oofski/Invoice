import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { reviewCounts } from "@/lib/visibility";
import { INVOICE_STATUS, ROLES } from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoices/pending — all invoices pending approval, optionally filtered
 * by exec (?approver=Name). Brief §07. Auth: accountant, admin.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const approver = request.nextUrl.searchParams.get("approver");

  const admin = createAdminClient();
  let query = admin
    .from("invoices")
    .select("*")
    .eq("status", INVOICE_STATUS.PENDING_APPROVAL)
    .order("created_at", { ascending: true });
  if (approver) query = query.eq("approved_by", approver);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const invoices = (data as InvoiceRow[]) ?? [];
  const counts = await reviewCounts(invoices.map((i) => i.id));
  return ok({
    invoices: invoices.map((i) => ({ ...i, review_count: counts[i.id] ?? 0 })),
  });
});
