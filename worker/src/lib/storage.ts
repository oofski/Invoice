import type { Env } from "./types";

/**
 * Invoice PDF storage on Cloudflare R2. Keys are deterministic per invoice so a
 * reprocess/re-upload overwrites cleanly. The pdf_files table holds the key +
 * metadata; the bytes live here in R2 (scales to large scans and high volume).
 */

export function pdfKey(invoiceId: string): string {
  const year = new Date().getFullYear();
  return `invoices/${year}/${invoiceId}.pdf`;
}

/**
 * R2 key for the raw Reducto /extract response, stored as a sidecar next to the
 * invoice PDF (v1.1.8 A). Derived from the PDF key so it lands in the same
 * year-partitioned prefix and is found again on reprocess. e.g.
 * "invoices/2026/<id>.pdf" -> "invoices/2026/<id>.pdf.reducto.json".
 */
export function reductoKey(pdfR2Key: string): string {
  return `${pdfR2Key}.reducto.json`;
}

/** Stores the raw Reducto extract JSON as a sidecar object next to the PDF. */
export async function putReductoRaw(
  env: Env,
  pdfR2Key: string,
  raw: unknown,
): Promise<void> {
  await env.PDFS.put(reductoKey(pdfR2Key), JSON.stringify(raw ?? null), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Returns the raw Reducto sidecar R2 object (with .body stream) or null. */
export function getReductoRaw(env: Env, pdfR2Key: string) {
  return env.PDFS.get(reductoKey(pdfR2Key));
}

export async function putPdf(
  env: Env,
  key: string,
  bytes: ArrayBuffer,
  mime = "application/pdf",
): Promise<void> {
  await env.PDFS.put(key, bytes, {
    httpMetadata: { contentType: mime },
  });
}

/** Returns the R2 object (with .body stream + .arrayBuffer()) or null. */
export function getPdf(env: Env, key: string) {
  return env.PDFS.get(key);
}

export async function deletePdf(env: Env, key: string): Promise<void> {
  await env.PDFS.delete(key);
}
