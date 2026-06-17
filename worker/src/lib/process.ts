import type { Env, InvoiceRow } from "./types";
import { runTextract, parseTextract, formatForClaude } from "./textract";
import { runPipeline } from "./ai/pipeline";
import { audit, resolveApproverUser, getInvoice } from "./db";
import { sendApprovalEmail } from "./email";
import { uuid, nowIso, parseAmount, toIsoDate } from "./util";
import {
  AUDIT_ACTION,
  INVOICE_STATUS,
  REQUIRES_MANUAL_REVIEW,
  APPROVAL_STATUS,
} from "./constants";

/** Runs Textract (reusing stored output if present) + the 3 Claude prompts. */
export async function processInvoiceAI(
  env: Env,
  invoiceId: string,
  actorUserId: string | null,
): Promise<{ status: string; approver: string; lineItemCount: number }> {
  const inv = await getInvoice(env, invoiceId);
  if (!inv) throw new Error("Invoice not found");

  // Obtain Textract output (reuse stored raw -> no re-billing, Brief §13).
  let textractRaw: unknown = inv.textract_raw ? JSON.parse(inv.textract_raw) : null;
  if (!textractRaw) {
    const pdf = await env.DB.prepare(
      "SELECT bytes FROM pdf_files WHERE invoice_id = ?",
    )
      .bind(invoiceId)
      .first<{ bytes: ArrayBuffer }>();
    if (!pdf?.bytes) throw new Error("Invoice has no PDF to process");
    textractRaw = await runTextract(env, pdf.bytes);
    await env.DB.prepare("UPDATE invoices SET textract_raw = ? WHERE id = ?")
      .bind(JSON.stringify(textractRaw), invoiceId)
      .run();
  }

  const summary = parseTextract(textractRaw);
  const textractText = formatForClaude(summary);

  try {
    const result = await runPipeline(env, textractText);

    const subtotal =
      inv.subtotal == null && result.prompt1.Subtotal
        ? parseAmount(result.prompt1.Subtotal)
        : inv.subtotal;
    const salesTax =
      (inv.sales_tax == null || inv.sales_tax === 0) && result.prompt1.SalesTax
        ? parseAmount(result.prompt1.SalesTax)
        : inv.sales_tax;
    const invDate = inv.inv_date ?? toIsoDate(result.prompt1.InvDate);
    const dueDate =
      inv.due_date ??
      toIsoDate(result.prompt1.DueDate) ??
      toIsoDate(result.prompt1.InvDate);

    await env.DB.prepare(
      `UPDATE invoices SET business=?, class=?, approved_by=?, status=?,
         ai_processed_at=?, subtotal=?, sales_tax=?, inv_date=?, due_date=?
       WHERE id=?`,
    )
      .bind(
        result.prompt1.Business ?? inv.business,
        result.prompt1.Class ?? inv.class,
        result.finalApprover,
        INVOICE_STATUS.PENDING_APPROVAL,
        nowIso(),
        subtotal ?? null,
        salesTax ?? 0,
        invDate ?? null,
        dueDate ?? null,
        invoiceId,
      )
      .run();

    // Replace line items (idempotent on reprocess).
    await env.DB.prepare("DELETE FROM line_items WHERE invoice_id = ?")
      .bind(invoiceId)
      .run();
    const stmts = result.prompt3.map((li, idx) =>
      env.DB.prepare(
        `INSERT INTO line_items (id, invoice_id, description, amount, gl_category,
           confidence_level, logic_path, requires_review, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).bind(
        uuid(),
        invoiceId,
        li.LineItemDescription,
        typeof li.Amount === "number" ? li.Amount : parseAmount(String(li.Amount)),
        li.Category,
        li.ConfidenceLevel,
        li.LogicPathUsed,
        li.Category === REQUIRES_MANUAL_REVIEW ? 1 : 0,
        idx,
      ),
    );
    if (stmts.length) await env.DB.batch(stmts);

    // Create/refresh the approval routed to the final approver.
    const approver = await resolveApproverUser(env, result.finalApprover);
    await env.DB.prepare("DELETE FROM approvals WHERE invoice_id = ?")
      .bind(invoiceId)
      .run();
    await env.DB.prepare(
      `INSERT INTO approvals (id, invoice_id, assigned_to, assigned_to_name, status)
       VALUES (?,?,?,?,?)`,
    )
      .bind(
        uuid(),
        invoiceId,
        approver?.id ?? null,
        result.finalApprover,
        APPROVAL_STATUS.PENDING,
      )
      .run();

    await audit(env, {
      invoiceId,
      userId: actorUserId,
      action: AUDIT_ACTION.AI_PROCESSED,
      prevValue: { status: inv.status },
      newValue: {
        status: INVOICE_STATUS.PENDING_APPROVAL,
        business: result.prompt1.Business,
        class: result.prompt1.Class,
        approved_by: result.finalApprover,
        prompt1Approver: result.prompt1.ApprovedBy,
        lineItemCount: result.prompt3.length,
      },
      note: `AI processing complete. Routed to ${result.finalApprover} (Prompt 2 override of ${result.prompt1.ApprovedBy}).`,
    });

    if (approver?.email) {
      try {
        await sendApprovalEmail(env, approver.email, {
          invoiceId,
          vendor: inv.vendor,
          totalAmount: inv.total_amount,
          business: result.prompt1.Business ?? inv.business,
          dueDate: dueDate ?? inv.due_date,
          invoiceNumber: inv.invoice_number,
        });
      } catch (e) {
        console.error("[process] approval email failed:", e);
      }
    }

    return {
      status: INVOICE_STATUS.PENDING_APPROVAL,
      approver: result.finalApprover,
      lineItemCount: result.prompt3.length,
    };
  } catch (err) {
    await audit(env, {
      invoiceId,
      userId: actorUserId,
      action: AUDIT_ACTION.AI_PROCESSING_FAILED,
      note: err instanceof Error ? err.message : "AI processing failed",
    });
    throw err;
  }
}

/** Duplicate detection (vendor + invoice# + total) — Brief §13. */
export async function findDuplicate(
  env: Env,
  vendor: string,
  invoiceNumber: string,
  totalAmount: number,
): Promise<InvoiceRow | null> {
  return env.DB.prepare(
    "SELECT * FROM invoices WHERE vendor = ? AND invoice_number = ? AND total_amount = ? LIMIT 1",
  )
    .bind(vendor, invoiceNumber, totalAmount)
    .first<InvoiceRow>();
}
