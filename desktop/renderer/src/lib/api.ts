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
    res = await fetch(buildUrl(path), { ...options, headers });
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
  return body as T;
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
};
