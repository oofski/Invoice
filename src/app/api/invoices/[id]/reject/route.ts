import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { sendRejectionEmail } from "@/lib/email/resend";
import {
  APPROVAL_STATUS,
  AUDIT_ACTION,
  INVOICE_STATUS,
  ROLES,
} from "@/lib/constants";
import type { InvoiceRow, UserRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * POST /api/invoices/[id]/reject — exec rejects; note is REQUIRED (Brief §07,
 * §13). Updates status, saves note, emails the accountant(s).
 *
 * Body: { "note": "reason for rejection" }
 */
export const POST = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    const body = await request.json().catch(() => ({}));
    const note = (body?.note as string | undefined)?.trim();
    if (!note) return fail("A rejection note is required", 400);

    const admin = createAdminClient();
    const { data: invoice } = await admin
      .from("invoices")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (!invoice) return fail("Invoice not found", 404);
    const inv = invoice as InvoiceRow;

    const isAssignedExec =
      profile.role === ROLES.EXECUTIVE && inv.approved_by === profile.name;
    if (!isAssignedExec && profile.role !== ROLES.ADMIN) {
      return fail("Only the assigned executive can reject this invoice", 403);
    }
    if (inv.status === INVOICE_STATUS.EXPORTED) {
      return fail("Invoice already exported; cannot reject", 409);
    }

    const now = new Date().toISOString();
    await admin
      .from("invoices")
      .update({ status: INVOICE_STATUS.REJECTED })
      .eq("id", params.id);
    await admin
      .from("approvals")
      .update({
        status: APPROVAL_STATUS.REJECTED,
        decision_note: note,
        decided_at: now,
      })
      .eq("invoice_id", params.id);

    await writeAudit({
      invoiceId: params.id,
      userId: profile.id,
      action: AUDIT_ACTION.REJECTED,
      prevValue: { status: inv.status },
      newValue: { status: INVOICE_STATUS.REJECTED },
      note: `Rejected by ${profile.name}: ${note}`,
    });

    // Notify accountants (Brief §07 reject -> notifies accountant).
    const { data: accountants } = await admin
      .from("users")
      .select("*")
      .eq("role", ROLES.ACCOUNTANT)
      .eq("is_active", true);
    for (const acc of (accountants as UserRow[]) ?? []) {
      try {
        await sendRejectionEmail(
          acc.email,
          {
            invoiceId: params.id,
            vendor: inv.vendor,
            totalAmount: Number(inv.total_amount),
            business: inv.business,
            dueDate: inv.due_date,
            invoiceNumber: inv.invoice_number,
          },
          profile.name,
          note,
        );
      } catch (err) {
        console.error("[reject] notify accountant failed:", err);
      }
    }

    return ok({ status: INVOICE_STATUS.REJECTED });
  },
);
