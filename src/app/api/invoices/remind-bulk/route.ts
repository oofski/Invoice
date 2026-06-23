import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvoiceReminder } from "@/lib/reminders";
import { INVOICE_STATUS, OVERDUE_HOURS, ROLES } from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/remind-bulk — remind every exec with a 72h+ pending
 * invoice (Brief §07, Session 5). Auth: accountant, admin.
 */
export const POST = withErrorHandling(async (_request: NextRequest) => {
  const profile = await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const cutoff = new Date(
    Date.now() - OVERDUE_HOURS * 60 * 60 * 1000,
  ).toISOString();

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("invoices")
    .select("*")
    .eq("status", INVOICE_STATUS.PENDING_APPROVAL)
    .lte("created_at", cutoff);
  if (error) throw new Error(error.message);

  const invoices = (data as InvoiceRow[]) ?? [];
  let sent = 0;
  const failed: string[] = [];
  for (const invoice of invoices) {
    try {
      const ok2 = await sendInvoiceReminder(invoice, profile.id);
      if (ok2) sent++;
      else failed.push(invoice.id);
    } catch (err) {
      console.error("[remind-bulk] failed for", invoice.id, err);
      failed.push(invoice.id);
    }
  }

  return ok({ totalOverdue: invoices.length, sent, failed });
});
