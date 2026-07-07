/**
 * CCRMS shared receipt-attach helper (NEW; backend agent — Feature A §2/§3).
 *
 * `attachReceiptToTx` is the SINGLE attach path shared by:
 *   - `POST /transactions/:id/receipts` (the canonical, tx-first upload), and
 *   - the inbox auto-match / manager-assign flows (`routes/cc/inbox.ts`).
 *
 * It does exactly what `POST /transactions/:id/receipts` did inline: INSERT a
 * `cc_receipts` row (reusing the already-stored `r2_key` + OCR JSON), best-effort
 * `persistReceiptLines`, flip the transaction to `UPLOADED`, and — when
 * `fireAlert` — send the manager "receipt ready for review" alert. Returns the
 * hydrated created receipt + the updated transaction (the exact 201 payload the
 * POST route returns).
 *
 * Reuses `persistReceiptLines` / `sendCcManagerAlert` READ-ONLY; never edits
 * `lib/*`. The alert path mirrors the route's `resolveManagerEmail` / `splitSummary`
 * helpers byte-for-byte so the refactor is behavior-identical.
 */
import type { Env } from "../lib/types";
import { ROLES } from "../lib/constants";
import { uuid, nowIso } from "../lib/util";
import { ccEntityLabel } from "./ccConstants";
import { roundCents, validateSplits } from "./ccRules";
import { persistReceiptLines } from "./ccLines";
import { sendCcManagerAlert } from "./ccEmail";
import type {
  CcSource,
  CcUploadMethod,
  EntitySplitInput,
  MatchResult,
  NormalizedReceipt,
  Receipt,
  ReceiptOcrData,
  ReceiptRow,
  Tx,
  TxRow,
} from "./ccTypes";

/** Fetches a transaction row by id (mirrors the route helper). */
function fetchTx(env: Env, id: string): Promise<TxRow | null> {
  return env.DB.prepare("SELECT * FROM cc_transactions WHERE id = ?").bind(id).first<TxRow>();
}

/** Joins a cardholder display name (or "UNMATCHED") and hydrates booleans. */
async function hydrateTx(env: Env, r: TxRow): Promise<Tx> {
  let name = "UNMATCHED";
  if (r.cardholder_id) {
    try {
      const ch = await env.DB.prepare(
        "SELECT first_name, last_name FROM cc_cardholders WHERE id = ?",
      )
        .bind(r.cardholder_id)
        .first<{ first_name: string; last_name: string | null }>();
      if (ch) name = `${ch.first_name}${ch.last_name ? ` ${ch.last_name}` : ""}`;
    } catch {
      /* keep UNMATCHED on lookup failure */
    }
  }
  return {
    id: r.id,
    source: r.source as CcSource,
    upload_batch_id: r.upload_batch_id,
    cardholder_id: r.cardholder_id,
    cardholder_name: name,
    transaction_date: r.transaction_date,
    posted_date: r.posted_date,
    vendor: r.vendor,
    description: r.description,
    category: r.category,
    amount: r.amount,
    is_credit: !!r.is_credit,
    is_payment: !!r.is_payment,
    receipt_status: r.receipt_status as Tx["receipt_status"],
    in_qb: !!r.in_qb,
    exp_acct: r.exp_acct,
    notes: r.notes,
    dedup_key: r.dedup_key,
    archived_at: r.archived_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/** Hydrates a receipt row (parses the OCR JSON). */
function hydrateReceipt(r: ReceiptRow): Receipt {
  let ocr: ReceiptOcrData | null = null;
  if (r.ocr_extracted_data) {
    try {
      ocr = JSON.parse(r.ocr_extracted_data) as ReceiptOcrData;
    } catch {
      ocr = null;
    }
  }
  return {
    id: r.id,
    transaction_id: r.transaction_id,
    uploaded_by: r.uploaded_by,
    upload_method: r.upload_method as CcUploadMethod,
    r2_key: r.r2_key,
    file_name: r.file_name,
    file_type: r.file_type,
    file_size_bytes: r.file_size_bytes,
    ocr_extracted_data: ocr,
    verified_by: r.verified_by,
    verified_at: r.verified_at,
    created_at: r.created_at,
  };
}

/**
 * Resolves the manager (Hunter) email for the §7.2 alert: the first active
 * credit-card-accountant (else admin) with an email, falling back to
 * RESEND_FROM_EMAIL so the alert still addresses someone.
 */
async function resolveManagerEmail(env: Env): Promise<string> {
  for (const role of [ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN]) {
    try {
      const row = await env.DB.prepare(
        "SELECT email FROM users WHERE role = ? AND is_active = 1 AND email IS NOT NULL AND email <> '' ORDER BY created_at ASC LIMIT 1",
      )
        .bind(role)
        .first<{ email: string }>();
      if (row?.email) return row.email;
    } catch {
      /* fall through to next role */
    }
  }
  return env.RESEND_FROM_EMAIL || "";
}

/** Builds a short "Nala $10.00, Admin $5.00" split summary for the alert. */
async function splitSummary(env: Env, txId: string): Promise<string> {
  try {
    const res = await env.DB.prepare(
      "SELECT entity_name, amount FROM cc_entity_splits WHERE transaction_id = ? ORDER BY created_at ASC",
    )
      .bind(txId)
      .all<{ entity_name: string; amount: number }>();
    const parts = (res.results ?? []).map(
      (s) => `${ccEntityLabel(s.entity_name)} $${roundCents(s.amount).toFixed(2)}`,
    );
    return parts.length ? parts.join(", ") : "(no split)";
  } catch {
    return "(no split)";
  }
}

/** Arguments to the shared attach helper. */
export interface AttachReceiptArgs {
  /** Target transaction id. */
  txId: string;
  /** R2 key where the bytes were already stored (re-used, not re-written). */
  r2Key: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  /** Normalized OCR result (degrades to an empty receipt when OCR failed). */
  normalized: NormalizedReceipt;
  /** Cardholder match outcome used to stamp `ocr_extracted_data`. */
  match: MatchResult;
  uploadMethod: CcUploadMethod;
  /** users.id of the uploader (the dropper). */
  uploadedBy: string;
  /** Fire the manager "receipt ready for review" alert (non-manager uploads). */
  fireAlert: boolean;
  /**
   * Display name of the uploader, used as the alert's `cardholderName` fallback
   * when the tx has no resolved cardholder (mirrors the route's `u.name` fallback).
   */
  uploaderName?: string;
}

/** Result of the shared attach helper (the POST route's 201 payload shape). */
export interface AttachReceiptResult {
  receipt: Receipt | null;
  transaction: Tx | null;
  receiptId: string;
}

/**
 * The single shared attach sequence: INSERT `cc_receipts` (reusing the stored
 * `r2_key` + OCR JSON), best-effort `persistReceiptLines`, flip the tx to
 * `UPLOADED`, and (when `fireAlert`) fire the manager alert. Returns the hydrated
 * created receipt + the updated transaction. Mirrors the prior inline POST body
 * exactly so its behavior is identical.
 */
export async function attachReceiptToTx(
  env: Env,
  args: AttachReceiptArgs,
): Promise<AttachReceiptResult> {
  const {
    txId,
    r2Key,
    fileName,
    fileType,
    sizeBytes,
    normalized,
    match,
    uploadMethod,
    uploadedBy,
    fireAlert,
    uploaderName,
  } = args;

  const receiptId = uuid();
  const at = nowIso();

  const ocrData: ReceiptOcrData = {
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

  await env.DB.prepare(
    `INSERT INTO cc_receipts
       (id, transaction_id, uploaded_by, upload_method, r2_key, file_name, file_type,
        file_size_bytes, ocr_extracted_data, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      receiptId,
      txId,
      uploadedBy,
      uploadMethod,
      r2Key,
      fileName,
      fileType || null,
      sizeBytes,
      JSON.stringify(ocrData),
      at,
    )
    .run();

  // Best-effort: persist OCR line-by-line rows (cc_receipt_lines) for the new
  // line-coding flow. A throw here NEVER blocks the receipt insert (mirrors the
  // OCR try/catch); a receipt with no line_items + no sales_tax writes no rows
  // and the tx degrades to the legacy whole-charge split path.
  try {
    await persistReceiptLines(env, { transactionId: txId, receiptId, normalized });
  } catch (e) {
    console.error("[cc] persistReceiptLines failed (receipt still stored):", e);
  }

  // Mark the transaction UPLOADED (manager check-off later flips to RECEIVED).
  await env.DB.prepare(
    "UPDATE cc_transactions SET receipt_status = ?, updated_at = ? WHERE id = ?",
  )
    .bind("UPLOADED", at, txId)
    .run();

  // §7.2 manager alert: fire when a non-manager (executive/cardholder) uploads a
  // receipt. Best-effort — sendCcManagerAlert never throws.
  if (fireAlert) {
    const tx = await fetchTx(env, txId);
    if (tx) {
      const managerEmail = await resolveManagerEmail(env);
      if (managerEmail) {
        const ch = tx.cardholder_id
          ? await env.DB.prepare(
              "SELECT first_name, last_name FROM cc_cardholders WHERE id = ?",
            )
              .bind(tx.cardholder_id)
              .first<{ first_name: string; last_name: string | null }>()
          : null;
        const cardholderName = ch
          ? `${ch.first_name}${ch.last_name ? ` ${ch.last_name}` : ""}`
          : uploaderName || "Cardholder";
        await sendCcManagerAlert(env, {
          cardholderName,
          vendor: tx.vendor,
          amount: tx.amount,
          date: tx.transaction_date,
          splitSummary: await splitSummary(env, txId),
          txId,
          managerEmail,
        });
      }
    }
  }

  const receiptRow = await env.DB.prepare("SELECT * FROM cc_receipts WHERE id = ?")
    .bind(receiptId)
    .first<ReceiptRow>();
  const updatedTx = await fetchTx(env, txId);

  return {
    receipt: receiptRow ? hydrateReceipt(receiptRow) : null,
    transaction: updatedTx ? await hydrateTx(env, updatedTx) : null,
    receiptId,
  };
}

/**
 * Applies a carried entity split to a transaction using the EXACT same validated
 * write path as `PUT /transactions/:id/splits` (splits.ts): `validateSplits`
 * (exact-to-cent sum vs `tx.amount`, known entities, non-negative) then replace-all
 * `DELETE FROM cc_entity_splits` + INSERT each non-zero `roundCents` row.
 *
 * Used by the Exec Mobile Receipt drop (apply-at-match) and the manager assign
 * (apply-on-later-match). Reuses `validateSplits`/`roundCents` READ-ONLY.
 *
 * Best-effort: returns whether it applied. On validation failure (e.g. the exec's
 * total ≠ the imported charge amount) it skips silently — leaving the tx unsplit
 * for the manager — and it NEVER throws into the caller (so a split failure can
 * never block the receipt attach).
 */
export async function applyPendingSplits(
  env: Env,
  transactionId: string,
  rows: EntitySplitInput[],
): Promise<boolean> {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return false;
    const tx = await fetchTx(env, transactionId);
    if (!tx) return false;

    const valid = validateSplits(tx.amount, rows);
    if (!valid.ok) return false; // amount mismatch / bad entity → leave for manager

    const at = nowIso();
    await env.DB.prepare("DELETE FROM cc_entity_splits WHERE transaction_id = ?")
      .bind(transactionId)
      .run();
    for (const s of rows) {
      const amount = roundCents(typeof s.amount === "number" ? s.amount : Number(s.amount));
      if (amount === 0) continue;
      await env.DB.prepare(
        "INSERT INTO cc_entity_splits (id, transaction_id, entity_name, amount, created_at) VALUES (?,?,?,?,?)",
      )
        .bind(uuid(), transactionId, s.entity_name, amount, at)
        .run();
    }
    await env.DB.prepare("UPDATE cc_transactions SET updated_at = ? WHERE id = ?")
      .bind(at, transactionId)
      .run();
    return true;
  } catch (e) {
    console.error("[cc] applyPendingSplits failed (leaving tx unsplit):", e);
    return false;
  }
}
