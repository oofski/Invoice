import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { sendReminderEmail } from "@/lib/email/resend";
import { resolveApproverUser } from "@/lib/data";
import { hoursSince } from "@/lib/utils";
import { AUDIT_ACTION } from "@/lib/constants";
import type { InvoiceRow, ApprovalRow, UserRow } from "@/lib/types";

/**
 * Sends a reminder email to the exec assigned to an invoice and records it on
 * the approval row + audit log. Returns false if no recipient could be found.
 */
export async function sendInvoiceReminder(
  invoice: InvoiceRow,
  actorUserId: string | null,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data: approval } = await admin
    .from("approvals")
    .select("*")
    .eq("invoice_id", invoice.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let recipient: UserRow | null = null;
  const appr = approval as ApprovalRow | null;
  if (appr?.assigned_to) {
    const { data } = await admin
      .from("users")
      .select("*")
      .eq("id", appr.assigned_to)
      .maybeSingle();
    recipient = (data as UserRow) ?? null;
  }
  if (!recipient && invoice.approved_by) {
    recipient = await resolveApproverUser(invoice.approved_by);
  }
  if (!recipient?.email) return false;

  await sendReminderEmail(
    recipient.email,
    {
      invoiceId: invoice.id,
      vendor: invoice.vendor,
      totalAmount: Number(invoice.total_amount),
      business: invoice.business,
      dueDate: invoice.due_date,
      invoiceNumber: invoice.invoice_number,
    },
    hoursSince(invoice.created_at),
  );

  if (appr) {
    await admin
      .from("approvals")
      .update({
        reminder_sent_at: new Date().toISOString(),
        reminder_count: (appr.reminder_count ?? 0) + 1,
      })
      .eq("id", appr.id);
  }

  await writeAudit({
    invoiceId: invoice.id,
    userId: actorUserId,
    action: AUDIT_ACTION.REMINDER_SENT,
    note: `Reminder sent to ${recipient.name} (${recipient.email})`,
  });

  return true;
}
