/**
 * Builds the multi-tab QBO bill-import workbook (.xlsx) from a factor export.
 *
 * Runs in the Electron renderer (browser context); SheetJS is bundled by Vite.
 * One worksheet per entity, each laid out as a plain array-of-arrays with the
 * shared `header` row on top. The backend has already ordered the rows and
 * blanked follow-on header cells, so we only need to project each row onto the
 * header column order here.
 */

import * as XLSX from "xlsx";
import type { EntitySheet } from "./types";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Excel worksheet titles are capped at 31 characters. */
const MAX_SHEET_NAME = 31;

/**
 * Builds the per-entity human-summary footer appended below the data grid.
 * Returns two array-of-arrays rows: a fully-blank spacer row that terminates the
 * QBO "Import Bills" data region, followed by a labeled total row that is
 * IMPORT-SAFE — the required QBO key fields (`*Bill Number`, `*Vendor`,
 * `*Bill Date`) are left BLANK so the importer skips it. The business-entity
 * label is written in the benign `Memo` column and the summed `Amount` under the
 * `Amount` column, so it reads as an obvious human summary, never as a bill line.
 */
function entityFooterRows(
  entity: EntitySheet,
  header: string[],
  width: number,
): string[][] {
  const blank = new Array(width).fill("");
  const total = entity.rows.reduce(
    (s, r) => s + (parseFloat(r["Amount"] ?? "") || 0),
    0,
  );
  const footer = new Array(width).fill("");
  const memoIdx = header.indexOf("Memo");
  const amountIdx = header.indexOf("Amount");
  // Fallbacks keep the key fields blank even if a column name ever changes.
  if (memoIdx >= 0) footer[memoIdx] = `Total — ${entity.entity}`;
  if (amountIdx >= 0) footer[amountIdx] = total.toFixed(2);
  return [blank, footer];
}

export function buildBillWorkbook(
  entities: EntitySheet[],
  header: string[],
): Blob {
  const wb = XLSX.utils.book_new();

  for (const entity of entities) {
    const aoa: string[][] = [
      header,
      ...entity.rows.map((r) => header.map((col) => r[col] ?? "")),
      // Blank spacer + import-safe business-total footer at the bottom of the
      // sheet. The spacer terminates QBO's contiguous data region; the footer
      // sits below it (human summary only, never imported as a bill).
      ...entityFooterRows(entity, header, header.length),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(
      wb,
      ws,
      entity.sheetName.slice(0, MAX_SHEET_NAME),
    );
  }

  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], { type: XLSX_MIME });
}

// ---------------------------------------------------------------------------
// Generic single-/multi-sheet workbook builder (used by the Invoices and Audit
// "Download Excel" buttons). Each sheet is a header row plus an array-of-arrays
// of cell values. Reuses the same `aoa_to_sheet` / `XLSX_MIME` / 31-char cap.
// ---------------------------------------------------------------------------

export interface SheetSpec {
  name: string;
  /** Header row plus the projected data rows. */
  aoa: (string | number)[][];
}

/** Projects a header + rows into a named sheet spec for `buildWorkbook`. */
export function buildSheet(
  name: string,
  header: string[],
  rows: (string | number)[][],
): SheetSpec {
  return { name, aoa: [header, ...rows] };
}

/** Assembles one or more `SheetSpec`s into a downloadable .xlsx Blob. */
export function buildWorkbook(sheets: SheetSpec[]): Blob {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.aoa);
    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, MAX_SHEET_NAME));
  }
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new Blob([out], { type: XLSX_MIME });
}
