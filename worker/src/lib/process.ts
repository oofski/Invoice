import type { Env, InvoiceRow } from "./types";
import { uploadToReducto } from "./reducto";
import {
  extractInvoice,
  normalizeExtract,
  type ExtractedInvoice,
} from "./extract";
import { getPdf, putPdf, pdfKey, putReductoRaw } from "./storage";
import { runRulesPipeline } from "./pipeline";
import { audit, resolveApproverUser, getInvoice } from "./db";
import { sendApprovalEmail } from "./email";
import { uuid, nowIso, parseAmount, toIsoDate } from "./util";
import {
  AUDIT_ACTION,
  INVOICE_STATUS,
  REQUIRES_MANUAL_REVIEW,
  APPROVAL_STATUS,
  CONFIDENCE_LEVEL,
  type BusinessEntity,
} from "./constants";

/**
 * Runs the OCR/parse step (Reducto) — reusing the stored parse output when
 * present so reprocessing never re-bills the parser — then the 3 Claude prompts.
 * NOTE: the `textract_raw` column now stores the Reducto parse response.
 */
export async function processInvoiceAI(
  env: Env,
  invoiceId: string,
  actorUserId: string | null,
  opts: { rescan?: boolean } = {},
): Promise<{ status: string; approver: string; lineItemCount: number }> {
  const inv = await getInvoice(env, invoiceId);
  if (!inv) throw new Error("Invoice not found");

  // Reuse the stored Reducto extraction if present (never re-bills the parser);
  // otherwise re-extract from the PDF in R2 and store it. A `rescan` (v1.2.1)
  // forces a fresh extraction at the current high-fidelity settings — it re-reads
  // the PDF (re-billing the parser) and overwrites the cached extraction, so
  // re-coding picks up improved OCR, not just re-running the rules over old text.
  let extracted: ExtractedInvoice | null =
    !opts.rescan && inv.textract_raw
      ? normalizeExtract(JSON.parse(inv.textract_raw))
      : null;
  if (!extracted) {
    const meta = await env.DB.prepare(
      "SELECT r2_key, file_name FROM pdf_files WHERE invoice_id = ?",
    )
      .bind(invoiceId)
      .first<{ r2_key: string; file_name: string }>();
    if (!meta?.r2_key) throw new Error("Invoice has no PDF to process");
    const obj = await getPdf(env, meta.r2_key);
    if (!obj) throw new Error("Invoice PDF not found in storage");
    const buf = await obj.arrayBuffer();
    const reductoId = await uploadToReducto(env, buf, meta.file_name ?? "invoice.pdf");
    const ex = await extractInvoice(env, reductoId);
    extracted = ex.data;
    await env.DB.prepare("UPDATE invoices SET textract_raw = ? WHERE id = ?")
      .bind(JSON.stringify(ex.data), invoiceId)
      .run();
    // Persist the RAW Reducto response as an R2 sidecar for later diagnosis
    // (v1.1.8 A). Best-effort: never block reprocessing if the sidecar write fails.
    try {
      await putReductoRaw(env, meta.r2_key, ex.raw);
    } catch (e) {
      console.error("[process] reducto sidecar write failed:", e);
    }
  }

  try {
    const result = await runRulesPipeline(env, extracted);

    // Preserve manually-added lines across reprocess (v1.1.9). An accountant/admin
    // may have added a line the extractor missed; reprocess re-runs extraction and
    // would otherwise drop it. Capture those lines now (before the DELETE below) and
    // keep only the ones the fresh extraction did NOT already reproduce — matched by
    // normalized description AND amount (to the cent) — so a now-extracted line isn't
    // duplicated. They're re-inserted after the AI lines further down.
    const manualLines =
      (
        await env.DB.prepare(
          `SELECT description, amount, gl_category, item_type, confidence_level,
                  requires_review, overridden_by
             FROM line_items
            WHERE invoice_id = ? AND logic_path = 'MANUAL ADD'`,
        )
          .bind(invoiceId)
          .all<{
            description: string | null;
            amount: number | null;
            gl_category: string | null;
            item_type: string | null;
            confidence_level: string | null;
            requires_review: number | null;
            overridden_by: string | null;
          }>()
      ).results ?? [];
    const normDesc = (s: string | null | undefined) =>
      (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const cents = (n: number | null | undefined) => Math.round((n ?? 0) * 100);
    const aiKeys = new Set(
      result.prompt3.map((li) => {
        const amt =
          typeof li.Amount === "number" ? li.Amount : parseAmount(String(li.Amount));
        return `${normDesc(li.LineItemDescription)}|${cents(amt)}`;
      }),
    );
    const preserved = manualLines.filter(
      (m) => !aiKeys.has(`${normDesc(m.description)}|${cents(m.amount)}`),
    );

    // v1.2.0: the reconciliation guard (the synthetic "⚠ Extraction incomplete"
    // review line that flagged when lines + tax ≠ invoice total) has been removed
    // by request — the app no longer nags about totals not adding up. Extraction
    // runs at highest fidelity (deep_extract + citations) and the accountant can
    // still add a missed line manually; we just don't auto-flag a mismatch.

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
           item_type, confidence_level, logic_path, requires_review, sort_order)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        uuid(),
        invoiceId,
        li.LineItemDescription,
        typeof li.Amount === "number" ? li.Amount : parseAmount(String(li.Amount)),
        li.Category,
        // Auto-tagged Retail/Backbar from L2.5 (v1.1.8 N); null otherwise. This
        // pre-fills the exec split Type and drives the per-line export tax recompute.
        li.ItemType ?? null,
        li.ConfidenceLevel,
        li.LogicPathUsed,
        // Flag for review when the category is the manual-review sentinel OR the
        // line was flagged by light confidence gating (v1.1.8 P).
        li.Category === REQUIRES_MANUAL_REVIEW || li.RequiresReview ? 1 : 0,
        idx,
      ),
    );
    if (stmts.length) await env.DB.batch(stmts);

    // Re-insert the preserved manual lines (computed above) after the AI lines.
    // business/class are forced NULL so the header-coded reprocess output keeps the
    // export invariant ("all leaves carry business/class, or none do").
    if (preserved.length) {
      const base = result.prompt3.length;
      const manualStmts = preserved.map((m, i) =>
        env.DB.prepare(
          `INSERT INTO line_items (id, invoice_id, description, amount, business, class,
             gl_category, item_type, confidence_level, logic_path, requires_review,
             manually_overridden, overridden_by, sort_order)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          uuid(),
          invoiceId,
          m.description,
          m.amount,
          null,
          null,
          m.gl_category,
          m.item_type,
          m.confidence_level,
          "MANUAL ADD",
          m.requires_review ?? 0,
          1,
          m.overridden_by,
          base + i,
        ),
      );
      await env.DB.batch(manualStmts);
    }

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
        lineItemCount: result.prompt3.length + preserved.length,
        preservedManualLines: preserved.length || undefined,
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
      lineItemCount: result.prompt3.length + preserved.length,
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

/**
 * Shared end-to-end ingestion for a single PDF: Reducto parse -> Prompt 1 header
 * -> duplicate check -> persist invoice + PDF (R2) -> full AI pipeline. Used by
 * both the interactive accountant upload route and unattended sources (e.g. the
 * SharePoint / Power Automate `/ingest` endpoint), so every path runs identical
 * logic, duplicate detection, and audit trail.
 */
export interface IngestOptions {
  buf: ArrayBuffer;
  fileName: string;
  /** users.id to attribute the upload to, or null for an unattributed source. */
  submittedBy: string | null;
  submissionType: "ACCOUNTANT" | "STAFF";
  /** Skip duplicate detection (vendor + invoice# + total) when true. */
  override: boolean;
  /** Human label for the audit note, e.g. "SharePoint". */
  source?: string;
}

export type IngestResult =
  | {
      duplicate: true;
      existingInvoiceId?: string;
      vendor: string;
      invoice_number: string;
      total_amount: number;
    }
  | {
      duplicate: false;
      invoiceId: string;
      status: string;
      approver: string;
      lineItemCount: number;
    };

export async function ingestInvoicePdf(
  env: Env,
  opts: IngestOptions,
): Promise<IngestResult> {
  const { buf, fileName, submittedBy, submissionType, override, source } = opts;

  // Reducto /extract reads the header + line items up front. The duplicate check
  // runs on the header BEFORE we persist; the extraction is stored and reused by
  // processInvoiceAI, so Reducto is not billed twice. Business/Class/approver are
  // filled in by the rules pipeline in processInvoiceAI.
  const reductoId = await uploadToReducto(env, buf, fileName);
  const { raw: reductoRaw, data } = await extractInvoice(env, reductoId);
  const vendor = data.vendor || "Unknown Vendor";
  const invoiceNumber = data.invoice_number || `NO-INV-${Date.now()}`;
  const total =
    data.total ?? data.line_items.reduce((s, l) => s + (l.amount ?? 0), 0);

  if (!override) {
    const dup = await findDuplicate(env, vendor, invoiceNumber, total);
    if (dup)
      return {
        duplicate: true,
        existingInvoiceId: dup.id,
        vendor,
        invoice_number: invoiceNumber,
        total_amount: total,
      };
  }

  const id = uuid();
  try {
    await env.DB.prepare(
      `INSERT INTO invoices (id, vendor, invoice_number, subtotal, sales_tax, total_amount,
         inv_date, due_date, business, class, status, has_pdf, submitted_by, submission_type, textract_raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        vendor,
        invoiceNumber,
        data.subtotal,
        data.sales_tax ?? 0,
        total,
        toIsoDate(data.invoice_date),
        toIsoDate(data.due_date) ?? toIsoDate(data.invoice_date),
        null,
        null,
        INVOICE_STATUS.PROCESSING,
        1,
        submittedBy,
        submissionType,
        JSON.stringify(data),
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE"))
      return {
        duplicate: true,
        vendor,
        invoice_number: invoiceNumber,
        total_amount: total,
      };
    throw e;
  }

  const key = pdfKey(id);
  await putPdf(env, key, buf);
  await env.DB.prepare(
    "INSERT INTO pdf_files (invoice_id, file_name, mime, r2_key, size) VALUES (?,?,?,?,?)",
  )
    .bind(id, fileName, "application/pdf", key, buf.byteLength)
    .run();
  // Persist the RAW Reducto response as an R2 sidecar next to the PDF for later
  // diagnosis (v1.1.8 A). Best-effort — never fail ingest on the sidecar write.
  try {
    await putReductoRaw(env, key, reductoRaw);
  } catch (e) {
    console.error("[ingest] reducto sidecar write failed:", e);
  }

  await audit(env, {
    invoiceId: id,
    userId: submittedBy,
    action: AUDIT_ACTION.INVOICE_UPLOADED,
    newValue: {
      vendor,
      invoice_number: invoiceNumber,
      total_amount: total,
      submission_type: submissionType,
    },
    note: source ? `Ingested ${fileName} from ${source}` : `Uploaded ${fileName}`,
  });

  const result = await processInvoiceAI(env, id, submittedBy);
  return { duplicate: false, invoiceId: id, ...result };
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
