import { createAdminClient } from "@/lib/supabase/admin";
import { runTextract, parseTextract, formatForClaude } from "@/lib/textract";
import { runPipeline } from "@/lib/ai/pipeline";
import { downloadPdf } from "@/lib/storage";
import { resolveApproverUser } from "@/lib/data";
import { writeAudit } from "@/lib/audit";
import { sendApprovalEmail } from "@/lib/email/resend";
import { parseAmount, toIsoDate } from "@/lib/utils";
import {
  AUDIT_ACTION,
  INVOICE_STATUS,
  REQUIRES_MANUAL_REVIEW,
  APPROVAL_STATUS,
} from "@/lib/constants";
import type { InvoiceRow } from "@/lib/types";
import type { AnalyzeExpenseCommandOutput } from "@aws-sdk/client-textract";

/**
 * Runs AWS Textract on a PDF buffer and returns both the raw response (for the
 * textract_raw audit column) and a parsed summary. Brief §04 step 3.
 */
export async function extractWithTextract(pdfBuffer: Buffer) {
  const raw = await runTextract(pdfBuffer);
  const summary = parseTextract(raw);
  return { raw, summary };
}

interface DuplicateCheckArgs {
  vendor: string;
  invoiceNumber: string;
  totalAmount: number;
}

/**
 * Duplicate detection (Brief §04 step 2, §13): vendor + invoice_number +
 * total_amount against the invoices table. Returns the existing invoice id if a
 * duplicate exists.
 */
export async function findDuplicate({
  vendor,
  invoiceNumber,
  totalAmount,
}: DuplicateCheckArgs): Promise<InvoiceRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("invoices")
    .select("*")
    .ilike("vendor", vendor)
    .eq("invoice_number", invoiceNumber)
    .eq("total_amount", totalAmount)
    .limit(1)
    .maybeSingle();
  return (data as InvoiceRow) ?? null;
}

/**
 * Runs the three Claude prompts for an already-created invoice that has its
 * Textract output stored, merges per the critical rules, persists line items,
 * creates the approval, writes audit, and emails the assigned exec.
 *
 * Reuses invoices.textract_raw when present so reprocessing never re-bills
 * Textract (Brief §13). Pass a pre-parsed summary to avoid re-parsing.
 */
export async function processInvoiceAI(
  invoiceId: string,
  actorUserId: string | null,
): Promise<{ status: string; approver: string; lineItemCount: number }> {
  const admin = createAdminClient();

  const { data: invoice } = await admin
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) throw new Error("Invoice not found");
  const inv = invoice as InvoiceRow;

  // Obtain Textract output: reuse stored raw, else (re)run Textract from PDF.
  let textractRaw = inv.textract_raw as AnalyzeExpenseCommandOutput | null;
  if (!textractRaw) {
    if (!inv.pdf_url) throw new Error("Invoice has no PDF to process");
    const buffer = await downloadPdf(inv.pdf_url);
    const { raw } = await extractWithTextract(buffer);
    textractRaw = raw;
    await admin
      .from("invoices")
      .update({ textract_raw: textractRaw })
      .eq("id", invoiceId);
  }

  const summary = parseTextract(textractRaw);
  const textractText = formatForClaude(summary);

  try {
    const result = await runPipeline(textractText);

    // --- Update invoice header from Prompt 1 + final approver (Prompt 2) ---
    const update: Partial<InvoiceRow> = {
      business: result.prompt1.Business ?? inv.business,
      class: result.prompt1.Class ?? inv.class,
      approved_by: result.finalApprover,
      status: INVOICE_STATUS.PENDING_APPROVAL,
      ai_processed_at: new Date().toISOString(),
    };
    // Backfill header values only where they were missing at creation.
    if (inv.subtotal == null && result.prompt1.Subtotal)
      update.subtotal = parseAmount(result.prompt1.Subtotal);
    if ((inv.sales_tax == null || inv.sales_tax === 0) && result.prompt1.SalesTax)
      update.sales_tax = parseAmount(result.prompt1.SalesTax);
    if (!inv.inv_date && result.prompt1.InvDate)
      update.inv_date = toIsoDate(result.prompt1.InvDate) as unknown as string;
    if (!inv.due_date)
      update.due_date = (toIsoDate(result.prompt1.DueDate) ??
        toIsoDate(result.prompt1.InvDate)) as unknown as string;

    await admin.from("invoices").update(update).eq("id", invoiceId);

    // --- Replace line items (idempotent on reprocess) ---
    await admin.from("line_items").delete().eq("invoice_id", invoiceId);
    const lineRows = result.prompt3.map((li, idx) => ({
      invoice_id: invoiceId,
      description: li.LineItemDescription,
      amount: typeof li.Amount === "number" ? li.Amount : parseAmount(String(li.Amount)),
      gl_category: li.Category,
      confidence_level: li.ConfidenceLevel,
      logic_path: li.LogicPathUsed,
      requires_review: li.Category === REQUIRES_MANUAL_REVIEW,
      sort_order: idx,
    }));
    if (lineRows.length) {
      await admin.from("line_items").insert(lineRows);
    }

    // --- Create / refresh approval routed to the final approver ---
    const approver = await resolveApproverUser(result.finalApprover);
    await admin.from("approvals").delete().eq("invoice_id", invoiceId);
    await admin.from("approvals").insert({
      invoice_id: invoiceId,
      assigned_to: approver?.id ?? null,
      assigned_to_name: result.finalApprover,
      status: APPROVAL_STATUS.PENDING,
    });

    await writeAudit({
      invoiceId,
      userId: actorUserId,
      action: AUDIT_ACTION.AI_PROCESSED,
      prevValue: { status: inv.status },
      newValue: {
        status: INVOICE_STATUS.PENDING_APPROVAL,
        business: update.business,
        class: update.class,
        approved_by: result.finalApprover,
        prompt1Approver: result.prompt1.ApprovedBy,
        lineItemCount: lineRows.length,
      },
      note: `AI processing complete. Routed to ${result.finalApprover} (Prompt 2 override of ${result.prompt1.ApprovedBy}).`,
    });

    // --- Email the assigned exec (Brief §04 step 6) ---
    if (approver?.email) {
      try {
        await sendApprovalEmail(approver.email, {
          invoiceId,
          vendor: inv.vendor,
          totalAmount: Number(inv.total_amount),
          business: update.business ?? inv.business,
          dueDate: (update.due_date as string) ?? inv.due_date,
          invoiceNumber: inv.invoice_number,
        });
      } catch (emailErr) {
        console.error("[process] approval email failed:", emailErr);
      }
    }

    return {
      status: INVOICE_STATUS.PENDING_APPROVAL,
      approver: result.finalApprover,
      lineItemCount: lineRows.length,
    };
  } catch (err) {
    await writeAudit({
      invoiceId,
      userId: actorUserId,
      action: AUDIT_ACTION.AI_PROCESSING_FAILED,
      note: err instanceof Error ? err.message : "AI processing failed",
    });
    throw err;
  }
}
