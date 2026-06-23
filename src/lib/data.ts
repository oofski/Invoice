import { createAdminClient } from "@/lib/supabase/admin";
import type {
  InvoiceWithRelations,
  InvoiceRow,
  LineItemRow,
  ApprovalRow,
  UserRow,
} from "@/lib/types";

/**
 * Shared server-side data-access helpers used by multiple route handlers.
 * All use the service-role client; callers MUST enforce role/visibility first.
 */

/** Loads an invoice with its line items, approval, submitter and audit log. */
export async function getInvoiceWithRelations(
  invoiceId: string,
  opts: { includeAudit?: boolean } = {},
): Promise<InvoiceWithRelations | null> {
  const admin = createAdminClient();

  const { data: invoice } = await admin
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return null;

  const [{ data: lineItems }, { data: approval }, submitter] =
    await Promise.all([
      admin
        .from("line_items")
        .select("*")
        .eq("invoice_id", invoiceId)
        .order("sort_order", { ascending: true }),
      admin
        .from("approvals")
        .select("*")
        .eq("invoice_id", invoiceId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      (invoice as InvoiceRow).submitted_by
        ? admin
            .from("users")
            .select("id,name,email,role")
            .eq("id", (invoice as InvoiceRow).submitted_by!)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  let audit_log;
  if (opts.includeAudit) {
    const { data } = await admin
      .from("audit_log")
      .select("*")
      .eq("invoice_id", invoiceId)
      .order("created_at", { ascending: false });
    audit_log = data ?? [];
  }

  return {
    ...(invoice as InvoiceRow),
    line_items: (lineItems as LineItemRow[]) ?? [],
    approval: (approval as ApprovalRow) ?? null,
    submitter: (submitter as { data: UserRow | null }).data,
    ...(opts.includeAudit ? { audit_log } : {}),
  };
}

/** Finds the active executive user whose name matches an approver name. */
export async function resolveApproverUser(
  approverName: string,
): Promise<UserRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("users")
    .select("*")
    .eq("name", approverName)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as UserRow) ?? null;
}

/** True if the invoice has any unresolved manual-review line item (§13). */
export async function hasUnresolvedManualReview(
  invoiceId: string,
): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from("line_items")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", invoiceId)
    .eq("requires_review", true);
  return count ?? 0;
}
