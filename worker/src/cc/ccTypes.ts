/**
 * CCRMS shared TypeScript types (NEW) — the SINGLE source of truth for every CC
 * route (A2/A3) and for shape-parity with the renderer's `ccApi.ts`.
 *
 * Two layers:
 *   - DB row types (`*Row`) mirror the D1 columns in `ccMigrations.ts` exactly:
 *     booleans are INTEGER 0/1, JSON arrays are TEXT, timestamps are ISO TEXT.
 *   - Hydrated DTO types (the un-suffixed names) are what routes return as JSON:
 *     0/1 booleans become real `boolean`s and joins/relations are embedded.
 *
 * Enum string-unions are re-exported from `ccConstants.ts` so there is one
 * canonical set of literals across the module.
 */
import type {
  CcSource,
  CcCardSource,
  CcReceiptStatus,
  CcUploadMethod,
  CcBatchStatus,
  CcDelivery,
} from "./ccConstants";

export type {
  CcSource,
  CcCardSource,
  CcReceiptStatus,
  CcUploadMethod,
  CcBatchStatus,
  CcDelivery,
};

// ---------------------------------------------------------------------------
// DB row types (verbatim column shapes — booleans are 0/1 INTEGER)
// ---------------------------------------------------------------------------

/** `cc_cardholders` row. */
export interface CardholderRow {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  card_source: string; // CcCardSource
  cap_one_last4: string | null;
  amex_last5: string | null;
  amex_sheet_name: string | null;
  user_id: string | null;
  is_active: number; // 0/1
  created_at: string;
  updated_at: string;
}

/** `cc_upload_batches` row (includes the ratified `staged_rows` JSON column). */
export interface UploadBatchRow {
  id: string;
  uploaded_by: string;
  source: string; // CcSource
  original_filename: string;
  r2_key: string | null;
  period_start: string | null;
  period_end: string | null;
  transaction_count: number;
  duplicate_count: number;
  skipped_count: number;
  status: string; // CcBatchStatus
  error_message: string | null;
  /** JSON array of normalized staged rows, written at /preview, re-read at /confirm. */
  staged_rows: string | null;
  created_at: string;
}

/** `cc_transactions` row. */
export interface TxRow {
  id: string;
  source: string; // CcSource
  upload_batch_id: string | null;
  cardholder_id: string | null; // NULL => UNMATCHED
  transaction_date: string; // ISO YYYY-MM-DD
  posted_date: string | null;
  vendor: string;
  description: string | null;
  category: string | null;
  amount: number; // positive = charge
  is_credit: number; // 0/1
  is_payment: number; // 0/1
  receipt_status: string; // CcReceiptStatus
  in_qb: number; // 0/1
  exp_acct: string | null;
  notes: string | null;
  dedup_key: string | null;
  created_at: string;
  updated_at: string;
}

/** `cc_entity_splits` row. */
export interface EntitySplitRow {
  id: string;
  transaction_id: string;
  entity_name: string; // canonical CcEntity
  amount: number;
  created_at: string;
}

/** `cc_receipts` row. */
export interface ReceiptRow {
  id: string;
  transaction_id: string;
  uploaded_by: string;
  upload_method: string; // CcUploadMethod
  r2_key: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  ocr_extracted_data: string | null; // JSON
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

/** `cc_notifications` row. */
export interface NotificationRow {
  id: string;
  batch_id: string | null;
  cardholder_id: string;
  sent_by: string;
  email_to: string;
  subject: string;
  body_html: string;
  transaction_ids: string; // JSON array of tx ids
  delivery: string; // CcDelivery
  is_followup: number; // 0/1
  sent_at: string | null;
  opened_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Hydrated DTO types (returned as JSON by routes — booleans real, relations embedded)
// ---------------------------------------------------------------------------

/** Hydrated cardholder. */
export interface Cardholder {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  card_source: CcCardSource;
  cap_one_last4: string | null;
  amex_last5: string | null;
  amex_sheet_name: string | null;
  user_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Hydrated upload batch (returned in upload history). */
export interface UploadBatch {
  id: string;
  uploaded_by: string;
  source: CcSource;
  original_filename: string;
  r2_key: string | null;
  period_start: string | null;
  period_end: string | null;
  transaction_count: number;
  duplicate_count: number;
  skipped_count: number;
  status: CcBatchStatus;
  error_message: string | null;
  created_at: string;
}

/** Hydrated transaction (booleans real; `cardholder_name` joined). */
export interface Tx {
  id: string;
  source: CcSource;
  upload_batch_id: string | null;
  cardholder_id: string | null;
  cardholder_name: string; // joined; "UNMATCHED" when cardholder_id is null
  transaction_date: string;
  posted_date: string | null;
  vendor: string;
  description: string | null;
  category: string | null;
  amount: number;
  is_credit: boolean;
  is_payment: boolean;
  receipt_status: CcReceiptStatus;
  in_qb: boolean;
  exp_acct: string | null;
  notes: string | null;
  dedup_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Hydrated entity split (the modal/API shape). */
export interface EntitySplit {
  id: string;
  transaction_id: string;
  entity_name: string;
  amount: number;
}

/** A split row as supplied by the client to `PUT /splits` (no id yet). */
export interface EntitySplitInput {
  entity_name: string;
  amount: number;
}

/** Hydrated receipt (file bytes are streamed separately; not embedded). */
export interface Receipt {
  id: string;
  transaction_id: string;
  uploaded_by: string;
  upload_method: CcUploadMethod;
  r2_key: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  ocr_extracted_data: ReceiptOcrData | null;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

/** Hydrated notification. */
export interface Notification {
  id: string;
  batch_id: string | null;
  cardholder_id: string;
  sent_by: string;
  email_to: string;
  subject: string;
  body_html: string;
  transaction_ids: string[];
  delivery: CcDelivery;
  is_followup: boolean;
  sent_at: string | null;
  opened_at: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Receipt-extraction DTOs (mirrors `extract.ts` narrowing shapes)
// ---------------------------------------------------------------------------

/** A single normalized receipt line item. */
export interface NormalizedReceiptLine {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
}

/** Output of `normalizeReceipt(data)` (see `receiptExtract.ts`). */
export interface NormalizedReceipt {
  merchant_name: string;
  transaction_date: string;
  total: number | null;
  card_last_4: string;
  cardholder_name: string;
  line_items: NormalizedReceiptLine[];
  /** Total sales tax printed on the receipt (the tax line); null when absent. */
  sales_tax: number | null;
}

/** Confidence band of a cardholder match. */
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

/** Outcome of a cardholder match. */
export type MatchKind = "MATCHED" | "UNMATCHED" | "NAME_MISMATCH";

/** Result of `matchCardholder(env, receipt, source)`. */
export interface MatchResult {
  cardholder_id: string | null;
  match: MatchKind;
  confidence: MatchConfidence;
}

/**
 * The JSON persisted into `cc_receipts.ocr_extracted_data`: the normalized
 * receipt fields plus the match outcome and the resolved cardholder.
 */
export interface ReceiptOcrData {
  merchant_name: string;
  transaction_date: string;
  total: number | null;
  card_last_4: string;
  cardholder_name: string;
  line_items?: NormalizedReceiptLine[];
  /** Total sales tax printed on the receipt; null/absent when none. */
  sales_tax?: number | null;
  match: MatchKind;
  confidence: MatchConfidence;
  resolved_cardholder_id: string | null;
}

// ---------------------------------------------------------------------------
// Line-by-line receipt coding (cc_receipt_lines / cc_line_allocations)
// ---------------------------------------------------------------------------

/** A line's kind: a normal item line, or the single per-receipt sales-tax line. */
export type CcLineKind = "ITEM" | "TAX";

/** `cc_receipt_lines` row (verbatim column shape — booleans are 0/1 INTEGER). */
export interface ReceiptLineRow {
  id: string;
  transaction_id: string;
  receipt_id: string | null; // source cc_receipts.id (NULL for a manual line)
  line_index: number;
  kind: string; // CcLineKind
  description: string | null;
  quantity: number | null;
  unit_price: number | null;
  amount: number;
  is_coded: number; // 0/1
  created_at: string;
  updated_at: string;
}

/** `cc_line_allocations` row (verbatim column shape — booleans are 0/1 INTEGER). */
export interface LineAllocationRow {
  id: string;
  line_id: string;
  transaction_id: string;
  entity_name: string; // one of the 7 CC_ENTITIES
  location: string; // a BUSINESS_CLASSES[entity] member, or the entity name
  gl_category: string; // 'Service Costs' | 'Retail / Product Costs' | 'Sales/Use Tax'
  amount: number;
  is_tax: number; // 0/1
  created_at: string;
}

/** Hydrated per-line allocation slice (the API/DTO shape; booleans real). */
export interface LineAllocation {
  id?: string;
  entity_name: string;
  location: string;
  gl_category: string;
  amount: number;
  is_tax?: boolean;
}

/** Hydrated receipt line with its allocations (the API/DTO shape; booleans real). */
export interface ReceiptLine {
  id?: string;
  client_id?: string;
  receipt_id?: string | null;
  line_index?: number;
  kind: CcLineKind;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount: number;
  is_coded?: boolean;
  allocations: LineAllocation[];
}

/** GET/PUT `/transactions/:id/lines` response payload. */
export interface LinesResponse {
  lines: ReceiptLine[];
  transaction_amount: number;
  allocated_total: number;
  remaining: number;
  reconciled: boolean;
}

// ---------------------------------------------------------------------------
// Receipt inbox / auto-match (cc_receipt_inbox) — Feature A
// ---------------------------------------------------------------------------

/** Queue status of an inbox (un-attached drop) row. */
export type InboxStatus = "PENDING_MATCH" | "MATCHED" | "RETURNED";

/** `cc_receipt_inbox` row (verbatim column shape; booleans/JSON as stored TEXT). */
export interface InboxRow {
  id: string;
  uploaded_by: string;
  cardholder_id: string | null;
  source_guess: string | null; // CcSource | null (which matcher resolved)
  r2_key: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  ocr_extracted_data: string | null; // JSON: ReceiptOcrData
  status: string; // InboxStatus
  matched_transaction_id: string | null;
  matched_receipt_id: string | null;
  candidate_transaction_ids: string | null; // JSON array of tx ids
  return_note: string | null;
  returned_by: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A candidate transaction joined onto a queued inbox item (the manager queue). */
export interface CandidateTx {
  id: string;
  vendor: string;
  amount: number;
  transaction_date: string;
  receipt_status: CcReceiptStatus;
  cardholder_id: string | null;
  cardholder_name: string; // joined; "UNMATCHED" when cardholder_id is null
}

/** Hydrated inbox item (booleans/JSON parsed; candidates joined for the queue). */
export interface InboxItem {
  id: string;
  uploaded_by: string;
  cardholder_id: string | null;
  cardholder_name: string; // joined; "UNMATCHED" when unresolved
  source_guess: CcSource | null;
  r2_key: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  ocr_extracted_data: ReceiptOcrData | null;
  status: InboxStatus;
  matched_transaction_id: string | null;
  matched_receipt_id: string | null;
  candidate_transaction_ids: string[];
  return_note: string | null;
  returned_by: string | null;
  resolved_by: string | null;
  created_at: string;
  updated_at: string;
  /** Joined candidate transactions (manager queue list only). */
  candidates?: CandidateTx[];
}

/**
 * Outcome of `matchReceiptToTransaction(env, normalized)` (§2). Carries the
 * resolved cardholder + which matcher source resolved it so the inbox row can be
 * stamped regardless of branch.
 */
export type MatchOutcome =
  | {
      kind: "matched";
      transactionId: string;
      cardholderId: string | null;
      sourceGuess: CcSource | null;
      match: MatchResult;
    }
  | {
      kind: "queued";
      candidateIds: string[];
      cardholderId: string | null;
      sourceGuess: CcSource | null;
      match: MatchResult;
    };

/** One per-file result returned by the bulk drop endpoint (`POST .../inbox`). */
export interface PerFileResult {
  file_name: string;
  status: "MATCHED" | "PENDING_MATCH" | "ERROR";
  inbox_id: string;
  matched_transaction_id?: string;
  candidate_transaction_ids?: string[];
  /** Normalized receipt + match/confidence (same shape as today's upload `ocr`). */
  ocr?: NormalizedReceipt & { match: MatchKind; confidence: MatchConfidence };
  error?: string;
}

// ---------------------------------------------------------------------------
// Upload preview / staging DTOs
// ---------------------------------------------------------------------------

/** One entry in a preview's per-cardholder breakdown. */
export interface CardholderBreakdownEntry {
  cardholder_id: string | null;
  name: string; // cardholder display name, or "UNMATCHED"
  count: number;
}

/** The `preview` payload returned by `POST /uploads/preview` (PREVIEW status). */
export interface PreviewResult {
  row_count: number;
  new_count: number;
  duplicate_count: number;
  skipped_count: number;
  period_start: string | null;
  period_end: string | null;
  unmatched_cards: string[];
  cardholder_breakdown: CardholderBreakdownEntry[];
}

/**
 * A normalized, source-agnostic staged transaction row — the shape persisted in
 * `cc_upload_batches.staged_rows` at /preview and re-read at /confirm. Carries the
 * inferred transaction fields, the matched cardholder, the dedup key, and (for
 * Amex) the per-entity splits derived from the template columns.
 */
export interface StagedTxRow {
  source: CcSource;
  cardholder_id: string | null;
  transaction_date: string;
  posted_date: string | null;
  vendor: string;
  description: string | null;
  category: string | null;
  amount: number;
  is_credit: boolean;
  is_payment: boolean;
  receipt_status: CcReceiptStatus;
  in_qb: boolean;
  exp_acct: string | null;
  dedup_key: string;
  /** Canonical-entity splits for Amex rows; empty for Cap One. */
  splits: EntitySplitInput[];
  /** True when this row collides with an already-committed transaction. */
  is_duplicate: boolean;
  /** The card last-4/last-5 string this row was matched on (for unmatched reporting). */
  card_digits: string | null;
}
