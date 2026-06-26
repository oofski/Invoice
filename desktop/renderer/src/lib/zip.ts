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

/** Strips characters that are unsafe in a zip entry / OS file name. */
function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim() || "invoice";
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
): Promise<Blob> {
  const total = items.length;
  let done = 0;
  const entries: Zippable = {};

  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        const blob = await api.getBlob(`/api/invoices/${item.id}/pdf`);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // id prefix guarantees uniqueness even on duplicate vendor+number.
        const entryName = `${safeName(item.fileName)}_${item.id}.pdf`;
        entries[entryName] = [bytes, { level: STORE_LEVEL }];
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

  const zipped = zipSync(entries);
  return new Blob([zipped], { type: ZIP_MIME });
}
