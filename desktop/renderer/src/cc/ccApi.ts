/**
 * Typed REST wrappers for the Credit-Card Receipt Management (CCRMS) module.
 *
 * Every endpoint lives under `/api/cc/*` and rides the existing bearer-auth
 * `api` client (see `lib/api.ts`). The response interfaces below are
 * **redeclared locally** from the frozen §5/§6 integration contract — they are
 * intentionally NOT imported from the worker (`worker/src/cc/ccTypes.ts`) so a
 * backend file rename can never break the renderer build.
 *
 * The flag (404-if-disabled) / migration (503) / role gates are enforced
 * server-side; the renderer mirrors the flag for nav/route gating via
 * `useCcEnabled()` and otherwise lets `ApiError` surface the server's message.
 */

import { api, ApiError, getApiBase, getToken } from "@/lib/api";

/**
 * Local PUT helper. The shared `api` client (lib/api.ts) exposes
 * get/post/patch/del/postForm/getBlob but no `put`, and that file is owned by
 * the invoice slice (we must not edit it). The splits endpoint is the only
 * `PUT` in the CC contract, so we issue it here with the same bearer-auth +
 * JSON conventions and the same ApiError surface.
 */
async function putJson<T>(path: string, data: unknown): Promise<T> {
  const base = getApiBase();
  const url = /^https?:\/\//.test(path)
    ? path
    : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(data) });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? `Network error: ${err.message}` : "Network error",
      0,
      null,
    );
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Enums / unions (mirror the contract)
// ---------------------------------------------------------------------------

export type CcSource = "CAPITAL_ONE" | "AMEX";
export type ReceiptStatus =
  | "PENDING"
  | "UPLOADED"
  | "RECEIVED"
  | "NOT_REQUIRED"
  | "WAIVED";
export type UploadMethod =
  | "CAPITAL_ONE_APP"
  | "INVOICE_IQ_APP"
  | "MANUAL_UPLOAD"
  | "MANAGER_UPLOAD";
export type BatchStatus =
  | "PREVIEW"
  | "PROCESSING"
  | "COMPLETE"
  | "ERROR"
  | "BLANK_TEMPLATE";
export type NotificationDelivery =
  | "SENT"
  | "FAILED"
  | "NOT_CONFIGURED"
  | "MAILTO";
export type MatchResult = "MATCHED" | "UNMATCHED" | "NAME_MISMATCH";
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW";

// ---------------------------------------------------------------------------
// Row / DTO shapes
// ---------------------------------------------------------------------------

export interface Cardholder {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  card_source: "CAPITAL_ONE" | "AMEX" | "BOTH";
  cap_one_last4: string | null;
  amex_last5: string | null;
  amex_sheet_name: string | null;
  user_id: string | null;
  is_active: boolean | number;
  created_at: string;
  updated_at?: string;
}

export interface CcTransaction {
  id: string;
  source: CcSource;
  upload_batch_id: string | null;
  cardholder_id: string | null;
  cardholder_name: string; // joined; "UNMATCHED" when null
  transaction_date: string; // YYYY-MM-DD
  posted_date: string | null;
  vendor: string;
  description: string | null;
  category: string | null;
  amount: number; // positive = charge
  is_credit: boolean;
  is_payment: boolean;
  receipt_status: ReceiptStatus;
  in_qb: boolean;
  exp_acct: string | null;
  notes: string | null;
  dedup_key?: string | null;
  archived_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntitySplit {
  id: string;
  transaction_id: string;
  entity_name: string; // canonical (see ccConstants)
  amount: number;
}

export interface Receipt {
  id: string;
  transaction_id: string;
  uploaded_by: string;
  upload_method: UploadMethod;
  r2_key: string;
  file_name: string;
  file_type: string | null;
  file_size_bytes: number | null;
  ocr_extracted_data: string | null; // JSON string
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

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
  status: BatchStatus;
  error_message: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  batch_id: string | null;
  cardholder_id: string;
  sent_by: string;
  email_to: string;
  subject: string;
  body_html: string; // truncated/omitted in list, full in :id
  transaction_ids: string[]; // server returns an already-parsed array of tx ids
  delivery: NotificationDelivery;
  is_followup: boolean | number;
  sent_at: string | null;
  opened_at: string | null;
  created_at: string;
  // convenience joins the server may add:
  cardholder_name?: string;
  tx_count?: number;
}

export interface NormalizedReceipt {
  merchant_name: string;
  transaction_date: string;
  total: number | null;
  card_last_4: string;
  cardholder_name: string;
  line_items: {
    description: string;
    quantity?: number | null;
    unit_price?: number | null;
    amount: number | null;
  }[];
  /** OCR-read printed sales tax total (the tax line); null when none. */
  sales_tax?: number | null;
}

export type ReceiptOcr = NormalizedReceipt & {
  match: MatchResult;
  confidence: MatchConfidence;
  resolved_cardholder_id?: string | null;
};

// ---------------------------------------------------------------------------
// Receipt Inbox / drop-receipts auto-match (Feature A) — redeclared locally
// from the frozen §3 contract (NOT imported from the worker, per the same
// no-cross-bundle convention as the rest of this file). The backend mirrors
// these shapes in worker/src/cc/ccTypes.ts.
// ---------------------------------------------------------------------------

export type InboxStatus = "PENDING_MATCH" | "MATCHED" | "RETURNED";

/** A candidate transaction the matcher proposes for a queued inbox item. */
export interface CandidateTx {
  id: string;
  vendor: string;
  amount: number;
  transaction_date: string; // YYYY-MM-DD
  receipt_status: ReceiptStatus;
}

/** A receipt dropped into the inbox (hydrated DTO from the worker). */
export interface InboxItem {
  id: string;
  uploaded_by: string;
  cardholder_id: string | null;
  cardholder_name?: string | null;
  source_guess?: CcSource | null;
  file_name: string;
  file_type?: string | null;
  file_size_bytes?: number | null;
  /**
   * Parsed OCR data the worker stamps on the inbox row. The worker DTO names this
   * field `ocr_extracted_data` (matching `cc_receipt_inbox.ocr_extracted_data`);
   * the renderer mirrors that exact name so the inbox/returned UI reads the real
   * payload. (Note: the bulk-drop `PerFileResult` uses `ocr`, not this field.)
   */
  ocr_extracted_data?: ReceiptOcr | null;
  status: InboxStatus;
  matched_transaction_id?: string | null;
  matched_receipt_id?: string | null;
  candidate_transaction_ids?: string[];
  candidates?: CandidateTx[];
  return_note?: string | null;
  created_at: string;
  updated_at?: string;
}

/** One per dropped file (bulk drop result). */
export interface PerFileResult {
  file_name: string;
  status: "MATCHED" | "PENDING_MATCH" | "ERROR";
  inbox_id: string;
  matched_transaction_id?: string;
  candidate_transaction_ids?: string[];
  ocr?: ReceiptOcr;
  error?: string;
}

export interface InboxListResponse {
  items: InboxItem[];
}

export interface DropReceiptsResponse {
  results: PerFileResult[];
}

export interface AssignInboxResponse {
  item: InboxItem;
  receipt: Receipt;
  transaction: CcTransaction;
}

export interface ReturnInboxResponse {
  item: InboxItem;
}

export interface InboxListQuery {
  status?: InboxStatus;
  cardholder_id?: string;
}

// ---------------------------------------------------------------------------
// Line-by-line receipt coding (§4) — redeclared locally from the frozen
// contract (NOT imported from the worker; same convention as the rest of this
// file). A line ("ITEM" or the single "TAX" line) fans out into N allocation
// slices, one per (location × GL category). gl_category is one of the three
// CC labels: "Service Costs" (Back bar) | "Retail / Product Costs" (Retail) |
// "Sales/Use Tax".
// ---------------------------------------------------------------------------

export type LineKind = "ITEM" | "TAX";

/** GL category labels used on the CC side (reused from lib/constants.ts). */
export const CC_GL_BACK_BAR = "Service Costs";
export const CC_GL_RETAIL = "Retail / Product Costs";
export const CC_GL_TAX = "Sales/Use Tax";

export interface LineAllocation {
  id?: string;
  entity_name: string; // one of CC_ENTITIES canonical names
  location: string; // a BUSINESS_CLASSES[entity] member, or the entity name
  gl_category: string; // CC_GL_BACK_BAR | CC_GL_RETAIL | CC_GL_TAX
  amount: number;
  is_tax?: boolean;
}

export interface ReceiptLine {
  id?: string;
  client_id?: string;
  receipt_id?: string | null;
  line_index?: number;
  kind: LineKind;
  description: string;
  quantity?: number | null;
  unit_price?: number | null;
  amount: number;
  is_coded?: boolean;
  allocations: LineAllocation[];
}

export interface LinesResponse {
  lines: ReceiptLine[];
  transaction_amount: number;
  allocated_total: number;
  remaining: number;
  reconciled: boolean;
}

// ---------------------------------------------------------------------------
// Normalized parsed rows (renderer-parsed; sent to /uploads/preview)
// ---------------------------------------------------------------------------

/** One normalized Capital One CSV row (renderer parse). */
export interface CapOneRow {
  transaction_date: string;
  posted_date?: string | null;
  card_last4?: string | null;
  vendor: string;
  category?: string | null;
  debit?: number | null;
  credit?: number | null;
  amount?: number | null;
}

/** One normalized Amex row (renderer parse — flat activity export OR per-cardholder workbook). */
export interface AmexRow {
  /** Per-cardholder workbook: the sheet title ("Lori 36158"). Flat export: "". */
  sheet_name: string;
  transaction_date: string;
  vendor: string;
  amount: number;
  exp_acct?: string | null;
  have_receipt?: boolean;
  in_qb?: boolean;
  /** Flat export "Card Member" name (e.g. "LORI B KOTRLY") — resolved by name server-side. */
  card_member?: string | null;
  /** Flat export "Account #" last-5 (digits only). */
  amex_last5?: string | null;
  /** Per-entity allocations keyed by CANONICAL entity name. */
  splits?: { entity_name: string; amount: number }[];
}

// ---------------------------------------------------------------------------
// Response envelopes
// ---------------------------------------------------------------------------

export interface CardholderBreakdownRow {
  cardholder_id: string | null;
  name: string;
  count: number;
}

export interface UploadPreview {
  row_count: number;
  new_count: number;
  duplicate_count: number;
  skipped_count: number;
  period_start: string | null;
  period_end: string | null;
  unmatched_cards: string[];
  cardholder_breakdown: CardholderBreakdownRow[];
}

export interface PreviewResponse {
  batch_id: string;
  source?: CcSource;
  status: "PREVIEW" | "BLANK_TEMPLATE";
  message?: string;
  preview?: UploadPreview;
}

export interface ConfirmResponse {
  status: "COMPLETE";
  transaction_count: number;
  duplicate_count: number;
  skipped_count: number;
}

export interface TransactionsListResponse {
  transactions: CcTransaction[];
  total: number;
  page: number;
  per_page: number;
}

export interface TransactionDetailResponse {
  transaction: CcTransaction;
  splits: EntitySplit[];
  receipts: Receipt[];
}

export interface ReceiptUploadResponse {
  receipt: Receipt;
  ocr: ReceiptOcr;
  transaction: CcTransaction;
}

export interface SendNotificationsResponse {
  sent_count: number;
  not_configured_count: number;
  failed_count: number;
  notifications: Notification[];
}

export interface DashboardCardholderRow {
  cardholder_id: string;
  name: string;
  card: string;
  open: number;
  received: number;
  pct_complete: number;
  last_notified_at: string | null;
}

export interface DashboardActivityRow {
  type: string;
  text: string;
  at: string;
}

export interface DashboardSummary {
  total_transactions: number;
  receipts_received: number;
  receipts_pending: number;
  total_spend: number;
  cardholder_breakdown: DashboardCardholderRow[];
  recent_activity: DashboardActivityRow[];
}

// ----- Dashboard analytics (GET /api/cc/dashboard/analytics) ------------
// Cycle-scoped KPIs + entity/category donuts, plus a trailing-N-months combo
// series. Universe mirrors /summary (in-cycle, is_payment = 0) so headline
// numbers reconcile with `dashboardSummary`. See the frozen data contract.

/** KPI counters (cycle-scoped, non-payment). */
export interface CcAnalyticsKpis {
  total_transactions: number;
  in_qb_count: number;
  not_in_qb_count: number;
  unmatched_count: number;
}

/** One trailing-month point: spend bar + receipt-completion% line. */
export interface CcMonthlyPoint {
  month: string; // "YYYY-MM"
  spend: number;
  tx_count: number;
  receipts_received: number;
  receipts_total: number; // == tx_count (every non-payment tx needs a receipt)
  completion_pct: number; // receipts_received / tx_count * 100 (0 when no tx)
}

/** Spend-by-entity slice (from cc_entity_splits, cycle-scoped). */
export interface CcEntitySpend {
  entity_name: string; // canonical (CC_ENTITIES.canonical)
  label: string; // CC display label (ccEntityLabel)
  spend: number;
}

/** Spend-by-category slice (from cc_transactions.category, cycle-scoped). */
export interface CcCategorySpend {
  category: string; // "Uncategorized" when the tx category is null/blank
  spend: number;
}

export interface CcDashboardAnalytics {
  /** The resolved cycle window the KPIs / donuts are scoped to. */
  cycle_start: string;
  cycle_end: string;
  /** The trailing-month count the `monthly` series spans (default 12). */
  months: number;
  kpis: CcAnalyticsKpis;
  /** Exactly `months` points, oldest→newest, gaps zero-filled. */
  monthly: CcMonthlyPoint[];
  by_entity: CcEntitySpend[];
  by_category: CcCategorySpend[];
}

export interface CcDashboardAnalyticsQuery {
  cycle_start?: string;
  cycle_end?: string;
  /** Trailing-month window for the combo chart (1–24; default 12). */
  months?: number;
}

// ---------------------------------------------------------------------------
// Query param helpers
// ---------------------------------------------------------------------------

export interface TransactionsQuery {
  cardholder_id?: string;
  source?: CcSource;
  receipt_status?: ReceiptStatus;
  date_from?: string;
  date_to?: string;
  category?: string;
  q?: string;
  page?: number;
  per_page?: number;
  /** Truthy (1) includes archived rows; omit to hide them (server default). */
  includeArchived?: number;
}

export interface NotificationsQuery {
  cardholder_id?: string;
  date_from?: string;
  date_to?: string;
}

export interface DashboardQuery {
  cycle_start?: string;
  cycle_end?: string;
}

function qs(
  params: Record<string, string | number | undefined | null> | object,
): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Entity-split contract (§4) — 7 entities in Amex template column order.
// Renderer-local mirror of worker/src/cc/ccConstants.ts (no cross-bundle
// import). `canonical` is the DB `entity_name` value; `label` is the CC display
// label (Amex template wording, differs from invoice/QBO labels).
// ---------------------------------------------------------------------------

export interface CcEntityDef {
  canonical: string;
  label: string;
}

/** Display order = Amex template columns G–M. */
export const CC_ENTITIES: CcEntityDef[] = [
  { canonical: "Nala", label: "Nala Beauty Brands" },
  { canonical: "UrbanAyurveda", label: "Urban Ayurveda" },
  { canonical: "SKNBar", label: "Skn Bar Rx" },
  { canonical: "Admin", label: "Admin" },
  { canonical: "IBW", label: "Institute" },
  { canonical: "Chicago", label: "Institute Chicago" },
  { canonical: "Neroli", label: "Neroli" },
];

export const CC_ENTITY_LABEL: Record<string, string> = Object.fromEntries(
  CC_ENTITIES.map((e) => [e.canonical, e.label]),
);

/** Resolve a stored canonical entity_name to its CC display label. */
export function ccEntityLabel(canonical: string): string {
  return CC_ENTITY_LABEL[canonical] ?? canonical;
}

/** Round to cents, matching the server's `roundCents` (exact-to-cent compare). */
export function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Normalize a notification's `transaction_ids` to a string array. The server
 * returns an already-parsed array (the contract shape), but this stays tolerant
 * of a JSON-string form so the UI never breaks if a row arrives stringified.
 */
export function notificationTxIds(n: Pick<Notification, "transaction_ids">): string[] {
  const v = n.transaction_ids as unknown;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed)
        ? parsed.filter((x): x is string => typeof x === "string")
        : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// API surface (method list per §5 crib)
// ---------------------------------------------------------------------------

export const ccApi = {
  // ---- Uploads -----------------------------------------------------------
  uploadsPreview: (form: FormData) =>
    api.postForm<PreviewResponse>("/api/cc/uploads/preview", form),
  uploadsConfirm: (batchId: string, body: { force_overwrite?: boolean }) =>
    api.post<ConfirmResponse>(
      `/api/cc/uploads/${batchId}/confirm`,
      body,
    ),
  listUploads: () => api.get<{ batches: UploadBatch[] }>("/api/cc/uploads"),
  /**
   * Manager: delete an upload batch and its transactions. `force` overrides the
   * server's safety block (409) when some transactions already have
   * receipts/coding.
   */
  deleteUpload: (id: string, force = false) =>
    api.del<{ ok: boolean; deleted: { transactions: number; receipts: number } }>(
      `/api/cc/uploads/${id}${force ? "?force=1" : ""}`,
    ),

  // ---- Transactions ------------------------------------------------------
  listTransactions: (query: TransactionsQuery = {}) =>
    api.get<TransactionsListResponse>(`/api/cc/transactions${qs(query)}`),
  getTransaction: (id: string) =>
    api.get<TransactionDetailResponse>(`/api/cc/transactions/${id}`),
  patchTransaction: (
    id: string,
    body: Partial<{
      receipt_status: ReceiptStatus;
      in_qb: boolean;
      exp_acct: string;
      notes: string;
      cardholder_id: string | null;
      // Manager-only mis-parse corrections (all optional; non-empty vendor,
      // finite amount, 'YYYY-MM-DD' date, nullable category).
      vendor: string;
      amount: number;
      transaction_date: string;
      category: string | null;
    }>,
  ) => api.patch<{ transaction: CcTransaction }>(`/api/cc/transactions/${id}`, body),
  bulkPatchTransactions: (body: {
    transaction_ids: string[];
    updates: Partial<{
      receipt_status: ReceiptStatus;
      in_qb: boolean;
      cardholder_id: string | null;
    }>;
  }) => api.patch<{ updated_count: number }>("/api/cc/transactions/bulk", body),
  /** Manager: archive (hide) a set of transactions. */
  archiveTransactions: (ids: string[]) =>
    api.post<{ ok: boolean; archived: number }>(
      "/api/cc/transactions/archive",
      { ids },
    ),
  /** Manager: archive a single transaction. */
  archiveTransaction: (id: string) =>
    api.post<{ ok: boolean; archived_at: string }>(
      `/api/cc/transactions/${id}/archive`,
      {},
    ),
  /** Manager: restore an archived transaction. */
  unarchiveTransaction: (id: string) =>
    api.post<{ ok: boolean }>(`/api/cc/transactions/${id}/unarchive`, {}),

  // ---- Splits ------------------------------------------------------------
  getSplits: (id: string) =>
    api.get<{ splits: EntitySplit[] }>(`/api/cc/transactions/${id}/splits`),
  putSplits: (id: string, splits: { entity_name: string; amount: number }[]) =>
    putJson<{ splits: EntitySplit[] }>(`/api/cc/transactions/${id}/splits`, {
      splits,
    }),

  // ---- Line coding (§4) --------------------------------------------------
  getLines: (id: string) =>
    api.get<LinesResponse>(`/api/cc/transactions/${id}/lines`),
  putLines: (id: string, lines: ReceiptLine[]) =>
    putJson<LinesResponse>(`/api/cc/transactions/${id}/lines`, { lines }),

  // ---- Receipts ----------------------------------------------------------
  uploadReceipt: (txId: string, form: FormData) =>
    api.postForm<ReceiptUploadResponse>(
      `/api/cc/transactions/${txId}/receipts`,
      form,
    ),
  listReceipts: (txId: string) =>
    api.get<{ receipts: Receipt[] }>(`/api/cc/transactions/${txId}/receipts`),
  /** Path for streaming receipt bytes (fetch via api.getBlob). */
  receiptFileUrl: (id: string) => `/api/cc/receipts/${id}/file`,
  getReceiptBlob: (id: string) => api.getBlob(`/api/cc/receipts/${id}/file`),
  deleteReceipt: (id: string) => api.del<void>(`/api/cc/receipts/${id}`),

  // ---- Receipt Inbox / drop-receipts auto-match (Feature A) --------------
  /** Cardholder OR manager: bulk multi-file drop. `form` carries N `file` parts. */
  dropReceipts: (form: FormData) =>
    api.postForm<DropReceiptsResponse>("/api/cc/receipts/inbox", form),
  /** Manager: the unmatched queue (defaults to PENDING_MATCH on the server). */
  listInbox: (query: InboxListQuery = {}) =>
    api.get<InboxListResponse>(`/api/cc/receipts/inbox${qs(query)}`),
  /** Cardholder (or manager): the caller's own dropped receipts. */
  myInbox: (query: { status?: InboxStatus } = {}) =>
    api.get<InboxListResponse>(`/api/cc/receipts/inbox/mine${qs(query)}`),
  /** Manager: assign a queued item to a transaction (creates the cc_receipts row). */
  assignInbox: (id: string, body: { transaction_id: string }) =>
    api.post<AssignInboxResponse>(`/api/cc/receipts/inbox/${id}/assign`, body),
  /** Manager: send an item back to the cardholder with an optional note. */
  returnInbox: (id: string, body: { note?: string } = {}) =>
    api.post<ReturnInboxResponse>(`/api/cc/receipts/inbox/${id}/return`, body),
  /** Path for streaming inbox file bytes (fetch via api.getBlob / getInboxBlob). */
  inboxFileUrl: (id: string) => `/api/cc/receipts/inbox/${id}/file`,
  getInboxBlob: (id: string) =>
    api.getBlob(`/api/cc/receipts/inbox/${id}/file`),
  deleteInbox: (id: string) => api.del<void>(`/api/cc/receipts/inbox/${id}`),

  // ---- Notifications -----------------------------------------------------
  sendNotifications: (body: {
    cardholder_ids: string[] | "ALL_PENDING";
    transaction_ids?: string[];
  }) => api.post<SendNotificationsResponse>("/api/cc/notifications/send", body),
  listNotifications: (query: NotificationsQuery = {}) =>
    api.get<{ notifications: Notification[] }>(
      `/api/cc/notifications${qs(query)}`,
    ),
  getNotification: (id: string) =>
    api.get<{ notification: Notification }>(`/api/cc/notifications/${id}`),

  // ---- Cardholders -------------------------------------------------------
  listCardholders: () =>
    api.get<{ cardholders: Cardholder[] }>("/api/cc/cardholders"),
  createCardholder: (body: {
    first_name: string;
    last_name?: string;
    email?: string;
    card_source: "CAPITAL_ONE" | "AMEX" | "BOTH";
    cap_one_last4?: string;
    amex_last5?: string;
    amex_sheet_name?: string;
  }) => api.post<{ cardholder: Cardholder }>("/api/cc/cardholders", body),
  patchCardholder: (
    id: string,
    body: Partial<{
      first_name: string;
      last_name: string;
      email: string;
      card_source: "CAPITAL_ONE" | "AMEX" | "BOTH";
      cap_one_last4: string;
      amex_last5: string;
      amex_sheet_name: string;
      is_active: boolean;
      user_id: string | null;
    }>,
  ) => api.patch<{ cardholder: Cardholder }>(`/api/cc/cardholders/${id}`, body),
  deleteCardholder: (id: string) => api.del<void>(`/api/cc/cardholders/${id}`),

  // ---- Dashboard ---------------------------------------------------------
  dashboardSummary: (query: DashboardQuery = {}) =>
    api.get<DashboardSummary>(`/api/cc/dashboard/summary${qs(query)}`),
  dashboardAnalytics: (query: CcDashboardAnalyticsQuery = {}) =>
    api.get<CcDashboardAnalytics>(`/api/cc/dashboard/analytics${qs(query)}`),
};

// ---------------------------------------------------------------------------
// Notification send + mailto fallback (§7.3)
// ---------------------------------------------------------------------------

/**
 * Build a prefilled `mailto:` from the notifications the server logged as
 * NOT_CONFIGURED (Resend not set up). Mirrors RemindApproversModal: BCC the
 * recipients (privacy + shorter URL), percent-encode subject/body only. Uses
 * the first notification's subject; the body lists each recipient + tx count so
 * the manager can still nudge from their own mailbox.
 */
export function buildCcReminderMailto(notifications: Notification[]): string {
  const recipients = Array.from(
    new Set(notifications.map((n) => n.email_to).filter(Boolean)),
  );
  const subject =
    notifications[0]?.subject ?? "Receipt Submission Needed";
  const lines = [
    "Hi,",
    "",
    "We need receipts for your recent credit-card transactions. Please submit them to keep our billing cycle on track.",
    "",
    "Open InvoiceIQ → Credit Cards → My Receipts to upload, or use the Capital One app for Cap One charges.",
    "",
    "Thank you, Finance Team.",
  ];
  const bcc = recipients.join(",");
  return (
    `mailto:?bcc=${bcc}` +
    `&subject=${encodeURIComponent(subject)}` +
    `&body=${encodeURIComponent(lines.join("\n"))}`
  );
}

export interface SendRemindersOutcome {
  result: SendNotificationsResponse;
  /** True when the mailto draft was opened (some recipients NOT_CONFIGURED). */
  openedMailto: boolean;
}

/**
 * Send reminders and, when the server reports any NOT_CONFIGURED delivery (or a
 * delivery of NOT_CONFIGURED/FAILED on a logged row), fall back to opening a
 * prefilled mailto draft in the user's mail client. The server has already
 * logged one row per attempt, so we do NOT create a second log here.
 */
export async function sendCcReminders(
  body: { cardholder_ids: string[] | "ALL_PENDING"; transaction_ids?: string[] },
  openExternal?: (url: string) => Promise<boolean>,
): Promise<SendRemindersOutcome> {
  const result = await ccApi.sendNotifications(body);
  const needsMailto =
    (result.not_configured_count ?? 0) > 0 ||
    (result.notifications ?? []).some(
      (n) => n.delivery === "NOT_CONFIGURED",
    );
  let openedMailto = false;
  if (needsMailto && openExternal) {
    const unconfigured = (result.notifications ?? []).filter(
      (n) => n.delivery === "NOT_CONFIGURED" && n.email_to,
    );
    const target = unconfigured.length ? unconfigured : result.notifications;
    if (target.length) {
      try {
        await openExternal(buildCcReminderMailto(target));
        openedMailto = true;
      } catch {
        openedMailto = false;
      }
    }
  }
  return { result, openedMailto };
}
