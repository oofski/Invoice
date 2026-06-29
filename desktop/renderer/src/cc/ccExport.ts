/**
 * Tiny shared helper for the CC "Export Excel" buttons. Wraps the read-only
 * `@/lib/workbook` SheetJS builders + `downloadBlob` into a single call so each
 * CC list page can project a header + rows into a one-sheet .xlsx download.
 */

import { buildSheet, buildWorkbook } from "@/lib/workbook";
import { downloadBlob } from "@/lib/utils";

/** Build a single-sheet workbook from `header` + `rows` and trigger a download. */
export function downloadSheet(
  filename: string,
  sheetName: string,
  header: string[],
  rows: (string | number)[][],
): void {
  const blob = buildWorkbook([buildSheet(sheetName, header, rows)]);
  downloadBlob(blob, filename);
}

/** Today's date as YYYY-MM-DD, for filename stamping. */
export function exportDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
