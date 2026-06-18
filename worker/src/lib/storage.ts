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
