import { clsx, type ClassValue } from "clsx";

/** Tailwind-friendly className combiner. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Parses a money string like "$1,234.56" into a number. */
export function parseAmount(value: string | number | null | undefined): number {
  if (typeof value === "number") return value;
  if (!value) return 0;
  const cleaned = value.replace(/[^0-9.\-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Formats a number as USD currency. */
export function formatCurrency(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** MM/DD/YYYY string -> ISO date (YYYY-MM-DD) for Postgres DATE columns. */
export function toIsoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const mdy = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const mm = mdy[1];
    const dd = mdy[2];
    const yyyy = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return null;
}

/** Human-friendly date for display. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Case-insensitive, whitespace-tolerant name comparison — matches an invoice's
 * approver (approved_by) to an executive's profile name (mirrors the Worker).
 */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Whole hours elapsed since an ISO timestamp. */
export function hoursSince(iso: string | null | undefined): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 0;
  return (Date.now() - then) / (1000 * 60 * 60);
}

/** "3h ago" / "2d ago" age label. */
export function ageLabel(iso: string | null | undefined): string {
  const h = hoursSince(iso);
  if (h < 1) return "<1h";
  if (h < 24) return `${Math.floor(h)}h`;
  return `${Math.floor(h / 24)}d`;
}
