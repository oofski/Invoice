/**
 * Same-origin REST client for the InvoiceIQ Cloudflare Worker.
 *
 * The mobile SPA is served BY the worker (Cloudflare Static Assets) at the same
 * origin as the API, so the API base is empty/relative — calls hit `/api/...`
 * on the current origin (zero CORS). Simplified vs. the desktop client: no
 * on-screen "Server URL" field, no `iq_api_base`.
 *
 * Auth: bearer token in `localStorage.iq_token`, attached to every request as
 * `Authorization: Bearer <token>`. On 401 the token is cleared and an
 * `iq:unauthorized` window event is dispatched (the router redirects to
 * /login). `FormData` bodies omit `Content-Type` so the browser sets the
 * multipart boundary.
 */

import type { EntitySplitInput } from "./cc";

const TOKEN_KEY = "iq_token";

export class ApiError extends Error {
  status: number;
  body: unknown;
  /** True when the request never reached the server (offline / network fail). */
  offline: boolean;
  constructor(message: string, status: number, body: unknown, offline = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.offline = offline;
  }
}

// ------------------------------------------------------------------ token
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — ignore */
  }
}

export function clearToken(): void {
  setToken(null);
}

function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  const headers = authHeaders(options.headers);
  if (options.body && !isForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Early offline signal so callers can surface "reconnect to submit".
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError("You're offline — reconnect and try again.", 0, null, true);
  }

  let res: Response;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (err) {
    throw new ApiError(
      err instanceof Error ? `Network error: ${err.message}` : "Network error",
      0,
      null,
      true,
    );
  }

  const body = await parseBody(res);

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("iq:unauthorized"));
    }
  }

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return body as T;
}

// --------------------------------------------------------------- contracts
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  must_change_password?: boolean;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface CcTransaction {
  id: string;
  cardholder_name: string;
  transaction_date: string;
  vendor: string;
  amount: number;
  receipt_status: string;
}

/** A single normalized receipt line item from OCR. */
export interface OcrLine {
  description: string;
  quantity: number | null;
  unit_price: number | null;
  amount: number | null;
}

/** `PerFileResult.ocr` — the normalized receipt fields + match band. */
export interface ReceiptOcr {
  merchant_name: string;
  transaction_date: string;
  total: number | null;
  card_last_4?: string;
  cardholder_name?: string;
  line_items: OcrLine[];
  sales_tax?: number | null;
  match?: string;
  confidence?: string;
}

/** One entry of the drop endpoint's `results[]`. */
export interface PerFileResult {
  file_name: string;
  status: "MATCHED" | "PENDING_MATCH" | "ERROR";
  inbox_id: string;
  matched_transaction_id?: string;
  candidate_transaction_ids?: string[];
  ocr?: ReceiptOcr;
  /** NEW (§C.6): true when the server applied pending_splits at drop time. */
  split_applied?: boolean;
  error?: string;
}

export interface DropResponse {
  results: PerFileResult[];
}

// ----------------------------------------------------------------- methods
export const api = {
  // -- auth ---------------------------------------------------------------
  /** POST /api/auth/login → { token, user }. Store token as iq_token. */
  login: (email: string, password: string) =>
    request<LoginResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  /** GET /api/auth/me → { user }. Silent token validation on app open. */
  me: () => request<{ user: AuthUser }>("/api/auth/me"),

  /** POST /api/auth/logout — best-effort server session teardown. */
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  /** POST /api/auth/change-password (optional must_change_password flow). */
  changePassword: (newPassword: string) =>
    request<{ ok: true }>("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  // -- CC transactions (optional Home list) -------------------------------
  /**
   * GET /api/cc/transactions?receipt_status=PENDING — the caller's own open
   * charges (auto-scoped to their cardholder by the worker's ccScopeClause).
   */
  pendingTransactions: () =>
    request<{ transactions: CcTransaction[] }>(
      "/api/cc/transactions?receipt_status=PENDING",
    ),

  // -- receipt drop + splits ----------------------------------------------
  /**
   * POST /api/cc/receipts/inbox (multipart) — drop + OCR + auto-match.
   * Always pins `upload_method=INVOICE_IQ_APP`. When `pendingSplits` is
   * provided it is sent as the `pending_splits` JSON field (§C.4/§C.6): the
   * server applies it now if the receipt matched, else stashes it to apply
   * automatically on a later match.
   */
  dropReceipt: (file: File, pendingSplits?: EntitySplitInput[]) => {
    const form = new FormData();
    form.append("file", file, file.name || "receipt.jpg");
    form.append("upload_method", "INVOICE_IQ_APP");
    if (pendingSplits && pendingSplits.length > 0) {
      form.append("pending_splits", JSON.stringify(pendingSplits));
    }
    return request<DropResponse>("/api/cc/receipts/inbox", {
      method: "POST",
      body: form,
    });
  },

  /**
   * PUT /api/cc/transactions/:id/splits — persist (replace-all) the split on a
   * MATCHED transaction. Server re-validates exact-to-cent. Safe to retry.
   */
  putSplits: (transactionId: string, splits: EntitySplitInput[]) =>
    request<{ splits: EntitySplitInput[] }>(
      `/api/cc/transactions/${encodeURIComponent(transactionId)}/splits`,
      { method: "PUT", body: JSON.stringify({ splits }) },
    ),

  /**
   * PATCH /api/cc/receipts/inbox/:id/pending_splits — attach the exec's entity
   * split to the EXISTING preview-drop row (the row created at /review). Used for
   * the PENDING_MATCH submit so we don't re-drop the photo (which would create a
   * duplicate inbox row). Server stashes the split to apply automatically on a
   * later match, or applies it now if the row has since matched (`applied:true`).
   */
  attachPendingSplits: (inboxId: string, splits: EntitySplitInput[]) =>
    request<{ applied: boolean; pending: boolean }>(
      `/api/cc/receipts/inbox/${encodeURIComponent(inboxId)}/pending_splits`,
      { method: "PATCH", body: JSON.stringify({ splits }) },
    ),
};
