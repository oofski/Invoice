/**
 * CCRMS receipt routes (NEW; owned by A2). §6.4.
 *
 *   POST   /transactions/:id/receipts — multipart { file, upload_method }; size/type
 *                                       check; store bytes; OCR cross-check
 *                                       (extract→normalize→matchCardholder);
 *                                       insert cc_receipts; tx→UPLOADED; on an
 *                                       executive Amex upload, fire the manager
 *                                       alert. 201 { receipt, ocr, transaction }.
 *   GET    /transactions/:id/receipts — list a transaction's receipts.
 *   GET    /receipts/:id/file         — stream the bytes inline (no signed URL).
 *   DELETE /receipts/:id              — manager-only best-effort delete → 204.
 *
 * Mounted at "/" by the mounter, so it declares the FULL sub-paths here.
 * Implements the §2 preamble (404→503→403→400→success).
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { uuid, nowIso } from "../../lib/util";
import { ccEntityLabel } from "../../cc/ccConstants";
import {
  ccReceiptKey,
  ccExtForType,
  ccPut,
  ccPutReductoRaw,
  ccGet,
  ccDelete,
} from "../../cc/ccStorage";
import { extractReceiptBytes, normalizeReceipt, matchCardholder } from "../../cc/receiptExtract";
import { sendCcManagerAlert } from "../../cc/ccEmail";
import { persistReceiptLines } from "../../cc/ccLines";
import { roundCents } from "../../cc/ccRules";
import type {
  CcSource,
  CcUploadMethod,
  MatchResult,
  NormalizedReceipt,
  Receipt,
  ReceiptOcrData,
  ReceiptRow,
  Tx,
  TxRow,
} from "../../cc/ccTypes";

export const receipts = new Hono<AppEnv>();

const MAX_RECEIPT_BYTES = 20 * 1024 * 1024; // 20MB
const ALLOWED_RECEIPT_TYPES = /pdf|jpe?g|png/i;
const UPLOAD_METHODS: CcUploadMethod[] = [
  "CAPITAL_ONE_APP",
  "INVOICE_IQ_APP",
  "MANUAL_UPLOAD",
  "MANAGER_UPLOAD",
];

function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN);
}

/** Manager, or the cardholder who owns this transaction (mirrors `ccScopeClause`). */
async function ownsOrManages(
  c: import("hono").Context<AppEnv>,
  tx: TxRow,
): Promise<boolean> {
  if (isManager(c)) return true;
  if (!tx.cardholder_id) return false;
  const u = user(c);
  const first = (u.name || "").trim().split(/\s+/)[0] ?? "";
  try {
    const row = await c.env.DB.prepare(
      "SELECT id FROM cc_cardholders WHERE id = ? AND (user_id = ? OR lower(first_name) = lower(?))",
    )
      .bind(tx.cardholder_id, u.id, first)
      .first<{ id: string }>();
    return !!row;
  } catch {
    return false;
  }
}

function fetchTx(env: AppEnv["Bindings"], id: string): Promise<TxRow | null> {
  return env.DB.prepare("SELECT * FROM cc_transactions WHERE id = ?")
    .bind(id)
    .first<TxRow>();
}

/** Joins a cardholder display name (or "UNMATCHED") and hydrates booleans. */
async function hydrateTx(env: AppEnv["Bindings"], r: TxRow): Promise<Tx> {
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
async function resolveManagerEmail(env: AppEnv["Bindings"]): Promise<string> {
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
async function splitSummary(env: AppEnv["Bindings"], txId: string): Promise<string> {
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

// ----- POST /transactions/:id/receipts --------------------------------------
receipts.post("/transactions/:id/receipts", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );

  const id = c.req.param("id");
  const tx = await fetchTx(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);
  if (!(await ownsOrManages(c, tx))) return c.json({ error: "Forbidden" }, 403);

  const form = await c.req.formData();
  const file = form.get("file") as unknown as
    | { arrayBuffer(): Promise<ArrayBuffer>; name?: string; type?: string; size?: number }
    | string
    | null;
  if (!file || typeof file === "string")
    return c.json({ error: "No file provided" }, 400);

  const fileName = file.name ?? "receipt";
  const fileType = file.type ?? "";
  if (!ALLOWED_RECEIPT_TYPES.test(fileType) && !ALLOWED_RECEIPT_TYPES.test(fileName))
    return c.json({ error: "Unsupported file type" }, 400);

  const buf = await file.arrayBuffer();
  if (buf.byteLength > MAX_RECEIPT_BYTES)
    return c.json({ error: "File too large (max 20MB)" }, 400);

  let uploadMethod = String(form.get("upload_method") ?? "").trim() as CcUploadMethod;
  if (!UPLOAD_METHODS.includes(uploadMethod)) uploadMethod = "MANUAL_UPLOAD";

  // Store the bytes in R2.
  const receiptId = uuid();
  const ext = ccExtForType(fileType);
  const r2Key = ccReceiptKey(receiptId, ext);
  await ccPut(c.env, r2Key, buf, fileType || "application/pdf");

  // OCR cross-check: extract → normalize → matchCardholder against the tx source.
  // Best-effort: a Reducto failure degrades to an empty/UNMATCHED result; the
  // receipt still stores. The cross-check NEVER overwrites tx.cardholder_id.
  let normalized: NormalizedReceipt = {
    merchant_name: "",
    transaction_date: "",
    total: null,
    card_last_4: "",
    cardholder_name: "",
    line_items: [],
    sales_tax: null,
  };
  let match: MatchResult = { cardholder_id: null, match: "UNMATCHED", confidence: "LOW" };
  try {
    const { raw, data } = await extractReceiptBytes(c.env, buf, fileName);
    normalized = normalizeReceipt(data);
    match = await matchCardholder(c.env, normalized, tx.source as CcSource);
    // If the OCR resolves a different cardholder than the transaction's, flag it.
    if (
      tx.cardholder_id &&
      match.cardholder_id &&
      match.cardholder_id !== tx.cardholder_id &&
      match.match === "MATCHED"
    ) {
      match = { ...match, match: "NAME_MISMATCH" };
    }
    try {
      await ccPutReductoRaw(c.env, r2Key, raw);
    } catch (e) {
      console.error("[cc] reducto sidecar write failed:", e);
    }
  } catch (e) {
    console.error("[cc] receipt OCR failed (storing receipt without OCR):", e);
  }

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

  const u = user(c);
  const at = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO cc_receipts
       (id, transaction_id, uploaded_by, upload_method, r2_key, file_name, file_type,
        file_size_bytes, ocr_extracted_data, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      receiptId,
      id,
      u.id,
      uploadMethod,
      r2Key,
      fileName,
      fileType || null,
      buf.byteLength,
      JSON.stringify(ocrData),
      at,
    )
    .run();

  // Best-effort: persist OCR line-by-line rows (cc_receipt_lines) for the new
  // line-coding flow. A throw here NEVER blocks the receipt insert / 201 (mirrors
  // the OCR try/catch); a receipt with no line_items + no sales_tax writes no rows
  // and the tx degrades to the legacy whole-charge split path.
  try {
    await persistReceiptLines(c.env, { transactionId: id, receiptId, normalized });
  } catch (e) {
    console.error("[cc] persistReceiptLines failed (receipt still stored):", e);
  }

  // Mark the transaction UPLOADED (manager check-off later flips to RECEIVED).
  await c.env.DB.prepare(
    "UPDATE cc_transactions SET receipt_status = ?, updated_at = ? WHERE id = ?",
  )
    .bind("UPLOADED", at, id)
    .run();

  // §7.2 manager alert: fire when a non-manager (executive/cardholder) uploads a
  // receipt in-app (Amex OR Capital One). Best-effort — sendCcManagerAlert never throws.
  if (!isManager(c)) {
    const managerEmail = await resolveManagerEmail(c.env);
    if (managerEmail) {
      const ch = tx.cardholder_id
        ? await c.env.DB.prepare(
            "SELECT first_name, last_name FROM cc_cardholders WHERE id = ?",
          )
            .bind(tx.cardholder_id)
            .first<{ first_name: string; last_name: string | null }>()
        : null;
      const cardholderName = ch
        ? `${ch.first_name}${ch.last_name ? ` ${ch.last_name}` : ""}`
        : u.name;
      await sendCcManagerAlert(c.env, {
        cardholderName,
        vendor: tx.vendor,
        amount: tx.amount,
        date: tx.transaction_date,
        splitSummary: await splitSummary(c.env, id),
        txId: id,
        managerEmail,
      });
    }
  }

  const receiptRow = await c.env.DB.prepare("SELECT * FROM cc_receipts WHERE id = ?")
    .bind(receiptId)
    .first<ReceiptRow>();
  const updatedTx = await fetchTx(c.env, id);

  return c.json(
    {
      receipt: receiptRow ? hydrateReceipt(receiptRow) : null,
      ocr: { ...normalized, match: match.match, confidence: match.confidence },
      transaction: updatedTx ? await hydrateTx(c.env, updatedTx) : null,
    },
    201,
  );
});

// ----- GET /transactions/:id/receipts ---------------------------------------
receipts.get("/transactions/:id/receipts", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );

  const id = c.req.param("id");
  const tx = await fetchTx(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);
  if (!(await ownsOrManages(c, tx))) return c.json({ error: "Forbidden" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT * FROM cc_receipts WHERE transaction_id = ? ORDER BY created_at DESC",
  )
    .bind(id)
    .all<ReceiptRow>();
  return c.json({ receipts: (rows.results ?? []).map(hydrateReceipt) });
});

// ----- GET /receipts/:id/file (stream bytes inline; no signed URL) ----------
receipts.get("/receipts/:id/file", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );

  const id = c.req.param("id");
  const receipt = await c.env.DB.prepare("SELECT * FROM cc_receipts WHERE id = ?")
    .bind(id)
    .first<ReceiptRow>();
  if (!receipt) return c.json({ error: "Not found" }, 404);

  const tx = await fetchTx(c.env, receipt.transaction_id);
  if (!tx) return c.json({ error: "Not found" }, 404);
  if (!(await ownsOrManages(c, tx))) return c.json({ error: "Forbidden" }, 403);

  const obj = await ccGet(c.env, receipt.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": receipt.file_type || "application/pdf",
      "content-disposition": `inline; filename="${receipt.file_name}"`,
    },
  });
});

// ----- DELETE /receipts/:id (manager only) ----------------------------------
receipts.delete("/receipts/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const receipt = await c.env.DB.prepare("SELECT * FROM cc_receipts WHERE id = ?")
    .bind(id)
    .first<ReceiptRow>();
  if (!receipt) return c.json({ error: "Not found" }, 404);

  // Best-effort R2 delete (bytes + reducto sidecar), then delete the row.
  try {
    await ccDelete(c.env, receipt.r2_key);
  } catch (e) {
    console.error("[cc] receipt R2 delete failed:", e);
  }
  await c.env.DB.prepare("DELETE FROM cc_receipts WHERE id = ?").bind(id).run();

  return c.body(null, 204);
});
