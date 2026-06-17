/**
 * Thin client-side fetch wrapper. Throws ApiClientError on non-2xx with the
 * server's error message and parsed body (so callers can read `duplicate`,
 * `blocking`, etc.).
 */
export class ApiClientError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      (body as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new ApiClientError(message, res.status, body);
  }
  return body as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, data?: unknown) =>
    request<T>(url, {
      method: "POST",
      body: data instanceof FormData ? data : data ? JSON.stringify(data) : undefined,
    }),
  patch: <T>(url: string, data?: unknown) =>
    request<T>(url, {
      method: "PATCH",
      body: data ? JSON.stringify(data) : undefined,
    }),
};
