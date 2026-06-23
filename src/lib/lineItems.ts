import { createAdminClient } from "@/lib/supabase/admin";
import { canViewInvoice } from "@/lib/visibility";
import { ROLES } from "@/lib/constants";
import type { LineItemRow, InvoiceRow, UserRow } from "@/lib/types";

/**
 * Loads a line item + its parent invoice and verifies the profile may edit it.
 * Execs may only edit line items on invoices routed to them; accountants and
 * admins may edit any.
 */
export async function loadEditableLineItem(
  lineItemId: string,
  profile: UserRow,
): Promise<
  | { ok: true; lineItem: LineItemRow; invoice: InvoiceRow }
  | { ok: false; status: number; error: string }
> {
  const admin = createAdminClient();
  const { data: lineItem } = await admin
    .from("line_items")
    .select("*")
    .eq("id", lineItemId)
    .maybeSingle();
  if (!lineItem) return { ok: false, status: 404, error: "Line item not found" };

  const { data: invoice } = await admin
    .from("invoices")
    .select("*")
    .eq("id", (lineItem as LineItemRow).invoice_id)
    .maybeSingle();
  if (!invoice)
    return { ok: false, status: 404, error: "Parent invoice not found" };

  const inv = invoice as InvoiceRow;
  const editableRole =
    profile.role === ROLES.ACCOUNTANT ||
    profile.role === ROLES.ADMIN ||
    profile.role === ROLES.EXECUTIVE ||
    profile.role === ROLES.STAFF;
  if (!editableRole || !(await canViewInvoice(profile, inv))) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  if (inv.status === "EXPORTED") {
    return {
      ok: false,
      status: 409,
      error: "Invoice already exported; line items are locked",
    };
  }

  return { ok: true, lineItem: lineItem as LineItemRow, invoice: inv };
}
