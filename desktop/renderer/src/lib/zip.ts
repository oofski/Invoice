/**
 * Client-side bulk-zip of invoice PDFs (Feature 1).
 *
 * Fetches each invoice's PDF from the EXISTING authed `/api/invoices/:id/pdf`
 * endpoint (so APPROVED invoices arrive already stamped — no Worker change),
 * with bounded concurrency, and assembles a single .zip Blob in the renderer
 * (Chromium has far more memory headroom than a Worker). Invoices whose PDF is
 * missing or fails to fetch are skipped silently — never an empty/failed entry.
 *
 * Entry filenames include the invoice id so two invoices that share a
 * vendor+number do NOT collide inside the archive.
 */

import { zipSync, type Zippable } from "fflate";
import { api } from "./api";

const STORE_LEVEL = 0; // fflate compression level 0 = store (PDFs are already compressed).
const ZIP_MIME = "application/zip";
const CONCURRENCY = 5;

export interface ZipPdfItem {
  id: string;
  /** Human-friendly base file name (without the id prefix / extension). */
  fileName: string;
}

export interface ZipResult {
  blob: Blob;
  /** Number of real files written into the archive. */
  zipped: number;
  /** Human labels of attachments that weren't a viewable document (see manifest). */
  skipped: string[];
}

/** Strips characters that are unsafe in a zip entry / OS file name. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "invoice";
}

/**
 * Magic-byte sniff of the fetched bytes (NOT the response content-type, which
 * older mislabeled invoices report as application/pdf even for non-PDFs). Returns
 * the correct extension, or ok=false for anything that isn't a viewable document
 * (HTML/text/JSON/unknown) so the caller never forges a broken `.pdf`.
 */
function sniff(b: Uint8Array): { ext: string; ok: boolean } {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return { ext: "pdf", ok: true }; // %PDF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { ext: "jpg", ok: true };
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { ext: "png", ok: true };
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { ext: "gif", ok: true };
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return { ext: "webp", ok: true };
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))
  )
    return { ext: "tiff", ok: true };
  return { ext: "", ok: false }; // text / html / json / unknown — not a real doc
}

/**
 * Fetches every item's PDF (concurrency ~5), skips failures/no-pdf, and returns
 * a single zip Blob. `onProgress(done, total)` is called after each attempt so
 * callers can show "N of M". Resolves even if some (or all) fetches fail; an
 * all-skipped batch yields a valid empty zip — callers should guard on count.
 */
export async function zipPdfs(
  items: ZipPdfItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<ZipResult> {
  const total = items.length;
  let done = 0;
  const entries: Zippable = {};
  const skipped: string[] = [];

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const blob = await api.getBlob(`/api/invoices/${item.id}/pdf`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const kind = sniff(bytes);
        if (!kind.ok) {
          // Not a viewable document (e.g. an HTML email body stored as a "PDF").
          // Record it instead of writing an unreadable `.pdf` into the archive.
          skipped.push(`${item.fileName} (${item.id})`);
        } else {
          // id prefix guarantees uniqueness even on duplicate vendor+number;
          // extension reflects the REAL content, not a forged `.pdf`.
          const entryName = `${safeName(item.fileName)}_${item.id}.${kind.ext}`;
          entries[entryName] = [bytes, { level: STORE_LEVEL }];
        }
      } catch {
        // Missing PDF / 403 / 404 / network — skip this invoice silently.
      } finally {
        done += 1;
        onProgress?.(done, total);
      }
    }
  }

  const pool = Array.from(
    { length: Math.min(CONCURRENCY, items.length || 1) },
    () => worker(),
  );
  await Promise.all(pool);

  const zipped = Object.keys(entries).length;
  if (skipped.length > 0) {
    // Surface exactly which invoices have no usable PDF, inside the archive.
    const manifest =
      "These approved invoices had no usable PDF (the stored attachment isn't a " +
      "viewable document — re-upload a PDF, or run Repair attachments):\n\n" +
      skipped.map((s) => `  - ${s}`).join("\n") +
      "\n";
    entries["_UNREADABLE.txt"] = [new TextEncoder().encode(manifest), { level: STORE_LEVEL }];
  }

  const zippedBytes = zipSync(entries);
  return { blob: new Blob([zippedBytes], { type: ZIP_MIME }), zipped, skipped };
}
