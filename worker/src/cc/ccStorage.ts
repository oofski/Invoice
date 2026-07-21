/**
 * CCRMS R2 storage key helpers (NEW). All bytes go through the existing,
 * key-agnostic `putPdf`/`getPdf`/`deletePdf` (imported read-only from
 * `lib/storage.ts`), so CC objects share the same R2 bucket but live under
 * distinct prefixes (`receipts/cc/...`, `cc/uploads/raw/...`) that NEVER collide
 * with the invoice `invoices/...` prefix.
 */
import type { Env } from "../lib/types";
import { putPdf, getPdf, deletePdf } from "../lib/storage";

/**
 * R2 key for a stored receipt file, year-partitioned by receipt id.
 * e.g. ccReceiptKey("r-123", "pdf") -> "receipts/cc/2026/r-123.pdf".
 */
export function ccReceiptKey(id: string, ext = "pdf"): string {
  const year = new Date().getFullYear();
  return `receipts/cc/${year}/${id}.${ext}`;
}

/**
 * R2 key for the raw Reducto /extract sidecar JSON, derived from a receipt key so
 * it lands beside the receipt bytes.
 * e.g. "receipts/cc/2026/r-123.pdf" -> "receipts/cc/2026/r-123.pdf.reducto.json".
 */
export function ccReductoKey(receiptR2Key: string): string {
  return `${receiptR2Key}.reducto.json`;
}

/**
 * R2 key for an archived raw upload file (the original CSV/XLSX), namespaced by
 * batch id. e.g. ccRawUploadKey("b-9", "amex.xlsx") -> "cc/uploads/raw/b-9/amex.xlsx".
 */
export function ccRawUploadKey(batchId: string, name: string): string {
  const safe = (name || "upload").replace(/[^A-Za-z0-9._-]+/g, "_");
  return `cc/uploads/raw/${batchId}/${safe}`;
}

/** Maps a file MIME type to a storage extension for receipt keys. */
export function ccExtForType(fileType: string | null | undefined): string {
  const t = (fileType || "").toLowerCase();
  if (t.includes("pdf")) return "pdf";
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("heic")) return "heic";
  if (t.includes("webp")) return "webp";
  return "pdf";
}

/** Stores bytes at `key` via the shared R2 putter. */
export function ccPut(env: Env, key: string, bytes: ArrayBuffer, mime?: string): Promise<void> {
  return putPdf(env, key, bytes, mime);
}

/** Stores the raw Reducto sidecar JSON next to a receipt object. */
export async function ccPutReductoRaw(
  env: Env,
  receiptR2Key: string,
  raw: unknown,
): Promise<void> {
  await env.PDFS.put(ccReductoKey(receiptR2Key), JSON.stringify(raw ?? null), {
    httpMetadata: { contentType: "application/json" },
  });
}

/** Returns the R2 object at `key` (with `.body` stream) or null. */
export function ccGet(env: Env, key: string) {
  return getPdf(env, key);
}

/** Best-effort delete of a stored object (and, when asked, its reducto sidecar). */
export async function ccDelete(env: Env, key: string, withSidecar = true): Promise<void> {
  await deletePdf(env, key);
  if (withSidecar) {
    try {
      await deletePdf(env, ccReductoKey(key));
    } catch {
      /* best-effort: a missing sidecar is fine */
    }
  }
}

/**
 * v1.9.10 (H5): refcount-guarded object delete. Removes the R2 object ONLY when
 * no cc_receipts AND no cc_receipt_inbox row still references the key — so a
 * legacy SHARED key (older receipts reused the inbox drop's key) isn't yanked out
 * from under a row that still points at it. Call AFTER deleting the owning DB
 * row(s) so this refcount doesn't count them. Best-effort: never throws.
 */
export async function ccMaybeDeleteObject(env: Env, key: string): Promise<void> {
  if (!key) return;
  try {
    const r = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM cc_receipts WHERE r2_key = ?1) + (SELECT COUNT(*) FROM cc_receipt_inbox WHERE r2_key = ?1) AS n",
    )
      .bind(key)
      .first<{ n: number }>();
    if ((r?.n ?? 0) === 0) await ccDelete(env, key);
  } catch (e) {
    console.error("[cc] ccMaybeDeleteObject failed:", e);
  }
}
