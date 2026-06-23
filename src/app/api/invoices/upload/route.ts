import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadPdf } from "@/lib/storage";
import {
  extractWithTextract,
  findDuplicate,
  processInvoiceAI,
} from "@/lib/process";
import { writeAudit } from "@/lib/audit";
import { parseAmount, toIsoDate } from "@/lib/utils";
import {
  AUDIT_ACTION,
  INVOICE_STATUS,
  ROLES,
  SUBMISSION_TYPE,
} from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/upload — Brief §04 Flow A/B, Session 2.
 *
 * Stores the PDF, runs Textract, performs duplicate detection BEFORE the
 * expensive Claude pipeline (Brief §13), creates the invoice (PROCESSING), then
 * runs the 3-prompt AI pipeline and routes for approval.
 *
 * multipart/form-data: file=<pdf>, [override=true], [submissionType=ACCOUNTANT|STAFF]
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const profile = await requireRole(ROLES.ACCOUNTANT, ROLES.STAFF, ROLES.ADMIN);

  const form = await request.formData();
  const file = form.get("file");
  const override = form.get("override") === "true";
  const submissionType =
    profile.role === ROLES.STAFF
      ? SUBMISSION_TYPE.STAFF
      : (form.get("submissionType") as string) === SUBMISSION_TYPE.STAFF
        ? SUBMISSION_TYPE.STAFF
        : SUBMISSION_TYPE.ACCOUNTANT;

  if (!(file instanceof File)) {
    return fail("No file provided", 400);
  }
  if (file.type && file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
    return fail("Only PDF files are supported", 415);
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // 1) Textract (cheap, ~$0.01/page) to obtain the header for dedupe.
  const { raw, summary } = await extractWithTextract(buffer);
  const vendor = summary.vendor || "Unknown Vendor";
  const invoiceNumber = summary.invoiceNumber || `NO-INV-${Date.now()}`;
  const totalAmount = parseAmount(summary.total);

  // 2) Duplicate detection BEFORE the expensive Claude pipeline (Brief §13).
  if (!override) {
    const dup = await findDuplicate({ vendor, invoiceNumber, totalAmount });
    if (dup) {
      return ok(
        {
          duplicate: true,
          existingInvoiceId: dup.id,
          vendor,
          invoice_number: invoiceNumber,
          total_amount: totalAmount,
        },
        409,
      );
    }
  }

  // 3) Store PDF + create invoice row (PROCESSING).
  const admin = createAdminClient();
  const pdfPath = await uploadPdf(buffer, file.name);

  const { data: created, error } = await admin
    .from("invoices")
    .insert({
      vendor,
      invoice_number: invoiceNumber,
      subtotal: summary.subtotal ? parseAmount(summary.subtotal) : null,
      sales_tax: summary.tax ? parseAmount(summary.tax) : 0,
      total_amount: totalAmount,
      inv_date: toIsoDate(summary.invoiceDate),
      due_date: toIsoDate(summary.dueDate) ?? toIsoDate(summary.invoiceDate),
      status: INVOICE_STATUS.PROCESSING,
      pdf_url: pdfPath,
      submitted_by: profile.id,
      submission_type: submissionType,
      textract_raw: raw as unknown as object,
    })
    .select("*")
    .single();

  if (error) {
    // Unique(vendor, invoice_number, total_amount) violation == duplicate.
    if (error.code === "23505") {
      return ok(
        {
          duplicate: true,
          vendor,
          invoice_number: invoiceNumber,
          total_amount: totalAmount,
        },
        409,
      );
    }
    return fail(`Failed to create invoice: ${error.message}`, 500);
  }

  await writeAudit({
    invoiceId: created.id,
    userId: profile.id,
    action: AUDIT_ACTION.INVOICE_UPLOADED,
    newValue: {
      vendor,
      invoice_number: invoiceNumber,
      total_amount: totalAmount,
      submission_type: submissionType,
    },
    note: `Uploaded ${file.name}`,
  });

  // 4) Run the 3-prompt AI pipeline (Textract output is already stored).
  const result = await processInvoiceAI(created.id, profile.id);

  return ok({ invoiceId: created.id, ...result }, 201);
});
