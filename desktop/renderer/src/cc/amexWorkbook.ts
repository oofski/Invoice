/**
 * Amex statement-workbook parser (renderer-side, SheetJS).
 *
 * The Amex monthly workbook has one sheet PER cardholder (named e.g.
 * "Lori 36158" — the sheet title encodes the cardholder + last-5) plus a
 * "Summary" sheet that is skipped. Each cardholder sheet:
 *   - Row 1–2: title / spacer rows (ignored).
 *   - Row 3: the COLUMN HEADER row. We read it BY NAME (not by fixed index)
 *     because the "IN QB" and "HAVE RECEIPT" columns are swapped on some
 *     cardholders' sheets (e.g. Bonnie's). Header-by-name survives that swap.
 *   - Row 4+: data rows. Blank/totals-footer rows (DATE & VENDOR null AND
 *     CHARGE null-or-0) are skipped.
 *   - Entity columns G–M: per-entity allocation amounts. Mapped from the
 *     template column label -> canonical entity_name via CC_ENTITIES.
 *
 * The worker recomputes totals/dedup server-side; this parser only normalizes
 * what the manager uploaded so `/uploads/preview` has structured rows.
 */

import * as XLSX from "xlsx";
import { CC_ENTITIES, type AmexRow } from "./ccApi";

// Sheet whose name (case-insensitive) is the non-cardholder summary tab.
const SUMMARY_SHEET = "summary";

// The header row is the 3rd row (1-based) on each cardholder sheet.
const HEADER_ROW_INDEX = 2; // 0-based -> row 3

// ---------------------------------------------------------------------------
// Header-name matching (tolerant to spacing / case / punctuation)
// ---------------------------------------------------------------------------

function norm(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Canonical entity lookup by normalized template column label. */
const ENTITY_BY_HEADER = new Map<string, string>();
for (const e of CC_ENTITIES) {
  ENTITY_BY_HEADER.set(norm(e.label), e.canonical);
  ENTITY_BY_HEADER.set(norm(e.canonical), e.canonical);
}
// A couple of common template spellings that don't normalize 1:1 to the label.
ENTITY_BY_HEADER.set(norm("Institute Chgo"), "Chicago");
ENTITY_BY_HEADER.set(norm("IBW"), "IBW");
ENTITY_BY_HEADER.set(norm("Nala"), "Nala");
ENTITY_BY_HEADER.set(norm("SKN Bar"), "SKNBar");
ENTITY_BY_HEADER.set(norm("Urban"), "UrbanAyurveda");

interface HeaderMap {
  date: number | null;
  vendor: number | null;
  charge: number | null;
  expAcct: number | null;
  inQb: number | null;
  haveReceipt: number | null;
  /** column index -> canonical entity_name */
  entityCols: { index: number; entity: string }[];
}

function matchHeaders(headerRow: unknown[]): HeaderMap {
  const map: HeaderMap = {
    date: null,
    vendor: null,
    charge: null,
    expAcct: null,
    inQb: null,
    haveReceipt: null,
    entityCols: [],
  };
  headerRow.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;
    if (map.date === null && /\bdate\b/.test(h)) {
      map.date = i;
      return;
    }
    if (
      map.vendor === null &&
      (/\bvendor\b/.test(h) ||
        /\bmerchant\b/.test(h) ||
        /\bdescription\b/.test(h) ||
        /\bpayee\b/.test(h))
    ) {
      map.vendor = i;
      return;
    }
    if (
      map.charge === null &&
      (/\bcharge\b/.test(h) || /\bamount\b/.test(h) || /\btotal\b/.test(h))
    ) {
      // Avoid swallowing "total allocated"/"difference" helper columns: prefer
      // an exact "charge"/"amount"/"total" token, not a longer phrase.
      if (h === "charge" || h === "amount" || h === "total" || /\bcharge\b/.test(h)) {
        map.charge = i;
        return;
      }
    }
    if (map.expAcct === null && (/\bexp\b/.test(h) || /\bacct\b/.test(h) || /\baccount\b/.test(h))) {
      map.expAcct = i;
      return;
    }
    // IN QB / HAVE RECEIPT are read by name (swap-safe).
    if (map.inQb === null && /\bin qb\b/.test(h)) {
      map.inQb = i;
      return;
    }
    if (
      map.haveReceipt === null &&
      (/\bhave receipt\b/.test(h) || /\breceipt\b/.test(h))
    ) {
      map.haveReceipt = i;
      return;
    }
    // Entity columns (G–M) matched by label.
    const entity = ENTITY_BY_HEADER.get(h);
    if (entity && !map.entityCols.some((c) => c.entity === entity)) {
      map.entityCols.push({ index: i, entity });
    }
  });
  return map;
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function numAt(row: unknown[], idx: number | null): number {
  if (idx === null) return 0;
  const v = row[idx];
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function strAt(row: unknown[], idx: number | null): string {
  if (idx === null) return "";
  const v = row[idx];
  return v == null ? "" : String(v).trim();
}

function flagAt(row: unknown[], idx: number | null): boolean {
  if (idx === null) return false;
  const v = strAt(row, idx).toLowerCase();
  return v === "x" || v === "yes" || v === "y" || v === "true" || v === "1";
}

/**
 * Excel serial date / string -> ISO YYYY-MM-DD. SheetJS returns dates as either
 * a JS Date (when cellDates), a serial number, or a string depending on the
 * cell. We read with raw values; coerce all three.
 */
function toIsoDate(v: unknown): string {
  if (v == null || v === "") return "";
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    // Excel serial -> JS Date (SheetJS helper handles the 1900 epoch quirk).
    const d = XLSX.SSF ? excelSerialToDate(v) : null;
    if (d) return d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const yyyy = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${yyyy}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

/** Excel 1900-system serial number -> JS Date (UTC). */
function excelSerialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  // Excel epoch is 1899-12-30 (accounts for the 1900 leap-year bug).
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AmexParseResult {
  rows: AmexRow[];
  /** Cardholder sheet names encountered (post-Summary skip). */
  sheetNames: string[];
  /** True when no data rows were found across all sheets (blank template). */
  isBlankTemplate: boolean;
  /** "flat" = the Amex activity export (Date/Description/Card Member/Account #/Amount); "workbook" = per-cardholder sheets. */
  format: "flat" | "workbook" | "empty";
}

// ---------------------------------------------------------------------------
// FLAT Amex "activity" export (Date | Receipt | Description | Card Member |
// Account # | Amount) — the report Amex hands out from its portal, as XLSX or
// CSV. This is the common case; the per-cardholder workbook below is the
// accountant's manual reconciliation file.
// ---------------------------------------------------------------------------

interface FlatHeaderMap {
  date: number | null;
  vendor: number | null;
  amount: number | null;
  cardMember: number | null;
  account: number | null;
}

function matchFlatHeader(headerRow: unknown[]): FlatHeaderMap {
  const map: FlatHeaderMap = { date: null, vendor: null, amount: null, cardMember: null, account: null };
  headerRow.forEach((raw, i) => {
    const h = norm(raw);
    if (!h) return;
    if (map.date === null && /\bdate\b/.test(h)) map.date = i;
    else if (map.cardMember === null && (/\bcard member\b/.test(h) || /\bcardholder\b/.test(h) || h === "member" || h === "name")) map.cardMember = i;
    else if (map.account === null && (/\baccount\b/.test(h) || /\bcard\b/.test(h))) map.account = i;
    else if (map.vendor === null && (/\bdescription\b/.test(h) || /\bvendor\b/.test(h) || /\bmerchant\b/.test(h) || /\bpayee\b/.test(h))) map.vendor = i;
    else if (map.amount === null && (h === "amount" || /\bamount\b/.test(h) || h === "charge")) map.amount = i;
  });
  return map;
}

function isFlatHeader(m: FlatHeaderMap): boolean {
  // A flat activity sheet has a date, a description, an amount, AND a per-row
  // card identity (Card Member name or Account #) — that last column is what the
  // per-cardholder workbook lacks (its cardholder is the SHEET, not a column).
  return m.date !== null && m.vendor !== null && m.amount !== null && (m.cardMember !== null || m.account !== null);
}

/** Collapse runs of whitespace in a merchant string ("ALLERGAN     CA" → "ALLERGAN CA"). */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Parse a flat array-of-arrays into AmexRows, or null if no flat header is present in the first few rows. */
function parseFlatAoa(aoa: unknown[][]): AmexRow[] | null {
  let headerIdx = -1;
  let map: FlatHeaderMap | null = null;
  for (let i = 0; i < Math.min(aoa.length, 8); i++) {
    const m = matchFlatHeader((aoa[i] ?? []) as unknown[]);
    if (isFlatHeader(m)) {
      headerIdx = i;
      map = m;
      break;
    }
  }
  if (headerIdx < 0 || !map) return null;

  const rows: AmexRow[] = [];
  for (let r = headerIdx + 1; r < aoa.length; r++) {
    const row = (aoa[r] ?? []) as unknown[];
    const isoDate = toIsoDate(map.date === null ? null : row[map.date]);
    const vendor = tidy(strAt(row, map.vendor));
    const amount = numAt(row, map.amount);
    if (!isoDate && !vendor && (amount === 0 || amount === null)) continue;
    if (!isoDate && !vendor) continue;

    const cardMember = tidy(strAt(row, map.cardMember));
    const acctDigits = strAt(row, map.account).replace(/\D/g, "");
    const last5 = acctDigits ? acctDigits.slice(-5) : null;

    rows.push({
      sheet_name: "",
      transaction_date: isoDate,
      vendor,
      amount: Math.abs(amount),
      card_member: cardMember || null,
      amex_last5: last5,
    });
  }
  return rows;
}

/** Minimal CSV → array-of-arrays (handles quoted commas) for the flat Amex CSV export. */
function csvToAoa(text: string): unknown[][] {
  const lines = text.split(/\r?\n/);
  const out: unknown[][] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    const cells: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    out.push(cells);
  }
  return out;
}

/** Parse the Amex CSV activity export (flat columns) into normalized rows. */
export function parseAmexCsv(text: string): AmexParseResult {
  const aoa = csvToAoa(text);
  const flat = parseFlatAoa(aoa) ?? [];
  return {
    rows: flat,
    sheetNames: [],
    isBlankTemplate: flat.length === 0,
    format: flat.length ? "flat" : "empty",
  };
}

/**
 * Parse an Amex workbook from raw bytes (ArrayBuffer). Returns normalized rows
 * across every cardholder sheet, ready to JSON-stringify into the
 * `/uploads/preview` multipart body.
 */
export function parseAmexWorkbook(buf: ArrayBuffer): AmexParseResult {
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const rows: AmexRow[] = [];
  const sheetNames: string[] = [];
  let sawFlat = false;

  for (const sheetName of wb.SheetNames) {
    if (norm(sheetName) === SUMMARY_SHEET) continue;
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: null,
    });
    if (aoa.length === 0) continue;

    // First try the FLAT activity format (Date / Description / Card Member /
    // Account # / Amount). This is the export Amex actually hands out.
    const flat = parseFlatAoa(aoa);
    if (flat) {
      sawFlat = true;
      rows.push(...flat);
      continue;
    }

    // Else fall back to the per-cardholder workbook (header on Row 3, entity columns).
    if (aoa.length <= HEADER_ROW_INDEX) continue;

    const headerRow = aoa[HEADER_ROW_INDEX] ?? [];
    const headers = matchHeaders(headerRow as unknown[]);
    // A cardholder sheet must at least have a date + vendor + charge column.
    if (headers.date === null && headers.vendor === null && headers.charge === null) {
      continue;
    }

    sheetNames.push(sheetName);

    for (let r = HEADER_ROW_INDEX + 1; r < aoa.length; r++) {
      const row = (aoa[r] ?? []) as unknown[];
      const dateRaw = headers.date === null ? null : row[headers.date];
      const vendor = strAt(row, headers.vendor);
      const charge = numAt(row, headers.charge);

      // Skip blank / totals-footer rows: DATE & VENDOR empty AND CHARGE 0.
      const isoDate = toIsoDate(dateRaw);
      if (!isoDate && !vendor && (charge === 0 || charge === null)) continue;
      // A footer "Total" row often has a vendor-like label but no date and a
      // large charge — guard by requiring SOME date when there is no real
      // vendor amount semantics. We keep rows that have a date OR a vendor
      // with a non-zero charge.
      if (!isoDate && !vendor) continue;

      const splits = headers.entityCols
        .map((c) => ({ entity_name: c.entity, amount: numAt(row, c.index) }))
        .filter((s) => Math.abs(s.amount) > 0.0001);

      rows.push({
        sheet_name: sheetName,
        transaction_date: isoDate,
        vendor,
        amount: charge,
        exp_acct: strAt(row, headers.expAcct) || null,
        have_receipt: flagAt(row, headers.haveReceipt),
        in_qb: flagAt(row, headers.inQb),
        splits: splits.length ? splits : undefined,
      });
    }
  }

  return {
    rows,
    sheetNames,
    isBlankTemplate: rows.length === 0,
    format: sawFlat ? "flat" : rows.length || sheetNames.length ? "workbook" : "empty",
  };
}
