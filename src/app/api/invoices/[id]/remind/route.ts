import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendInvoiceReminder } from "@/lib/reminders";
import { ROLES } from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * POST /api/invoices/[id]/remind — send a reminder to the assigned exec.
 * Brief §07. Auth: accountant, admin.
 */
export const POST = withErrorHandling(
  async (_request: NextRequest, { params }: Ctx) => {
    const profile = await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
    const admin = createAdminClient();
    const { data: invoice } = await admin
      .from("invoices")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (!invoice) return fail("Invoice not found", 404);

    const sent = await sendInvoiceReminder(invoice as InvoiceRow, profile.id);
    if (!sent)
      return fail("No assigned approver with an email to remind", 422);
    return ok({ sent: true });
  },
);
