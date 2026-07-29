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
): Promise<{ raw: unknown; data: unknown; mode: ExtractMode }> {
  const arrayExtract = opts.arrayExtract ?? true;
  // ENHANCED settings (v1.1.8 O): deep_extract is the main accuracy lever;
  // citations wraps each value as {value, citations:[{bbox,page,confidence}]}
  // (used by the light confidence gating in P). DEFENSIVE: if Deep Extract is
  // genuinely UNAVAILABLE we fall back to a minimal single-pass extract so the
  // invoice still processes — but (v1.9.x) we first retry the DEEP call on a
  // transient blip, and we report which mode actually ran so a silent downgrade
  // is visible instead of quietly costing accuracy.
  const enhancedSettings = {
    array_extract: arrayExtract,
    deep_extract: true,
    citations: true,
  };
  const minimalSettings = { array_extract: arrayExtract };

  const post = async (settings: Record<string, unknown>): Promise<Response> => {
    const body: Record<string, unknown> = {
      input: documentUrl,
      instructions: {
        schema: opts.schema,
        ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
      },
      settings,
    };
    return fetch(`${baseUrl(env)}/extract`, {
      method: "POST",
      headers: { ...authHeaders(env), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  // A network throw becomes null so the retry/fallback logic can treat it like a
  // transient failure rather than aborting the whole extraction.
  const tryPost = async (
    settings: Record<string, unknown>,
  ): Promise<Response | null> => {
    try {
      return await post(settings);
    } catch (e) {
      console.warn(`[reducto] /extract network error: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  };

  // 1) Deep Extract. On a TRANSIENT failure (network / 408 / 429 / 5xx) retry the
  //    DEEP call ONCE before considering any downgrade — a blip must not silently
  //    cost us Deep Extract accuracy.
  let res = await tryPost(enhancedSettings);
  if (!res || (!res.ok && isTransientStatus(res.status))) {
    await new Promise((r) => setTimeout(r, 600));
    res = await tryPost(enhancedSettings);
  }

  let mode: ExtractMode = "deep";
  if (!res || !res.ok) {
    // Deep Extract is unavailable (unsupported on this plan, or a persistent
    // outage). Fall back to a standard single-pass extract so the invoice STILL
    // processes — but log loudly that accuracy was reduced for this document.
    const detail = res
      ? `status ${res.status}: ${(await res.text()).slice(0, 300)}`
      : "network error";
    console.error(
      `[reducto] Deep Extract unavailable (${detail}) — falling back to STANDARD extraction for this document`,
    );
    const min = await post(minimalSettings);
    if (!min.ok) {
      throw new Error(`Reducto extract ${min.status}: ${(await min.text()).slice(0, 300)}`);
    }
    res = min;
    mode = "minimal";
  } else {
    console.log("[reducto] /extract succeeded via Deep Extract");
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
    return { raw: full, data: unwrapCitations(node), mode };
  }
  return { raw, data: unwrapCitations(node), mode };
}

/** Which Reducto extraction path actually ran (observability for a silent downgrade). */
export type ExtractMode = "deep" | "minimal";

/** Transient HTTP statuses worth retrying the Deep Extract call for. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function pickExtractResult(raw: unknown): unknown {
  const root = (raw ?? {}) as Record<string, unknown>;
  let r: unknown = root.result ?? root.data ?? root.extracted ?? root.output ?? root;
  if (Array.isArray(r)) r = r.length ? r[0] : {};
  return r;
}

/**
 * Per-line confidence marker (v1.1.8 P). When `citations: true` is on, each leaf
 * value arrives as a citation wrapper; `unwrapCitations` strips it to the raw
 * value but ALSO stamps this field on each rebuilt object with the MINIMUM
 * numeric citation confidence found across that object's direct field wrappers.
 * Absent when no numeric confidence was present (so behavior degrades to the
 * pre-citations default — never flag on missing confidence). Consumed by
 * normalizeExtract to optionally flag clearly-low-confidence lines.
 */
export const MIN_CONFIDENCE_KEY = "__minConfidence";

/** True when `o` is a citation wrapper: `{value, ...one of citation keys}`. */
function isCitationWrapper(o: Record<string, unknown>): boolean {
  return (
    "value" in o &&
    Object.keys(o).some((k) =>
      ["citation", "citations", "confidence", "bbox", "reasoning"].includes(k),
    )
  );
}

/**
 * Extracts the minimum numeric confidence from a citation wrapper — looking at a
 * flat `confidence` number and/or each entry of a `citations[]` array's
 * `confidence`. Returns null when no clearly-numeric confidence is present
 * (conservative: absent confidence must NOT trigger a flag).
 */
function wrapperConfidence(o: Record<string, unknown>): number | null {
  const confs: number[] = [];
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    confs.push(o.confidence);
  }
  const cites = o.citations ?? o.citation;
  if (Array.isArray(cites)) {
    for (const c of cites) {
      const cc = (c ?? {}) as Record<string, unknown>;
      if (typeof cc.confidence === "number" && Number.isFinite(cc.confidence)) {
        confs.push(cc.confidence);
      }
    }
  }
  return confs.length ? Math.min(...confs) : null;
}

/**
 * Unwraps Reducto citation wrappers `{value, confidence, bbox,...}` -> value.
 * Additionally stamps `MIN_CONFIDENCE_KEY` on each rebuilt object with the min
 * numeric confidence across its direct field wrappers (v1.1.8 P), when present.
 */
function unwrapCitations(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unwrapCitations);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (isCitationWrapper(o)) {
      return unwrapCitations(o.value);
    }
    const out: Record<string, unknown> = {};
    const confs: number[] = [];
    for (const k of Object.keys(o)) {
      const fieldVal = o[k];
      // Capture this field's confidence (when the field is itself a wrapper)
      // BEFORE we strip it, so the parent object retains a min-confidence signal.
      if (fieldVal && typeof fieldVal === "object" && !Array.isArray(fieldVal)) {
        const fo = fieldVal as Record<string, unknown>;
        if (isCitationWrapper(fo)) {
          const c = wrapperConfidence(fo);
          if (c != null) confs.push(c);
        }
      }
      out[k] = unwrapCitations(fieldVal);
    }
    if (confs.length) out[MIN_CONFIDENCE_KEY] = Math.min(...confs);
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
