import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInvoiceWithRelations } from "@/lib/data";
import { canViewInvoice } from "@/lib/visibility";
import { signedPdfUrl } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import { AUDIT_ACTION, ROLES } from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * GET /api/invoices/[id] — single invoice with line items, approval, submitter
 * and audit log; includes a signed PDF URL for the viewer (Brief §07/§08).
 */
export const GET = withErrorHandling(
  async (_request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    const invoice = await getInvoiceWithRelations(params.id, {
      includeAudit: true,
    });
    if (!invoice) return fail("Invoice not found", 404);
    if (!(await canViewInvoice(profile, invoice)))
      return fail("Forbidden", 403);

    const pdfSignedUrl = invoice.pdf_url
      ? await signedPdfUrl(invoice.pdf_url)
      : null;

    return ok({ invoice, pdfSignedUrl });
  },
);

/**
 * PATCH /api/invoices/[id] — update invoice fields (GL codes via line items use
 * their own endpoint; this handles status/header overrides). Brief §07.
 * Auth: accountant, exec, admin.
 */
export const PATCH = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    const profile = await requireProfile();
    if (
      profile.role !== ROLES.ACCOUNTANT &&
      profile.role !== ROLES.ADMIN &&
      profile.role !== ROLES.EXECUTIVE
    ) {
      return fail("Forbidden", 403);
    }

    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("invoices")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (!existing) return fail("Invoice not found", 404);
    if (!(await canViewInvoice(profile, existing as InvoiceRow)))
      return fail("Forbidden", 403);

    const body = await request.json().catch(() => ({}));
    const allowed: (keyof InvoiceRow)[] = [
      "vendor",
      "subtotal",
      "sales_tax",
      "total_amount",
      "inv_date",
      "due_date",
      "business",
      "class",
      "approved_by",
      "status",
    ];
    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }
    if (Object.keys(update).length === 0)
      return fail("No updatable fields provided", 400);

    const { data: updated, error } = await admin
      .from("invoices")
      .update(update)
      .eq("id", params.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await writeAudit({
      invoiceId: params.id,
      userId: profile.id,
      action: AUDIT_ACTION.INVOICE_UPDATED,
      prevValue: Object.fromEntries(
        Object.keys(update).map((k) => [
          k,
          (existing as Record<string, unknown>)[k],
        ]),
      ),
      newValue: update,
    });

    return ok({ invoice: updated });
  },
);
