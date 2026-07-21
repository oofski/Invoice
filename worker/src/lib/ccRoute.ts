/**
 * Additive AP→Credit-Card reroute (NEW; invoice agent).
 *
 * `maybeRouteInvoiceToCc(env, invoiceId)` runs AFTER an invoice is finalized in
 * `processInvoiceAI`. When the OCR text indicates THIS invoice was PAID BY A
 * CREDIT/DEBIT CARD, the invoice is lifted out of the AP flow and dropped into the
 * Credit Card module's receipt inbox (auto-matched to a CC transaction when
 * possible, else queued for the accountant to triage) — mirroring the reference
 * `POST /receipts/inbox` flow. The source invoice is then ARCHIVED (never deleted),
 * so a false positive is fully recoverable: the invoice can be un-archived and the
 * inbox row deleted/returned.
 *
 * DESIGN CONTRACT — additive, safe, reversible:
 *   - NEVER throws. Every step is wrapped; any failure is logged and the invoice is
 *     simply left as a normal AP invoice. This function must NEVER block or break
 *     invoice ingestion / reprocessing.
 *   - NOTHING is deleted. The invoice is archived (`archived_at`), and the receipt
 *     lands in the CC inbox — both are reversible.
 *   - Gated on `ccReady(env)` (the CC schema migration has run). `isCcEnabled` is a
 *     per-USER visibility gate with no non-user form; the system-level readiness
 *     signal used everywhere alongside it is `ccReady`, so that is the gate here
 *     (there is no user in the finalize path). When CC is not ready, this is a no-op
 *     and the invoice stays in AP.
 *   - Safe ordering: the CC landing (attach + inbox row) is created BEFORE the
 *     invoice is archived, so a mid-flight failure can never archive an invoice that
 *     has nowhere to land. If the inbox row was created but the archive step fails,
 *     the invoice merely appears in BOTH AP and CC (recoverable), never lost.
 *
 * Reuses the CC helpers (`matchReceiptToTransaction`, `attachReceiptToTx`,
 * `ccReceiptKey`/`ccExtForType`/`ccPut`) READ-ONLY and mirrors the `inbox.ts` POST
 * insert columns/values exactly.
 */
import type { Env } from "./types";
import { getInvoice, audit } from "./db";
import { getPdf } from "./storage";
import { extractTextFromReducto } from "./reducto";
import { normalizeExtract } from "./extract";
import { AUDIT_ACTION } from "./constants";
import { uuid, nowIso } from "./util";
import { ccReady } from "../cc/flag";
import { ccReceiptKey, ccExtForType, ccPut } from "../cc/ccStorage";
import { matchReceiptToTransaction } from "../cc/receiptMatch";
import { attachReceiptToTx } from "../cc/receiptAttach";
import type {
  MatchResult,
  NormalizedReceipt,
  NormalizedReceiptLine,
  ReceiptOcrData,
} from "../cc/ccTypes";

/**
 * A COMPLETED-payment verb sitting close to a specific card term (same
 * line/sentence — the `[^.\n]{0,30}` window stops at any period or newline, so a
 * match cannot straddle a sentence boundary). This catches "paid by credit card",
 * "charged to card ending 4242", "settled by Mastercard", "paid via Visa ****1234".
 * It deliberately does NOT include the bare noun "payment", so an accepted-methods
 * blurb ("we accept Visa / Mastercard") — which carries no completed-payment verb —
 * cannot trigger it.
 */
const PAID_BY_CARD =
  /\b(?:paid|charged|settled|remit\w*)\b[^.\n]{0,30}?\b(?:credit\s*cards?|debit\s*cards?|visa|master\s*card|mastercard|amex|american\s+express|discover|card\s+ending|card\s*\*+\s*\d)/;

/**
 * Explicit "this invoice was paid on a card" phrasings that state the payment
 * method directly. Each requires a specific connective (method/type/made/received/
 * processed, or "paid by/via/with"), so a generic "payment terms" or "we accept …"
 * line cannot match: "payment method: credit card", "cc payment", "credit card
 * payment", "paid by card", "payment received via debit card", "charged to card
 * ending".
 */
const CARD_PAYMENT_PHRASE =
  /(?:payment\s+(?:method|type)\s*[:\-]?\s*(?:credit|debit)?\s*card)|(?:paid\s+(?:by|via|with|w\/)\s+(?:a\s+)?(?:credit\s*card|debit\s*card|card))|(?:\bcc\s+payment\b)|(?:(?:credit|debit)\s*card\s+payment)|(?:charged\s+to\s+card\s+ending)|(?:payment\s+(?:made|received|processed)\s+(?:by|via|with|on|using)?\s*(?:a\s+)?(?:credit|debit)\s*card)/;

/**
 * A MASKED / last-4 card reference — a card term immediately qualified by an
 * ending/masked-digits marker and 3-4 trailing digits, e.g. "card ending 1234",
 * "Visa ****1234", "Mastercard no. 4242", "card *5678". A specific card number is a
 * standalone "an actual card was charged" signal (it never appears in a generic
 * "we accept credit cards" blurb), so it needs no separate payment verb. The digit
 * requirement is what keeps it precise: bare brand mentions do NOT match.
 */
const CARD_LAST4 =
  /\b(?:credit\s*card|debit\s*card|card|visa|master\s*card|mastercard|amex|american\s+express|discover)\b[^.\n]{0,15}?(?:ending(?:\s+in)?|no\.?|number|#|\*+|x{2,})\s*\*?\s*\d{3,4}\b/;

/**
 * True when `text` (any invoice OCR text) indicates the invoice was PAID BY A CARD.
 * Precise and low-false-positive: a card term must co-occur with a completed-payment
 * verb, an explicit payment-method phrase, or a specific masked/last-4 card number.
 * Case-insensitive; returns false on any doubt (empty text, mere "we accept credit
 * cards" mentions, "payment terms" boilerplate, etc.).
 */
export function detectPaidByCard(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return PAID_BY_CARD.test(t) || CARD_PAYMENT_PHRASE.test(t) || CARD_LAST4.test(t);
}

/**
 * A recognized CARD tender: a card brand, a "credit/debit card", "card ending",
 * "card on file", a bare "CC", "charge card", or masked last-4 digits.
 */
const CARD_TENDER =
  /\b(?:credit\s*card|debit\s*card|visa|master\s*card|mastercard|amex|american\s+express|discover|card\s+ending|card\s+on\s+file|charge\s*card|cc)\b|\*{2,}\s*\d{3,4}/;

/** Non-payment "card" nouns that must NOT be read as a card tender. */
const NON_TENDER_CARD = /\b(?:gift|loyalty|rewards?|membership|punch|business|library|id|key)\s+cards?\b/;

/**
 * True when the invoice's extracted `payment_method` field (Reducto's verbatim
 * "how it was paid") names a CARD tender. Unlike the free-text OCR scan this field
 * ALREADY describes the tender, so no co-occurring payment verb is required — any
 * card brand / "credit|debit card" / masked-card reference is sufficient. Still
 * rejects non-card tenders (check, ACH, cash, wire) and non-payment "card" nouns
 * (gift/loyalty/membership card).
 */
export function paymentMethodIsCard(paymentMethod: string | null | undefined): boolean {
  if (!paymentMethod) return false;
  const t = paymentMethod.toLowerCase();
  if (NON_TENDER_CARD.test(t)) return false;
  if (CARD_TENDER.test(t)) return true;
  // A bare "card" / "by card" / "carded" tender with no disqualifier reads as a
  // payment card (this field is already known to describe how the invoice was paid).
  return /\bcard(?:ed)?\b/.test(t);
}

/** Builds the `ReceiptOcrData` JSON persisted in `cc_receipt_inbox.ocr_extracted_data`. */
function ocrJson(normalized: NormalizedReceipt, match: MatchResult): ReceiptOcrData {
  return {
    merchant_name: normalized.merchant_name,
    transaction_date: normalized.transaction_date,
    total: normalized.total,
    card_last_4: normalized.card_last_4,
    cardholder_name: normalized.cardholder_name,
    line_items: normalized.line_items,
    sales_tax: normalized.sales_tax,
    match: match.match,
    confidence: match.confidence,
    resolved_cardholder_id: match.cardholder_id,
  };
}

/**
 * If the finalized invoice `invoiceId` reads as paid-by-card, route it into the CC
 * module and archive it. Best-effort and NEVER throws — a failure at any step
 * leaves the invoice untouched as a normal AP invoice.
 */
export async function maybeRouteInvoiceToCc(env: Env, invoiceId: string): Promise<void> {
  try {
    const inv = await getInvoice(env, invoiceId);
    if (!inv) return;
    // Already archived (e.g. a reprocess of a previously-routed invoice) → no-op.
    if (inv.archived_at) return;
    if (!inv.textract_raw) return;

    // --- 1. DETECT (precise; low false-positive). ---------------------------------
    // The invoice pipeline persists `textract_raw` as the STRUCTURED extract
    // (JSON.stringify of Reducto /extract data), NOT raw OCR text — so the primary
    // signal is the dedicated `payment_method` field Reducto now fills ("how it was
    // paid"). The free-text scan is kept only as a defensive fallback for any legacy
    // row whose stored extract still embeds flattened text.
    let parsed: unknown;
    try {
      parsed = JSON.parse(inv.textract_raw);
    } catch {
      return; // unparseable extraction → cannot safely detect → stay in AP
    }
    const extracted = normalizeExtract(parsed);
    const ocrText = extractTextFromReducto(parsed);
    if (!paymentMethodIsCard(extracted.payment_method) && !detectPaidByCard(ocrText)) return;

    // --- 2. GATE: CC schema must be migrated (system-level readiness). -----------
    if (!(await ccReady(env))) return;

    // --- 3a. Read the invoice PDF bytes; copy them into CC storage. --------------
    const pdfMeta = await env.DB.prepare(
      "SELECT r2_key, file_name FROM pdf_files WHERE invoice_id = ?",
    )
      .bind(invoiceId)
      .first<{ r2_key: string; file_name: string }>();
    if (!pdfMeta?.r2_key) return; // no PDF to hand to CC → stay in AP
    const obj = await getPdf(env, pdfMeta.r2_key);
    if (!obj) return;
    const buf = await obj.arrayBuffer();

    const fileName = pdfMeta.file_name || "invoice.pdf";
    const fileType = "application/pdf";
    const inboxId = uuid();
    const ext = ccExtForType(fileType);
    const r2Key = ccReceiptKey(inboxId, ext);
    await ccPut(env, r2Key, buf, fileType);

    // --- 3b. Build a NormalizedReceipt from the invoice fields (card fields empty).
    // `extracted` (normalizeExtract) was computed above during detection.
    const line_items: NormalizedReceiptLine[] = extracted.line_items.map((li) => ({
      description: li.description,
      quantity: li.quantity ?? null,
      unit_price: li.unit_price ?? null,
      amount: li.amount ?? null,
    }));
    const normalized: NormalizedReceipt = {
      merchant_name: inv.vendor || "",
      transaction_date: inv.inv_date || "",
      total: typeof inv.total_amount === "number" ? inv.total_amount : null,
      card_last_4: "",
      cardholder_name: "",
      line_items,
      sales_tax: inv.sales_tax ?? null,
    };

    // Attribute the drop to the invoice submitter (else a stable system sentinel);
    // `uploaded_by` is NOT NULL. The manager inbox lists PENDING_MATCH regardless of
    // uploader, so a system-attributed row is still triageable.
    const uploadedBy = inv.submitted_by || "SYSTEM";

    // --- 3c. Auto-match; attach (MATCHED) or queue (PENDING_MATCH). --------------
    // matchReceiptToTransaction never throws (degrades to queued). With empty card
    // fields the cardholder cannot resolve, so an invoice normally queues — the safe
    // default (lands in the accountant's inbox for triage).
    const outcome = await matchReceiptToTransaction(env, normalized);
    const at = nowIso();
    const ocr = ocrJson(normalized, outcome.match);
    let inboxStatus: "MATCHED" | "PENDING_MATCH";

    if (outcome.kind === "matched") {
      // Auto-attach via the shared helper, then record the MATCHED inbox row
      // (mirrors inbox.ts POST). fireAlert:false — this is a system/manager reroute.
      const attached = await attachReceiptToTx(env, {
        txId: outcome.transactionId,
        r2Key,
        fileName,
        fileType,
        sizeBytes: buf.byteLength,
        normalized,
        match: outcome.match,
        uploadMethod: "MANAGER_UPLOAD",
        uploadedBy,
        fireAlert: false,
        sourceIsShared: true, // shared mobile inbox-drop key (H5)
      });
      await env.DB.prepare(
        `INSERT INTO cc_receipt_inbox
           (id, uploaded_by, cardholder_id, source_guess, r2_key, file_name, file_type,
            file_size_bytes, ocr_extracted_data, status, matched_transaction_id,
            matched_receipt_id, candidate_transaction_ids, resolved_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          inboxId,
          uploadedBy,
          outcome.cardholderId,
          outcome.sourceGuess,
          r2Key,
          fileName,
          fileType || null,
          buf.byteLength,
          JSON.stringify(ocr),
          "MATCHED",
          outcome.transactionId,
          attached.receiptId,
          JSON.stringify([outcome.transactionId]),
          uploadedBy,
          at,
          at,
        )
        .run();
      inboxStatus = "MATCHED";
    } else {
      // Queue: PENDING_MATCH with candidates (no cc_receipts row; tx untouched).
      // pending_splits is null — an invoice carries no exec entity split.
      await env.DB.prepare(
        `INSERT INTO cc_receipt_inbox
           (id, uploaded_by, cardholder_id, source_guess, r2_key, file_name, file_type,
            file_size_bytes, ocr_extracted_data, status, candidate_transaction_ids,
            pending_splits, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
        .bind(
          inboxId,
          uploadedBy,
          outcome.cardholderId,
          outcome.sourceGuess,
          r2Key,
          fileName,
          fileType || null,
          buf.byteLength,
          JSON.stringify(ocr),
          "PENDING_MATCH",
          JSON.stringify(outcome.candidateIds),
          null,
          at,
          at,
        )
        .run();
      inboxStatus = "PENDING_MATCH";
    }

    // --- 3d. ARCHIVE the source invoice (reversible; never deleted) + audit. -----
    // Done LAST so the CC landing already exists; if this fails, the invoice stays
    // in AP too (a recoverable duplicate), never stranded. NOTE: the `invoices`
    // table has no `updated_at` column (see pdfStamp.ts) — mirror the existing
    // archive routes and set only `archived_at`.
    await env.DB.prepare("UPDATE invoices SET archived_at = ? WHERE id = ?")
      .bind(at, invoiceId)
      .run();

    await audit(env, {
      invoiceId,
      userId: inv.submitted_by ?? null,
      action: AUDIT_ACTION.INVOICE_REROUTED,
      prevValue: { archived_at: null, status: inv.status },
      newValue: { archived_at: at, cc_inbox_id: inboxId, cc_status: inboxStatus },
      note: `Routed to Credit Cards — detected paid by credit card (inbox ${inboxId}, ${inboxStatus})`,
    });
  } catch (e) {
    // Best-effort: any failure leaves the invoice as a normal AP invoice.
    console.error("[ccRoute] maybeRouteInvoiceToCc failed (invoice stays in AP):", e);
  }
}
