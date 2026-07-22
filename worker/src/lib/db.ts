import type {
  Env,
  InvoiceRow,
  LineItemRow,
  ApprovalRow,
  InvoiceAllocationRow,
  UserRow,
} from "./types";
import { uuid, parseJson, chunk } from "./util";
import { ROLES, glAccountNumber, REQUIRES_MANUAL_REVIEW } from "./constants";

/** Writes one audit_log row (Brief §13 — audit every state change). */
export async function audit(
  env: Env,
  entry: {
    invoiceId?: string | null;
    userId?: string | null;
    action: string;
    prevValue?: unknown;
    newValue?: unknown;
    note?: string | null;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (id, invoice_id, user_id, action, prev_value, new_value, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uuid(),
        entry.invoiceId ?? null,
        entry.userId ?? null,
        entry.action,
        entry.prevValue != null ? JSON.stringify(entry.prevValue) : null,
        entry.newValue != null ? JSON.stringify(entry.newValue) : null,
        entry.note ?? null,
      )
      .run();
  } catch (err) {
    console.error("[audit] failed:", err);
  }
}

/**
 * Converts a D1 line item row to an API-friendly object (booleans, etc.).
 * When `role` is EXECUTIVE the GL coding fields (gl_category, confidence_level,
 * logic_path) are omitted — executives never see the GL coding.
 */
export function hydrateLineItem(li: LineItemRow, role?: string) {
  const out = {
    ...li,
    requires_review: !!li.requires_review,
    manually_overridden: !!li.manually_overridden,
    // Derived (read-only): the entity-specific GL account number for this
    // line's category. Entity falls back to the line's own business (the UI
    // falls back to the invoice business when the line carries none).
    gl_account_number: glAccountNumber(li.business, li.gl_category) || null,
  };
  if (role === ROLES.EXECUTIVE) {
    out.gl_category = null;
    out.confidence_level = null;
    out.logic_path = null;
    // GL data must NOT leak to executives — null the derived account too.
    out.gl_account_number = null;
  }
  return out;
}

export function hydrateInvoice(inv: InvoiceRow) {
  return {
    ...inv,
    has_pdf: !!inv.has_pdf,
    // C3 (v1.6.0): expose location_ambiguous as a boolean (DB stores 0/1).
    // shipping and reconciliation_delta pass through as-is via the spread.
    location_ambiguous: !!inv.location_ambiguous,
    // textract_raw is large; omit from list/detail payloads by default
    textract_raw: undefined as unknown as string | null,
  };
}

export async function getInvoice(
  env: Env,
  id: string,
): Promise<InvoiceRow | null> {
  return env.DB.prepare("SELECT * FROM invoices WHERE id = ?")
    .bind(id)
    .first<InvoiceRow>();
}

export async function getInvoiceWithRelations(
  env: Env,
  id: string,
  includeAudit = false,
  role?: string,
) {
  const invoice = await getInvoice(env, id);
  if (!invoice) return null;

  const lineItems = await env.DB.prepare(
    "SELECT * FROM line_items WHERE invoice_id = ? ORDER BY sort_order ASC",
  )
    .bind(id)
    .all<LineItemRow>();

  const approval = await env.DB.prepare(
    "SELECT * FROM approvals WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(id)
    .first<ApprovalRow>();

  // v1.9.3 (Feature E): the invoice-level split allocations (QUICK_EVEN / CUSTOM),
  // so a reviewer can see WHAT an approval's split was — not just that one exists.
  // Tolerate a pre-migration DB with no invoice_allocations table (treat as none).
  let allocations: InvoiceAllocationRow[] = [];
  try {
    const alloc = await env.DB.prepare(
      "SELECT * FROM invoice_allocations WHERE invoice_id = ? ORDER BY created_at ASC",
    )
      .bind(id)
      .all<InvoiceAllocationRow>();
    allocations = alloc.results ?? [];
  } catch {
    allocations = [];
  }

  let submitter = null;
  if (invoice.submitted_by) {
    submitter = await env.DB.prepare(
      "SELECT id, name, email, role FROM users WHERE id = ?",
    )
      .bind(invoice.submitted_by)
      .first();
  }

  let auditLog: unknown[] | undefined;
  if (includeAudit) {
    const a = await env.DB.prepare(
      "SELECT * FROM audit_log WHERE invoice_id = ? ORDER BY created_at DESC",
    )
      .bind(id)
      .all();
    auditLog = (a.results ?? []).map((e) => ({
      ...(e as Record<string, unknown>),
      prev_value: parseJson((e as { prev_value: string }).prev_value, null),
      new_value: parseJson((e as { new_value: string }).new_value, null),
    }));
  }

  return {
    ...hydrateInvoice(invoice),
    line_items: (lineItems.results ?? []).map((li) => hydrateLineItem(li, role)),
    approval: approval ?? null,
    allocations,
    submitter,
    ...(includeAudit ? { audit_log: auditLog } : {}),
  };
}

export async function resolveApproverUser(
  env: Env,
  name: string,
): Promise<UserRow | null> {
  return env.DB.prepare(
    "SELECT * FROM users WHERE lower(trim(name)) = lower(trim(?)) AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
  )
    .bind(name)
    .first<UserRow>();
}

/**
 * Map of invoiceId -> review counts. `review_count` = all requires_review=1 lines
 * (unchanged semantics); `blocking_count` = lines coded to the REQUIRES_MANUAL_REVIEW
 * sentinel (v1.6.0 C3) — these still hard-block export (no real account number),
 * while the rest only warn (FIX-11).
 */
export async function reviewCounts(
  env: Env,
  invoiceIds: string[],
): Promise<Record<string, { review_count: number; blocking_count: number }>> {
  if (invoiceIds.length === 0) return {};
  const out: Record<string, { review_count: number; blocking_count: number }> = {};
  // D1 caps bound params at 100, so batch the id list (one `?` per id + the
  // gl_category param) instead of binding all ids at once.
  for (const batch of chunk(invoiceIds)) {
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      // v1.9.11 (M3): allocation-based splits (QUICK_EVEN / CUSTOM) export from
      // invoice_allocations, NOT line coding — the export hard-block already
      // exempts them, so a stale sentinel line must not show them as "Blocked" in
      // the export UI. Zero their blocking_count to mirror that exemption.
      `SELECT li.invoice_id AS invoice_id,
              SUM(CASE WHEN li.requires_review = 1 THEN 1 ELSE 0 END) AS review_count,
              CASE WHEN i.split_type IN ('QUICK_EVEN','CUSTOM') THEN 0
                   ELSE SUM(CASE WHEN li.gl_category = ? THEN 1 ELSE 0 END)
              END AS blocking_count
         FROM line_items li
         JOIN invoices i ON i.id = li.invoice_id
        WHERE li.invoice_id IN (${placeholders})
        GROUP BY li.invoice_id, i.split_type`,
    )
      .bind(REQUIRES_MANUAL_REVIEW, ...batch)
      .all<{ invoice_id: string; review_count: number; blocking_count: number }>();
    for (const r of rows.results ?? [])
      out[r.invoice_id] = {
        review_count: r.review_count ?? 0,
        blocking_count: r.blocking_count ?? 0,
      };
  }
  return out;
}
