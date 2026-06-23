import { NextResponse } from "next/server";
import { AuthError } from "@/lib/auth";

/** Standard JSON success response. */
export function ok<T>(data: T, status = 200) {
  return NextResponse.json(data, { status });
}

/** Standard JSON error response. */
export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ error: message, details }, { status });
}

/**
 * Wraps a route handler so thrown AuthErrors become 401/403 JSON responses and
 * any other error becomes a 500 — keeping handlers free of boilerplate.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>,
) {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      if (err instanceof AuthError) {
        return fail(err.message, err.status);
      }
      console.error("[API error]", err);
      const message =
        err instanceof Error ? err.message : "Internal server error";
      return fail(message, 500);
    }
  };
}
