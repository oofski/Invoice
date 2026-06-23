import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import type { Env } from "../lib/types";
import { ingestInvoicePdf } from "../lib/process";
import { bearer } from "../lib/auth";

/**
 * Unattended ingestion endpoint for external automations — primarily a
 * SharePoint document library wired up with a Power Automate flow ("when a file
 * is created" -> POST the file here). It runs the exact same pipeline as the
 * interactive accountant upload (Reducto -> 3 Claude prompts -> approval routing)
 * but authenticates with a shared `INGEST_TOKEN` secret instead of a user
 * session, so no human has to be logged in.
 *
 * Mounted OUTSIDE the `/api/*` session-auth gate (see index.ts).
 *
 * Accepts either:
 *   - a raw PDF body (Content-Type: application/pdf or application/octet-stream),
 *     with the filename in `?filename=` or the `X-File-Name` header  ← Power Automate
 *   - a multipart/form-data body with a `file` field
 */
export const ingest = new Hono<AppEnv>();

/** Constant-time string comparison to avoid leaking the token via timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The user to attribute ingested invoices to: the first active admin, or null. */
async function systemSubmitter(env: Env): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY created_at ASC LIMIT 1",
  ).first<{ id: string }>();
  return row?.id ?? null;
}

ingest.post("/upload", async (c) => {
  const expected = c.env.INGEST_TOKEN;
  if (!expected)
    return c.json({ error: "Ingestion is not configured (set INGEST_TOKEN)" }, 503);

  // Accept the token from `Authorization: Bearer <token>` or `X-Ingest-Token`.
  const provided = bearer(c.req.header("authorization")) ?? c.req.header("x-ingest-token") ?? "";
  if (!provided || !safeEqual(provided, expected))
    return c.json({ error: "Unauthorized" }, 401);

  const url = new URL(c.req.url);
  const override = url.searchParams.get("override") === "true";
  let fileName =
    url.searchParams.get("filename") || c.req.header("x-file-name") || "invoice.pdf";

  let buf: ArrayBuffer;
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file") as unknown as
      | { arrayBuffer(): Promise<ArrayBuffer>; name?: string }
      | string
      | null;
    if (!file || typeof file === "string")
      return c.json({ error: "No file provided" }, 400);
    buf = await file.arrayBuffer();
    fileName = file.name ?? fileName;
  } else {
    // Raw binary body (the simplest shape for Power Automate's HTTP action).
    buf = await c.req.arrayBuffer();
  }
  if (!buf || buf.byteLength === 0)
    return c.json({ error: "Empty request body" }, 400);

  const submittedBy = await systemSubmitter(c.env);
  const result = await ingestInvoicePdf(c.env, {
    buf,
    fileName,
    submittedBy,
    submissionType: "ACCOUNTANT",
    override,
    source: "SharePoint",
  });
  if (result.duplicate) return c.json(result, 409);
  return c.json(result, 201);
});
