import { createAdminClient } from "@/lib/supabase/admin";
import type { AuditAction } from "@/lib/constants";

interface AuditEntry {
  invoiceId?: string | null;
  userId?: string | null;
  action: AuditAction | string;
  prevValue?: unknown;
  newValue?: unknown;
  note?: string | null;
}

/**
 * Writes one audit_log row. Brief §13 requires an entry on EVERY state change
 * (status change, GL override, approval, rejection, reminder, export) with
 * user_id, previous_value and new_value captured as JSONB.
 *
 * Uses the service-role client so audit writes never fail due to RLS and are
 * tamper-resistant from the client side.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("audit_log").insert({
    invoice_id: entry.invoiceId ?? null,
    user_id: entry.userId ?? null,
    action: entry.action,
    prev_value: entry.prevValue ?? null,
    new_value: entry.newValue ?? null,
    note: entry.note ?? null,
  });
  if (error) {
    // Audit failures should be loud but must not break the primary operation.
    console.error("[audit] failed to write audit_log entry:", error.message);
  }
}
