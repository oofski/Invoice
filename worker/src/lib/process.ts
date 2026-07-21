import type { Env, InvoiceRow } from "./types";
import { uploadToReducto } from "./reducto";
import {
  extractInvoice,
  normalizeExtract,
  type ExtractedInvoice,
} from "./extract";
import { getPdf, putPdf, deletePdf, pdfKey, putReductoRaw } from "./storage";
import { normalizeToStorable, withExt } from "./pdfNormalize";
import { runRulesPipeline } from "./pipeline";
import { audit, resolveApproverUser, getInvoice } from "./db";
import { sendApprovalEmail } from "./email";
import { maybeRouteInvoiceToCc } from "./ccRoute";
import { uuid, nowIso, parseAmount, toIsoDate } from "./util";
import {
  AUDIT_ACTION,
  INVOICE_STATUS,
  REQUIRES_MANUAL_REVIEW,
  APPROVAL_STATUS,
  CONFIDENCE_LEVEL,
  isCategoryValidForEntity,
  type BusinessEntity,
} from "./constants";

/** A stored line_item row snapshot used by reprocess preservation (FIX-10). */
interface StoredLine {
  id: string;
  description: string | null;
  amount: number | null;
  business: string | null;
  class: string | null;
  gl_category: string | null;
  item_type: string | null;
  confidence_level: string | null;
  logic_path: string | null;
  requires_review: number | null;
  manually_overridden: number | null;
  overridden_by: string | null;
  split_parent_id: string | null;
  split_percentage: number | null;
  sort_order: number | null;
}

/**
 * FIX-8 (v1.6.0) — recompute the invoice-level reconciliation guard.
 *
 *   expected = round2( Σ amount of persisted LEAF line_items + (sales_tax ?? 0) )
 *   delta    = round2( total_amount − expected )
 *   reconciliation_delta = (|delta| > 0.02) ? delta : NULL
 *
 * Leaves = rows NOT referenced by any split_parent_id (a split parent's children
 * replace it in the sum). The synthesized shipping line is a leaf, so shipping is
 * inside Σ. Positive delta = booked short (money missing); negative = booked over.
 * Best-effort: a pre-migration DB (no reconciliation_delta column) degrades to a
 * no-op so the money-changing routes keep working. Returns the persisted delta.
 */
export async function recomputeReconciliation(
  env: Env,
  invoiceId: string,
): Promise<number | null> {
  try {
    const inv = await env.DB.prepare(
      "SELECT total_amount, sales_tax FROM invoices WHERE id = ?",
    )
      .bind(invoiceId)
      .first<{ total_amount: number | null; sales_tax: number | null }>();
    if (!inv) return null;

    const rows =
      (
        await env.DB.prepare(
          "SELECT id, amount, split_parent_id, gl_category FROM line_items WHERE invoice_id = ?",
        )
          .bind(invoiceId)
          .all<{
            id: string;
            amount: number | null;
            split_parent_id: string | null;
            gl_category: string | null;
          }>()
      ).results ?? [];
    const parentIds = new Set(
      rows.map((r) => r.split_parent_id).filter((x): x is string => !!x),
    );
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const leafRows = rows.filter((r) => !parentIds.has(r.id));
    const leafSum = leafRows.reduce((s, r) => s + (r.amount ?? 0), 0);
    // v1.9.7 (bug #19): when sales tax is ALSO itemized as a leaf line, it is
    // already in leafSum — don't add the header sales_tax again (that produced a
    // phantom reconciliation gap of −tax). Mirrors the export tax-dedup guard.
    const hasTaxLine = leafRows.some((r) => r.gl_category === "Sales/Use Tax");
    const expected = round2(leafSum + (hasTaxLine ? 0 : inv.sales_tax ?? 0));
    const delta = round2((inv.total_amount ?? 0) - expected);
    const reconciliationDelta = Math.abs(delta) > 0.02 ? delta : null;

    await env.DB.prepare(
      "UPDATE invoices SET reconciliation_delta = ? WHERE id = ?",
    )
      .bind(reconciliationDelta, invoiceId)
      .run();
    return reconciliationDelta;
  } catch (e) {
    console.error("[reconcile] recompute failed:", e);
    return null;
  }
}

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
): Promise<{
  status: string;
  approver: string;
  lineItemCount: number;
  preservedOverrides: number;
  droppedOverrides: number;
  preservedSplits: number;
  droppedSplits: number;
}> {
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
    const newBusiness = result.prompt1.Business;

    // ---- FIX-10 (v1.6.0): preserve human work across reprocess/rescan ----
    // Capture every existing line BEFORE the DELETE, then classify:
    //   1. MANUAL ADD rows (unchanged behavior — re-inserted if not re-extracted)
    //   2. MANUAL OVERRIDE rows (re-apply the human GL coding onto the fresh line)
    //   3. Split subtrees (parent + children — re-inserted verbatim in the slot)
    const existingRows =
      (
        await env.DB.prepare(
          `SELECT id, description, amount, business, class, gl_category, item_type,
                  confidence_level, logic_path, requires_review, manually_overridden,
                  overridden_by, split_parent_id, split_percentage, sort_order
             FROM line_items WHERE invoice_id = ?`,
        )
          .bind(invoiceId)
          .all<StoredLine>()
      ).results ?? [];

    const normDesc = (s: string | null | undefined) =>
      (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    const cents = (n: number | null | undefined) => Math.round((n ?? 0) * 100);

    // Split parents = rows referenced by some child's split_parent_id.
    const childrenByParent = new Map<string, StoredLine[]>();
    for (const r of existingRows) {
      if (r.split_parent_id) {
        const arr = childrenByParent.get(r.split_parent_id) ?? [];
        arr.push(r);
        childrenByParent.set(r.split_parent_id, arr);
      }
    }
    const parentIds = new Set(childrenByParent.keys());

    const manualAddRows = existingRows.filter(
      (r) => r.logic_path === "MANUAL ADD" && !parentIds.has(r.id),
    );
    const overrideRows = existingRows.filter(
      (r) =>
        r.manually_overridden === 1 &&
        r.split_parent_id == null &&
        r.logic_path !== "MANUAL ADD" &&
        !parentIds.has(r.id),
    );
    const splitParentRows = existingRows.filter((r) => parentIds.has(r.id));

    // Fresh AI lines with per-line action bookkeeping. Each fresh line is matched
    // by at most one preserved artifact (override or split subtree).
    type FreshAction =
      | { kind: "ai" }
      | { kind: "override"; row: StoredLine }
      | { kind: "override-invalid" }
      | { kind: "split"; parent: StoredLine; children: StoredLine[] };
    const fresh = result.prompt3.map((li, idx) => ({
      idx,
      li,
      amount:
        typeof li.Amount === "number" ? li.Amount : parseAmount(String(li.Amount)),
      claimed: false,
      action: { kind: "ai" } as FreshAction,
    }));

    // Match a stored artifact to an unclaimed fresh line: exact normDesc+cents
    // first (first unmatched wins), else fallback to a UNIQUE unmatched amount.
    const matchFresh = (desc: string | null, amount: number | null) => {
      const key = `${normDesc(desc)}|${cents(amount)}`;
      const exact = fresh.find(
        (f) =>
          !f.claimed &&
          `${normDesc(f.li.LineItemDescription)}|${cents(f.amount)}` === key,
      );
      if (exact) return exact;
      const amt = fresh.filter((f) => !f.claimed && cents(f.amount) === cents(amount));
      return amt.length === 1 ? amt[0] : null;
    };

    // MANUAL ADD de-dupe (unchanged): drop those the fresh extraction reproduced.
    const aiKeys = new Set(
      fresh.map((f) => `${normDesc(f.li.LineItemDescription)}|${cents(f.amount)}`),
    );
    const preservedManual = manualAddRows.filter(
      (m) => !aiKeys.has(`${normDesc(m.description)}|${cents(m.amount)}`),
    );

    // Plan split subtrees FIRST (they replace a fresh line wholesale).
    let preservedSplits = 0;
    let droppedSplits = 0;
    const dropAudits: { action: string; note: string }[] = [];
    for (const parent of splitParentRows) {
      const match = matchFresh(parent.description, parent.amount);
      if (match) {
        match.claimed = true;
        const kids = (childrenByParent.get(parent.id) ?? [])
          .slice()
          .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        match.action = { kind: "split", parent, children: kids };
        preservedSplits++;
      } else {
        droppedSplits++;
        dropAudits.push({
          action: AUDIT_ACTION.LINE_ITEM_SPLIT,
          note: "split dropped by reprocess",
        });
      }
    }

    // Then plan overrides.
    let preservedOverrides = 0;
    let droppedOverrides = 0;
    for (const ov of overrideRows) {
      const match = matchFresh(ov.description, ov.amount);
      if (!match) {
        droppedOverrides++;
        dropAudits.push({
          action: AUDIT_ACTION.GL_OVERRIDE,
          note: `Override on "${ov.description ?? ""}" could not be re-applied after reprocess — line no longer extracted`,
        });
        continue;
      }
      match.claimed = true;
      const storedCategory = ov.gl_category ?? "";
      if (storedCategory && isCategoryValidForEntity(newBusiness, storedCategory)) {
        match.action = { kind: "override", row: ov };
        preservedOverrides++;
      } else {
        // Entity changed under reprocess — keep the fresh AI coding, flag it.
        match.action = { kind: "override-invalid" };
        dropAudits.push({
          action: AUDIT_ACTION.GL_OVERRIDE,
          note: `Override on "${ov.description ?? ""}" not re-applied after reprocess — "${storedCategory}" is not valid for ${newBusiness}`,
        });
      }
    }

    // v1.9.7 (bug #20): a rescan re-bills the OCR specifically to correct a
    // mis-read header, so PREFER the freshly extracted header values on rescan
    // (falling back to the stored value only when the fresh field is absent). A
    // normal reprocess keeps the "adopt only when empty" behavior so it never
    // clobbers a value the first pass already captured.
    const subtotal = opts.rescan
      ? result.prompt1.Subtotal
        ? parseAmount(result.prompt1.Subtotal)
        : inv.subtotal
      : inv.subtotal == null && result.prompt1.Subtotal
        ? parseAmount(result.prompt1.Subtotal)
        : inv.subtotal;
    const salesTax = opts.rescan
      ? result.prompt1.SalesTax
        ? parseAmount(result.prompt1.SalesTax)
        : inv.sales_tax
      : (inv.sales_tax == null || inv.sales_tax === 0) && result.prompt1.SalesTax
        ? parseAmount(result.prompt1.SalesTax)
        : inv.sales_tax;
    const invDate = opts.rescan
      ? toIsoDate(result.prompt1.InvDate) ?? inv.inv_date
      : inv.inv_date ?? toIsoDate(result.prompt1.InvDate);
    const dueDate = opts.rescan
      ? toIsoDate(result.prompt1.DueDate) ??
        toIsoDate(result.prompt1.InvDate) ??
        inv.due_date
      : inv.due_date ??
        toIsoDate(result.prompt1.DueDate) ??
        toIsoDate(result.prompt1.InvDate);

    // v1.9.10 (H4): the header update, the line-items DELETE, and every re-insert
    // are prepared here and committed together in ONE atomic D1 batch below (a
    // batch runs in a single transaction). Previously these ran as separate
    // awaited statements, so a mid-way failure could strand a previously-good
    // invoice with zero (or partial) line items and no restore on reprocess.
    const updateInvoiceStmt = env.DB.prepare(
      `UPDATE invoices SET business=?, class=?, approved_by=?, status=?,
         ai_processed_at=?, subtotal=?, sales_tax=?, inv_date=?, due_date=?,
         shipping=?, location_ambiguous=?
       WHERE id=?`,
    ).bind(
      result.prompt1.Business ?? inv.business,
      result.prompt1.Class ?? inv.class,
      result.finalApprover,
      INVOICE_STATUS.PENDING_APPROVAL,
      nowIso(),
      subtotal ?? null,
      salesTax ?? 0,
      invDate ?? null,
      dueDate ?? null,
      extracted.shipping ?? null, // FIX-9: persist header shipping
      result.locationAmbiguous ? 1 : 0, // FIX-8b: persist location ambiguity
      invoiceId,
    );

    // Replace line items (idempotent on reprocess). Each fresh line is persisted
    // per its planned action; split subtrees and overrides are re-applied in slot.
    const deleteLinesStmt = env.DB
      .prepare("DELETE FROM line_items WHERE invoice_id = ?")
      .bind(invoiceId);
    const stmts: D1PreparedStatement[] = [];
    let insertedCount = 0;
    for (const f of fresh) {
      const slot = f.idx;
      const li = f.li;
      if (f.action.kind === "split") {
        // Re-insert the stored subtree verbatim (new ids; children re-pointed).
        const parent = f.action.parent;
        const newParentId = uuid();
        stmts.push(
          env.DB.prepare(
            `INSERT INTO line_items (id, invoice_id, description, amount, business, class,
               gl_category, item_type, confidence_level, logic_path, requires_review,
               manually_overridden, overridden_by, split_percentage, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            newParentId,
            invoiceId,
            parent.description,
            parent.amount,
            parent.business,
            parent.class,
            parent.gl_category,
            parent.item_type,
            parent.confidence_level,
            parent.logic_path,
            parent.requires_review ?? 0,
            parent.manually_overridden ?? 1,
            parent.overridden_by,
            parent.split_percentage,
            slot,
          ),
        );
        insertedCount++;
        f.action.children.forEach((child, i) => {
          stmts.push(
            env.DB.prepare(
              `INSERT INTO line_items (id, invoice_id, description, amount, business, class,
                 gl_category, item_type, confidence_level, logic_path, requires_review,
                 manually_overridden, overridden_by, split_parent_id, split_percentage, sort_order)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).bind(
              uuid(),
              invoiceId,
              child.description,
              child.amount,
              child.business,
              child.class,
              child.gl_category,
              child.item_type,
              child.confidence_level,
              child.logic_path ?? "SPLIT",
              child.requires_review ?? 0,
              child.manually_overridden ?? 1,
              child.overridden_by,
              newParentId,
              child.split_percentage,
              slot + (i + 1) / 100,
            ),
          );
          insertedCount++;
        });
      } else if (f.action.kind === "override") {
        // Re-apply the human GL coding onto the fresh line (desc/amount fresh).
        const ov = f.action.row;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO line_items (id, invoice_id, description, amount, gl_category,
               item_type, confidence_level, logic_path, requires_review,
               manually_overridden, overridden_by, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            uuid(),
            invoiceId,
            li.LineItemDescription,
            f.amount,
            ov.gl_category,
            ov.item_type,
            CONFIDENCE_LEVEL.HIGH,
            "MANUAL OVERRIDE",
            0,
            1,
            ov.overridden_by,
            slot,
          ),
        );
        insertedCount++;
      } else {
        // Fresh AI coding (kind "ai") — or "override-invalid", which keeps the AI
        // coding but is force-flagged for review (entity changed under reprocess).
        const forceReview = f.action.kind === "override-invalid";
        stmts.push(
          env.DB.prepare(
            `INSERT INTO line_items (id, invoice_id, description, amount, gl_category,
               item_type, confidence_level, logic_path, requires_review, sort_order)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            uuid(),
            invoiceId,
            li.LineItemDescription,
            f.amount,
            li.Category,
            // Auto-tagged Retail/Backbar from L2.5 (v1.1.8 N); null otherwise.
            li.ItemType ?? null,
            li.ConfidenceLevel,
            li.LogicPathUsed,
            // Flag for review: manual-review sentinel, LOW/OCR-low (FIX-6), or a
            // no-longer-valid preserved override.
            li.Category === REQUIRES_MANUAL_REVIEW || li.RequiresReview || forceReview
              ? 1
              : 0,
            slot,
          ),
        );
        insertedCount++;
      }
    }
    // Re-insert the preserved MANUAL ADD lines after the AI lines. business/class
    // are forced NULL so the header-coded reprocess output keeps the export
    // invariant ("all leaves carry business/class, or none do").
    const base = result.prompt3.length;
    const manualStmts = preservedManual.map((m, i) =>
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
    insertedCount += manualStmts.length;

    // v1.9.10 (H4): commit the header update + line DELETE + all inserts as ONE
    // atomic batch. Either the invoice's whole coding is replaced or nothing
    // changes — a failure can no longer leave partial/empty line items.
    await env.DB.batch([
      updateInvoiceStmt,
      deleteLinesStmt,
      ...stmts,
      ...manualStmts,
    ]);

    // FIX-8: recompute reconciliation now that every line (AI + preserved) is in.
    await recomputeReconciliation(env, invoiceId);

    // FIX-10: audit every dropped override / split subtree (money-safe: dropped
    // artifacts are NOT re-inserted, so they can't double-count against FIX-8).
    for (const a of dropAudits) {
      await audit(env, {
        invoiceId,
        userId: actorUserId,
        action: a.action,
        note: a.note,
      });
    }

    // Create/refresh the approval routed to the final approver. v1.9.10 (H4):
    // delete + insert atomically so a failure can't leave the invoice with no
    // approval row (invisible to the approval queue).
    const approver = await resolveApproverUser(env, result.finalApprover);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM approvals WHERE invoice_id = ?").bind(invoiceId),
      env.DB.prepare(
        `INSERT INTO approvals (id, invoice_id, assigned_to, assigned_to_name, status)
       VALUES (?,?,?,?,?)`,
      ).bind(
        uuid(),
        invoiceId,
        approver?.id ?? null,
        result.finalApprover,
        APPROVAL_STATUS.PENDING,
      ),
    ]);

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
        lineItemCount: insertedCount,
        preservedManualLines: preservedManual.length || undefined,
        preservedOverrides: preservedOverrides || undefined,
        droppedOverrides: droppedOverrides || undefined,
        preservedSplits: preservedSplits || undefined,
        droppedSplits: droppedSplits || undefined,
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

    // Additive, best-effort (v-CCroute): if OCR indicates this invoice was PAID BY
    // A CREDIT CARD, route it out of the AP flow into the Credit Card module
    // (auto-match else CC inbox) and archive the source invoice. Fully self-
    // contained and never throws — a failure leaves the invoice as a normal AP
    // invoice. Wrapped again here so it can NEVER reach the outer catch (which
    // would mark AI processing failed) or block the finalize return.
    try {
      await maybeRouteInvoiceToCc(env, invoiceId);
    } catch (e) {
      console.error("[process] cc reroute failed (invoice stays in AP):", e);
    }

    return {
      status: INVOICE_STATUS.PENDING_APPROVAL,
      approver: result.finalApprover,
      lineItemCount: insertedCount,
      preservedOverrides,
      droppedOverrides,
      preservedSplits,
      droppedSplits,
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
    // v1.9.3 (Feature B): dedup by vendor + invoice number ALONE first, so a big
    // batch that re-uploads the same invoice several times is collapsed to one
    // even when OCR reads the total slightly differently each time (the schema's
    // UNIQUE is on the vendor+number+total triple, which those varying totals
    // would slip past). Fall back to the exact triple check for safety.
    const dup =
      (await findDuplicateByNumber(env, vendor, invoiceNumber, total)) ??
      (await findDuplicate(env, vendor, invoiceNumber, total));
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
  const insertInvoice = (invNum: string) =>
    env.DB.prepare(
      `INSERT INTO invoices (id, vendor, invoice_number, subtotal, sales_tax, total_amount,
         inv_date, due_date, business, class, status, has_pdf, submitted_by, submission_type,
         textract_raw, shipping)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        vendor,
        invNum,
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
        data.shipping ?? null, // FIX-9: persist header shipping at ingest
      )
      .run();
  try {
    await insertInvoice(invoiceNumber);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("UNIQUE")) throw e;
    // The DB's UNIQUE(vendor, invoice_number, total_amount) fired.
    if (override) {
      // v1.9.7 (bug #26): "Upload anyway" must be able to force an intentional
      // exact duplicate through — disambiguate the number so it lands.
      await insertInvoice(`${invoiceNumber}~dup-${id.slice(0, 8)}`);
    } else {
      // v1.9.7 (bug #27): include the existing invoice id so the Upload card can
      // still show the "View existing" link on a UNIQUE-constraint duplicate.
      const dup = await findDuplicate(env, vendor, invoiceNumber, total);
      return {
        duplicate: true,
        existingInvoiceId: dup?.id,
        vendor,
        invoice_number: invoiceNumber,
        total_amount: total,
      };
    }
  }

  const key = pdfKey(id);
  // v1.9.9: sniff the real type and normalize (image -> real one-page PDF; a
  // genuine PDF is stored as-is; anything else keeps its TRUE mime) so nothing
  // is ever silently stored as a mislabeled "application/pdf".
  const norm = await normalizeToStorable(buf);
  await putPdf(env, key, norm.bytes, norm.mime);
  await env.DB.prepare(
    "INSERT INTO pdf_files (invoice_id, file_name, mime, r2_key, size) VALUES (?,?,?,?,?)",
  )
    .bind(
      id,
      norm.isPdf ? withExt(fileName, "pdf") : withExt(fileName, norm.ext),
      norm.mime,
      key,
      norm.bytes.byteLength,
    )
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
    note:
      (source ? `Ingested ${fileName} from ${source}` : `Uploaded ${fileName}`) +
      (norm.converted
        ? ` (converted ${norm.sourceType.toUpperCase()} image to PDF)`
        : norm.isPdf
          ? ""
          : ` (stored as ${norm.mime}; no usable PDF)`),
  });

  // v1.9.7 (bug #29): the row/PDF/audit are already committed. If AI coding
  // throws, roll them back so the invoice isn't left orphaned in PROCESSING
  // (invisible to the approval queue) — otherwise the Upload-page Retry re-reads
  // the same vendor+number+total and is bounced as a "duplicate" against the ghost.
  try {
    const result = await processInvoiceAI(env, id, submittedBy);
    return { duplicate: false, invoiceId: id, ...result };
  } catch (err) {
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM approvals WHERE invoice_id = ?").bind(id),
        env.DB.prepare("DELETE FROM line_items WHERE invoice_id = ?").bind(id),
        env.DB.prepare("DELETE FROM pdf_files WHERE invoice_id = ?").bind(id),
        env.DB.prepare("DELETE FROM invoices WHERE id = ?").bind(id),
      ]);
      await deletePdf(env, key);
    } catch (cleanupErr) {
      console.error("[ingest] orphan cleanup after AI failure failed:", cleanupErr);
    }
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
  // v1.9.7 (bug #28): normalize vendor + number case/whitespace so a re-upload
  // whose OCR read the vendor as "SalesComm" still matches stored "SALESCOMM".
  return env.DB.prepare(
    "SELECT * FROM invoices WHERE UPPER(TRIM(vendor)) = UPPER(TRIM(?)) AND UPPER(TRIM(invoice_number)) = UPPER(TRIM(?)) AND total_amount = ? LIMIT 1",
  )
    .bind(vendor, invoiceNumber, totalAmount)
    .first<InvoiceRow>();
}

/** True for a synthetic "no invoice number" placeholder we mint when OCR finds
 *  none (`NO-INV-<timestamp>`). Each is unique by design, so they must never
 *  dedup against one another — two un-numbered invoices are not "the same". */
function isSyntheticInvoiceNumber(n: string): boolean {
  return /^NO-INV-\d+$/i.test((n || "").trim());
}

/**
 * v1.9.3 (Feature B) — duplicate detection by vendor + invoice number, matching
 * the DB's own case/whitespace-insensitive idiom (`UPPER(TRIM(...))`) so it lines
 * up with what a human calls "the same number". This catches a re-upload of the
 * SAME invoice even when OCR reads the total slightly differently each time.
 *
 * The total is NOT ignored: a candidate only counts as a duplicate when its
 * amount is within a small tolerance of this upload's total (the greater of $1
 * or 1% of the total). That guard is deliberate — a vendor that reuses a fixed
 * reference in the invoice-number field (a monthly utility statement, a revised
 * invoice with the same number but a new amount) has a materially different
 * total, so it is treated as a distinct invoice and still ingests rather than
 * being silently dropped. The exact-total case is still caught by `findDuplicate`.
 *
 * Ordered by closest-total then oldest so the reported `existingInvoiceId` is
 * deterministic. Returns null for synthetic NO-INV placeholders and empty numbers.
 */
export async function findDuplicateByNumber(
  env: Env,
  vendor: string,
  invoiceNumber: string,
  totalAmount: number,
): Promise<InvoiceRow | null> {
  if (isSyntheticInvoiceNumber(invoiceNumber)) return null;
  const norm = (invoiceNumber || "").trim().toUpperCase();
  if (!norm) return null;
  const total = Number.isFinite(totalAmount) ? totalAmount : 0;
  const tolerance = Math.max(1, Math.abs(total) * 0.01);
  return env.DB.prepare(
    // v1.9.7 (bug #28): normalize the vendor case/whitespace too — OCR casing
    // drift ("SALESCOMM" vs "SalesComm") otherwise defeats this dedup entirely.
    `SELECT * FROM invoices
       WHERE UPPER(TRIM(vendor)) = UPPER(TRIM(?)) AND UPPER(TRIM(invoice_number)) = ? AND ABS(total_amount - ?) <= ?
       ORDER BY ABS(total_amount - ?) ASC, created_at ASC
       LIMIT 1`,
  )
    .bind(vendor, norm, total, tolerance, total)
    .first<InvoiceRow>();
}
