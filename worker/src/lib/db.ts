import type {
  Env,
  InvoiceRow,
  LineItemRow,
  ApprovalRow,
  UserRow,
} from "./types";
import { uuid, parseJson } from "./util";

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

/** Converts a D1 line item row to an API-friendly object (booleans, etc.). */
export function hydrateLineItem(li: LineItemRow) {
  return {
    ...li,
    requires_review: !!li.requires_review,
    manually_overridden: !!li.manually_overridden,
  };
}

export function hydrateInvoice(inv: InvoiceRow) {
  return {
    ...inv,
    has_pdf: !!inv.has_pdf,
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
    line_items: (lineItems.results ?? []).map(hydrateLineItem),
    approval: approval ?? null,
    submitter,
    ...(includeAudit ? { audit_log: auditLog } : {}),
  };
}

export async function resolveApproverUser(
  env: Env,
  name: string,
): Promise<UserRow | null> {
  return env.DB.prepare(
    "SELECT * FROM users WHERE name = ? AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
  )
    .bind(name)
    .first<UserRow>();
}

/** Map of invoiceId -> count of unresolved manual-review line items. */
export async function reviewCounts(
  env: Env,
  invoiceIds: string[],
): Promise<Record<string, number>> {
  if (invoiceIds.length === 0) return {};
  const placeholders = invoiceIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT invoice_id, COUNT(*) as c FROM line_items
      WHERE requires_review = 1 AND invoice_id IN (${placeholders})
      GROUP BY invoice_id`,
  )
    .bind(...invoiceIds)
    .all<{ invoice_id: string; c: number }>();
  const out: Record<string, number> = {};
  for (const r of rows.results ?? []) out[r.invoice_id] = r.c;
  return out;
}
