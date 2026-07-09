/** Misc helpers shared across the Worker. */

/**
 * Cloudflare D1 rejects any query that binds more than 100 parameters
 * ("D1_ERROR: too many SQL variables"). Queries that build a `WHERE col IN (?,?,…)`
 * clause with one placeholder per id therefore fail once the id list is large
 * (e.g. hundreds of invoices). `CHUNK_SIZE` keeps each batch well under the cap
 * (leaving headroom for a few fixed params in the same statement); callers run
 * one query per `chunk()` batch and merge the results.
 */
export const D1_MAX_VARS = 100;
export const CHUNK_SIZE = 90;

export function chunk<T>(arr: readonly T[], size: number = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parses a money string like "$1,234.56" into a number. */
export function parseAmount(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const n = parseFloat(String(value).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** MM/DD/YYYY or ISO -> YYYY-MM-DD. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const mdy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const mm = mdy[1].padStart(2, "0");
    const dd = mdy[2].padStart(2, "0");
    const yyyy = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 3_600_000;
}

/**
 * Case-insensitive, whitespace-tolerant comparison of two person names. Used to
 * match an invoice's approver (approved_by) to an executive user's name so that
 * "Lisa", "lisa", and "Lisa " all resolve to the same person.
 */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Safe JSON parse for TEXT columns. */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** ArrayBuffer -> base64 (for Textract Document.Bytes). */
export function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
