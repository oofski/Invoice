import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRow } from "@/lib/types";
import { ROLES } from "@/lib/constants";

/**
 * Applies role-based row visibility to an invoices query (Brief §03):
 *  - accountant / admin: all invoices
 *  - executive: only invoices routed to them (approved_by = their name)
 *  - staff: only invoices they submitted
 */
export function scopeInvoiceQuery(
  // Supabase query builder is loosely typed; we just chain filters.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  profile: UserRow,
) {
  if (profile.role === ROLES.EXECUTIVE) {
    return query.eq("approved_by", profile.name);
  }
  if (profile.role === ROLES.STAFF) {
    return query.eq("submitted_by", profile.id);
  }
  // accountant + admin: no restriction
  return query;
}

/** Whether a profile may view a specific invoice. */
export async function canViewInvoice(
  profile: UserRow,
  invoice: { approved_by: string | null; submitted_by: string | null },
): Promise<boolean> {
  if (profile.role === ROLES.ACCOUNTANT || profile.role === ROLES.ADMIN)
    return true;
  if (profile.role === ROLES.EXECUTIVE)
    return invoice.approved_by === profile.name;
  if (profile.role === ROLES.STAFF)
    return invoice.submitted_by === profile.id;
  return false;
}

/** Returns a map of invoiceId -> count of unresolved manual-review items. */
export async function reviewCounts(
  invoiceIds: string[],
): Promise<Record<string, number>> {
  if (invoiceIds.length === 0) return {};
  const admin = createAdminClient();
  const { data } = await admin
    .from("line_items")
    .select("invoice_id")
    .in("invoice_id", invoiceIds)
    .eq("requires_review", true);
  const counts: Record<string, number> = {};
  for (const row of (data as { invoice_id: string }[]) ?? []) {
    counts[row.invoice_id] = (counts[row.invoice_id] ?? 0) + 1;
  }
  return counts;
}
