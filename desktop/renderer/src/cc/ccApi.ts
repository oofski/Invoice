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
  line_items: { description: string; amount: number | null }[];
}

export type ReceiptOcr = NormalizedReceipt & {
  match: MatchResult;
  confidence: MatchConfidence;
  resolved_cardholder_id?: string | null;
};

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
    }>,
  ) => api.patch<{ transaction: CcTransaction }>(`/api/cc/transactions/${id}`, body),
  bulkPatchTransactions: (body: {
    transaction_ids: string[];
    updates: Partial<{ receipt_status: ReceiptStatus; in_qb: boolean }>;
  }) => api.patch<{ updated_count: number }>("/api/cc/transactions/bulk", body),

  // ---- Splits ------------------------------------------------------------
  getSplits: (id: string) =>
    api.get<{ splits: EntitySplit[] }>(`/api/cc/transactions/${id}/splits`),
  putSplits: (id: string, splits: { entity_name: string; amount: number }[]) =>
    putJson<{ splits: EntitySplit[] }>(`/api/cc/transactions/${id}/splits`, {
      splits,
    }),

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
