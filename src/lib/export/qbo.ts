import type { InvoiceRow, LineItemRow } from "@/lib/types";

/**
 * QuickBooks Online "Bills" import CSV generator (Brief §06/§12 Session 6).
 *
 * Produces the standard QBO multi-line Bills import format: one CSV row per GL
 * line, with the bill header fields (Bill No, Vendor, dates, terms) repeated on
 * each of a bill's lines. This is the file the accountant downloads and imports
 * manually — no QBO API/OAuth (Brief §01).
 *
 * Split handling: a split parent line is excluded; only leaf lines (original
 * un-split items, or the child allocations of a split) are emitted, so the
 * exported line amounts always reconcile to the invoice total.
 */

export const QBO_BILLS_HEADER = [
  "Bill No",
  "Vendor",
  "Bill Date",
  "Due Date",
  "Terms",
  "Account",
  "Line Description",
  "Line Amount",
  "Class",
  "Memo",
] as const;

export interface ExportInvoice {
  invoice: InvoiceRow;
  lineItems: LineItemRow[];
}

function csvField(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** YYYY-MM-DD (Postgres DATE) -> MM/DD/YYYY for QuickBooks. */
function toQboDate(date: string | null): string {
  if (!date) return "";
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[2]}/${m[3]}/${m[1]}`;
  return date;
}

function money(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  return v.toFixed(2);
}

/**
 * Returns the leaf line items for a bill: excludes any line that has been split
 * into children (i.e. lines that are referenced as a split_parent_id).
 */
function leafLineItems(lineItems: LineItemRow[]): LineItemRow[] {
  const parentIds = new Set(
    lineItems
      .map((li) => li.split_parent_id)
      .filter((id): id is string => !!id),
  );
  const ordered = [...lineItems].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  return ordered.filter((li) => !parentIds.has(li.id));
}

export function generateQboBillsCsv(invoices: ExportInvoice[]): {
  csv: string;
  rowCount: number;
} {
  const rows: string[] = [];
  rows.push(QBO_BILLS_HEADER.map(csvField).join(","));

  let rowCount = 0;
  for (const { invoice, lineItems } of invoices) {
    const leaves = leafLineItems(lineItems);
    const lines =
      leaves.length > 0
        ? leaves
        : // Fallback: a single line for the full total if no line items exist.
          [
            {
              description: invoice.vendor,
              amount: invoice.total_amount,
              gl_category: "Miscellaneous",
            } as Partial<LineItemRow>,
          ];

    for (const li of lines) {
      rows.push(
        [
          invoice.invoice_number,
          invoice.vendor,
          toQboDate(invoice.inv_date),
          toQboDate(invoice.due_date),
          "Net 30",
          li.gl_category ?? "",
          li.description ?? "",
          money(li.amount ?? null),
          invoice.class && invoice.class !== "None"
            ? `${invoice.business}:${invoice.class}`
            : invoice.business ?? "",
          `InvoiceIQ export — approved by ${invoice.approved_by ?? "—"}`,
        ]
          .map(csvField)
          .join(","),
      );
      rowCount++;
    }
  }

  return { csv: rows.join("\r\n"), rowCount };
}

/** Builds a timestamped export filename. */
export function buildExportFilename(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate(),
  )}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `InvoiceIQ_QBO_Bills_${stamp}.csv`;
}
