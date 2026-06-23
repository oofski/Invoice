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

export function buildBillWorkbook(
  entities: EntitySheet[],
  header: string[],
): Blob {
  const wb = XLSX.utils.book_new();

  for (const entity of entities) {
    const aoa: string[][] = [
      header,
      ...entity.rows.map((r) => header.map((col) => r[col] ?? "")),
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
