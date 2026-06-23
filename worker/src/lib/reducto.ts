import type { Env } from "./types";

/**
 * Reducto document parsing (replaces AWS Textract). Flow:
 *   1) POST /upload  — send the PDF bytes, get back a `reducto://` document id.
 *   2) POST /parse   — parse that document into structured text/markdown for
 *                      the Claude prompts.
 *
 * Auth is a Bearer API key. Base URL is configurable via REDUCTO_BASE_URL so we
 * can pin it without a code change.
 *
 * VERIFY against your Reducto account/docs when you first test (these are the
 * documented shapes; field names may differ slightly):
 *   - base URL (default below),
 *   - /upload response id field (we accept url | file_id | document_url | id),
 *   - /parse returning inline chunks vs. a result URL for large docs (handled).
 */

const DEFAULT_BASE = "https://platform.reducto.ai";

function baseUrl(env: Env): string {
  return (env.REDUCTO_BASE_URL || DEFAULT_BASE).replace(/\/$/, "");
}

function authHeaders(env: Env): Record<string, string> {
  if (!env.REDUCTO_API_KEY) throw new Error("Missing REDUCTO_API_KEY");
  return { authorization: `Bearer ${env.REDUCTO_API_KEY}` };
}

/** Uploads PDF bytes and returns the reducto:// document id. */
export async function uploadToReducto(
  env: Env,
  bytes: ArrayBuffer,
  fileName: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([bytes], { type: "application/pdf" }),
    fileName || "invoice.pdf",
  );
  const res = await fetch(`${baseUrl(env)}/upload`, {
    method: "POST",
    headers: authHeaders(env),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Reducto upload ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const id =
    (data.url as string) ||
    (data.file_id as string) ||
    (data.document_url as string) ||
    (data.id as string);
  if (!id) throw new Error("Reducto upload: no document id in response");
  return id;
}

/** Parses a document and returns the raw response + flattened text. */
export async function parseWithReducto(
  env: Env,
  documentUrl: string,
): Promise<{ raw: unknown; text: string }> {
  const res = await fetch(`${baseUrl(env)}/parse`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ document_url: documentUrl }),
  });
  if (!res.ok) {
    throw new Error(`Reducto parse ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const raw = (await res.json()) as Record<string, unknown>;

  // Large results may be returned as a URL to download rather than inline.
  const result = (raw.result ?? raw) as Record<string, unknown>;
  if (result?.type === "url" && typeof result.url === "string") {
    const full = await (await fetch(result.url)).json();
    return { raw: full, text: extractTextFromReducto(full) };
  }
  return { raw, text: extractTextFromReducto(raw) };
}

/** Convenience: PDF bytes -> { raw, text } (upload + parse). */
export async function ocrPdf(
  env: Env,
  bytes: ArrayBuffer,
  fileName: string,
): Promise<{ raw: unknown; text: string }> {
  const id = await uploadToReducto(env, bytes, fileName);
  return parseWithReducto(env, id);
}

/**
 * Structured extraction via Reducto /extract. Sends a JSON schema + system
 * prompt and returns the structured object (`data`) plus the raw response.
 * Tolerant of response-shape variations: result may be `result`/`data`/
 * `extracted`/`output`, an array (we take [0]), a `{type:"url"}` pointer for
 * large docs, and citation-wrapped fields (`{value, confidence, bbox,...}`).
 */
export async function runExtract(
  env: Env,
  documentUrl: string,
  opts: { schema: unknown; systemPrompt?: string; arrayExtract?: boolean },
): Promise<{ raw: unknown; data: unknown }> {
  const body: Record<string, unknown> = {
    input: documentUrl,
    instructions: {
      schema: opts.schema,
      ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
    },
    settings: { array_extract: opts.arrayExtract ?? true },
  };
  const res = await fetch(`${baseUrl(env)}/extract`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Reducto extract ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const raw = await res.json();
  let node = pickExtractResult(raw);
  if (
    node &&
    typeof node === "object" &&
    (node as Record<string, unknown>).type === "url" &&
    typeof (node as Record<string, unknown>).url === "string"
  ) {
    const full = await (await fetch((node as Record<string, unknown>).url as string)).json();
    node = pickExtractResult(full);
    return { raw: full, data: unwrapCitations(node) };
  }
  return { raw, data: unwrapCitations(node) };
}

function pickExtractResult(raw: unknown): unknown {
  const root = (raw ?? {}) as Record<string, unknown>;
  let r: unknown = root.result ?? root.data ?? root.extracted ?? root.output ?? root;
  if (Array.isArray(r)) r = r.length ? r[0] : {};
  return r;
}

/** Unwraps Reducto citation wrappers `{value, confidence, bbox,...}` -> value. */
function unwrapCitations(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapCitations);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (
      "value" in o &&
      keys.some((k) => ["citation", "citations", "confidence", "bbox", "reasoning"].includes(k))
    ) {
      return unwrapCitations(o.value);
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = unwrapCitations(o[k]);
    return out;
  }
  return v;
}

/**
 * Flattens a Reducto parse response into a single markdown/text string for the
 * Claude prompts. Tolerant of response-shape variations (chunks with
 * content/embed/text/markdown, nested blocks, or a top-level markdown/content).
 */
export function extractTextFromReducto(raw: unknown): string {
  const parts: string[] = [];
  const push = (s: unknown) => {
    if (typeof s === "string" && s.trim()) parts.push(s.trim());
  };

  const root = (raw ?? {}) as Record<string, unknown>;
  const result = (root.result ?? root) as Record<string, unknown>;

  if (typeof result === "string") push(result);

  const chunks = (result?.chunks ?? root?.chunks) as unknown;
  if (Array.isArray(chunks)) {
    for (const ch of chunks as Record<string, unknown>[]) {
      push(ch?.content);
      push(ch?.embed);
      push(ch?.text);
      push(ch?.markdown);
      const blocks = ch?.blocks as unknown;
      if (Array.isArray(blocks)) {
        for (const b of blocks as Record<string, unknown>[]) {
          push(b?.content);
          push(b?.text);
        }
      }
    }
  }
  push(result?.markdown);
  push(result?.content);
  push(result?.text);

  const text = parts.join("\n\n").trim();
  // Last-resort fallback so the pipeline still has something to work with.
  return text || JSON.stringify(raw).slice(0, 20000);
}
