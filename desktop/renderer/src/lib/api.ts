/**
 * REST client for the InvoiceIQ Cloudflare Worker.
 *
 * - Base URL: localStorage "iq_api_base" overrides the build-time
 *   `VITE_API_BASE_URL`. This lets the installed desktop app be pointed at any
 *   Worker URL from the login screen WITHOUT a rebuild.
 * - Bearer token: stored in localStorage "iq_token" and attached to every
 *   request as `Authorization: Bearer <token>`.
 * - On 401 the token is cleared and the app is redirected to #/login.
 * - Non-2xx responses throw an ApiError carrying { status, body, message }.
 */

import type { VendorAlias, VendorSuggestion } from "./types";
import { emitInvoiceRefresh } from "./invoiceRefresh";

const API_BASE_KEY = "iq_api_base";
const TOKEN_KEY = "iq_token";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// --------------------------------------------------------------- base URL
export function getApiBase(): string {
  if (typeof localStorage !== "undefined") {
    const stored = localStorage.getItem(API_BASE_KEY);
    if (stored) return stored.replace(/\/$/, "");
  }
  const fromEnv = import.meta.env.VITE_API_BASE_URL;
  return (fromEnv ?? "").replace(/\/$/, "");
}

export function setApiBase(base: string): void {
  const cleaned = base.trim().replace(/\/$/, "");
  if (cleaned) localStorage.setItem(API_BASE_KEY, cleaned);
  else localStorage.removeItem(API_BASE_KEY);
}

// ------------------------------------------------------------------ token
export function getToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

function redirectToLogin() {
  // HashRouter: routes live after the # so a hard hash change navigates.
  if (typeof window !== "undefined" && !window.location.hash.startsWith("#/login")) {
    window.location.hash = "#/login";
  }
}

// ------------------------------------------------------------- core fetch
function buildUrl(path: string): string {
  const base = getApiBase();
  if (/^https?:\/\//.test(path)) return path;
  if (!base) return path; // relative (lets a clear error surface)
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
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

  let res: Response;
  try {
    // `cache: "no-store"` — Electron's Chromium can heuristically cache API GETs
    // that carry no Cache-Control, which made a remounted Dashboard/list serve
    // stale data after a change made elsewhere. Always hit the network so every
    // view reflects the current state (v1.9.6).
    res = await fetch(buildUrl(path), { ...options, headers, cache: "no-store" });
  } catch (err) {
    throw new ApiError(
      err instanceof Error
        ? `Network error: ${err.message}`
        : "Network error — is the server URL correct?",
      0,
      null,
    );
  }

  const body = await parseBody(res);

  if (res.status === 401) {
    clearToken();
    redirectToLogin();
  }

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ??
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  // Cross-view live sync (v1.9.6): after a successful invoice-side mutation,
  // announce it so any mounted Dashboard / Invoices / Approvals view refetches.
  signalInvoiceMutation(path, options.method);
  return body as T;
}

/**
 * Fire the invoice-refresh bus when a mutating request to an invoice-domain
 * endpoint succeeds. Reads (GET/HEAD) never signal. Covers /api/invoices,
 * /api/line-items and /api/export — so every AP mutation (delete, approve,
 * route, split, line edits, accept-review, export, bulk-delete, …) keeps the
 * other views in sync without each call site having to remember to emit.
 */
function signalInvoiceMutation(path: string, method?: string): void {
  const m = (method ?? "GET").toUpperCase();
  if (m === "GET" || m === "HEAD") return;
  if (/^\/api\/(invoices|line-items|export)(\/|\?|$)/.test(path)) {
    emitInvoiceRefresh();
  }
}

// --------------------------------------------------- dashboard analytics
// Server-side aggregation contract for GET /api/dashboard/analytics. Declared
// here (not in lib/types.ts, owned by the dashboard page) so the client method
// and its response type ship together. Numbers are exact SQL GROUP BY rollups;
// the entity-donut / status counters that this endpoint does NOT return stay on
// GET /api/dashboard/stats (DashboardStats.byEntity / byStatus). See the frozen
// data contract.

export interface DashboardAnalyticsTotals {
  total_spend: number;
  invoice_count: number;
  avg_amount: number; // total_spend / invoice_count (0 when no invoices)
}

/** One trailing-month AP point (bars = spend, optional line = invoice_count). */
export interface DashboardMonthlyPoint {
  month: string; // "YYYY-MM"
  spend: number;
  invoice_count: number;
}

/** Spend-by-entity slice (business; "Unassigned" when null/blank). */
export interface DashboardEntitySpend {
  entity: string;
  spend: number;
  count: number;
}

/** Top-vendor bar (ordered by spend desc, capped at vendorLimit). */
export interface DashboardVendorSpend {
  vendor: string;
  spend: number;
  count: number;
}

/** Spend-by-GL-category slice (line_items.gl_category; "Uncategorized" fallback). */
export interface DashboardGlCategorySpend {
  category: string;
  spend: number;
}

export interface DashboardAnalytics {
  /** Echoes the requested period (null = unbounded on that side). */
  from: string | null;
  to: string | null;
  /** The trailing-month count the `monthly` series spans (default 12). */
  months: number;
  totals: DashboardAnalyticsTotals; // scoped to from/to + archived exclusion
  monthly: DashboardMonthlyPoint[]; // trailing `months`, oldest→newest, zero-filled
  by_entity: DashboardEntitySpend[]; // scoped to from/to
  top_vendors: DashboardVendorSpend[]; // scoped to from/to
  by_gl_category: DashboardGlCategorySpend[]; // scoped to from/to
}

export interface DashboardAnalyticsQuery {
  /** Inclusive period bounds as "YYYY-MM-DD" (compared on date(created_at)). */
  from?: string;
  to?: string;
  /** Trailing-month window for the AP trend (1–24; default 12). */
  months?: number;
  /** Top-vendor cap (1–50; default 8). */
  vendorLimit?: number;
}

/** Serialize a flat query object → "?a=1&b=2" (drops empty/undefined/null). */
function toQueryString(
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

// --------------------------------------------------------------- helpers
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
  patch: <T>(path: string, data?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: data === undefined ? undefined : JSON.stringify(data),
    }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /** Multipart upload (FormData) — used by /api/invoices/upload. */
  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, { method: "POST", body: form }),
  /** Authenticated binary fetch — PDF bytes and CSV re-downloads. */
  getBlob: async (path: string): Promise<Blob> => {
    let res: Response;
    try {
      res = await fetch(buildUrl(path), { headers: authHeaders() });
    } catch (err) {
      throw new ApiError(
        err instanceof Error ? `Network error: ${err.message}` : "Network error",
        0,
        null,
      );
    }
    if (res.status === 401) {
      clearToken();
      redirectToLogin();
    }
    if (!res.ok) {
      const body = await parseBody(res);
      const message =
        (body as { error?: string } | null)?.error ??
        `Request failed (${res.status})`;
      throw new ApiError(message, res.status, body);
    }
    return res.blob();
  },

  // ----------------------------------------------------- vendor aliases
  /** List all vendor aliases joined to their canonical vendor name. */
  listVendorAliases: () =>
    api.get<{ aliases: VendorAlias[] }>(`/api/vendors/aliases`),
  /**
   * Create an alias mapping `alias_text` → the given canonical vendor. Throws
   * an ApiError with status 409 if the normalized alias already exists.
   */
  createVendorAlias: (alias_text: string, canonical_id: string) =>
    api.post<{ alias: VendorAlias }>(`/api/vendors/aliases`, {
      alias_text,
      canonical_id,
    }),
  /** Delete an alias by id — reverts the variant to default coding. */
  deleteVendorAlias: (id: string) =>
    api.del<void>(`/api/vendors/aliases/${id}`),
  /** Advisory fuzzy suggestion for an unmatched vendor name (non-binding). */
  suggestVendor: (vendor: string) =>
    api.get<{ suggestions: VendorSuggestion[] }>(
      `/api/vendors/suggest?vendor=${encodeURIComponent(vendor)}`,
    ),

  // ------------------------------------------------------ dashboard analytics
  /**
   * Server-side aggregation rollups for the dashboard charts (period totals,
   * monthly AP trend, entity / top-vendor / GL-category breakdowns). Pair with
   * `GET /api/dashboard/stats` for the entity-donut / status counters this
   * endpoint intentionally omits.
   */
  dashboardAnalytics: (query: DashboardAnalyticsQuery = {}) =>
    api.get<DashboardAnalytics>(`/api/dashboard/analytics${toQueryString(query)}`),

  // ------------------------------------------------ archive / audit clear
  /** Archive a single invoice (ADMIN only) — sets `archived_at`. */
  archiveInvoice: (id: string) =>
    api.post<{ ok: true; archived_at: string }>(`/api/invoices/${id}/archive`),
  /** Unarchive a single invoice (ADMIN only) — clears `archived_at`. */
  unarchiveInvoice: (id: string) =>
    api.post<{ ok: true }>(`/api/invoices/${id}/unarchive`),
  /** Batch-archive the given invoice ids (ADMIN only). */
  archiveInvoices: (invoiceIds: string[]) =>
    api.post<{ ok: true; archived: number }>(`/api/invoices/archive`, {
      invoiceIds,
    }),
  /** Set this admin's audit-view cutoff (ADMIN only) — hides, never deletes. */
  clearAudit: () =>
    api.post<{ ok: true; cutoff_at: string }>(`/api/audit/clear`),

  // ------------------------------------------- duplicate review scan (v1.9.6)
  /**
   * Admin/accountant "Review scan": groups of likely-duplicate active invoices
   * (same vendor+invoice#, or same vendor+amount when un-numbered). Read-only.
   */
  scanDuplicates: () =>
    api.get<{ groups: DuplicateGroup[]; scanned: number; capped: boolean }>(
      `/api/invoices/scan-duplicates`,
    ),
  /** Hard-delete the given invoice ids (admin/accountant) — used by the scan. */
  bulkDeleteInvoices: (invoiceIds: string[]) =>
    api.post<{ ok: true; deleted: number; skipped: number; capped: boolean }>(
      `/api/invoices/bulk-delete`,
      { invoiceIds },
    ),
};

/** One invoice row inside a duplicate group (subset of the invoice columns). */
export interface DuplicateInvoice {
  id: string;
  vendor: string;
  invoice_number: string;
  total_amount: number;
  inv_date: string | null;
  business: string | null;
  class: string | null;
  status: string;
  has_pdf: number;
  exported_at: string | null;
  created_at: string;
}

/** A cluster of likely-duplicate invoices returned by the review scan. */
export interface DuplicateGroup {
  id: string;
  /** "number" = same vendor + invoice#; "amount" = same vendor + total. */
  reason: "number" | "amount";
  vendor: string;
  invoice_number: string | null;
  total_amount: number | null;
  count: number;
  invoices: DuplicateInvoice[];
}
