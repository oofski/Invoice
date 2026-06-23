import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import {
  APPROVAL_STATUS,
  AUDIT_ACTION,
  INVOICE_STATUS,
  ROLES,
} from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * POST /api/invoices/[id]/approve — exec approves (Brief §07, Session 4).
 * Updates invoice + approval status, timestamps, writes audit.
 */
export const POST = withErrorHandling(
  async (_request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    const admin = createAdminClient();

    const { data: invoice } = await admin
      .from("invoices")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (!invoice) return fail("Invoice not found", 404);
    const inv = invoice as InvoiceRow;

    // Only the assigned exec (or an admin) may approve.
    const isAssignedExec =
      profile.role === ROLES.EXECUTIVE && inv.approved_by === profile.name;
    if (!isAssignedExec && profile.role !== ROLES.ADMIN) {
      return fail("Only the assigned executive can approve this invoice", 403);
    }
    if (inv.status === INVOICE_STATUS.EXPORTED) {
      return fail("Invoice already exported; cannot change approval", 409);
    }

    const now = new Date().toISOString();
    await admin
      .from("invoices")
      .update({ status: INVOICE_STATUS.APPROVED })
      .eq("id", params.id);
    await admin
      .from("approvals")
      .update({
        status: APPROVAL_STATUS.APPROVED,
        decided_at: now,
      })
      .eq("invoice_id", params.id);

    await writeAudit({
      invoiceId: params.id,
      userId: profile.id,
      action: AUDIT_ACTION.APPROVED,
      prevValue: { status: inv.status },
      newValue: { status: INVOICE_STATUS.APPROVED },
      note: `Approved by ${profile.name}`,
    });

    return ok({ status: INVOICE_STATUS.APPROVED });
  },
);
