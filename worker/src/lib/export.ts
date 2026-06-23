import type {
  InvoiceRow,
  LineItemRow,
  InvoiceAllocationRow,
  VendorMappingRow,
} from "./types";
import { resolveGlAccount } from "./rules";

/**
 * QuickBooks Online "Bills" import CSV generator (Brief §06). One CSV row per GL
 * line; split parents excluded so amounts reconcile to the invoice total. When
 * an invoice has been split, the rows reflect the split (one per quick-even
 * allocation, or one per per-line-coded line item).
 */
export const QBO_BILLS_HEADER = [
  "Bill No", "Vendor", "Bill Date", "Due Date", "Terms",
  "Account", "Line Description", "Line Amount", "Class", "Memo",
];

export interface ExportInvoice {
  invoice: InvoiceRow;
  lineItems: LineItemRow[];
  allocations?: InvoiceAllocationRow[];
  vendorMapping?: VendorMappingRow | null;
}

function field(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toQboDate(date: string | null): string {
  if (!date) return "";
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : date;
}

function leaves(lineItems: LineItemRow[]): LineItemRow[] {
  const parentIds = new Set(
    lineItems.map((li) => li.split_parent_id).filter((x): x is string => !!x),
  );
  return [...lineItems]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .filter((li) => !parentIds.has(li.id));
}

export function generateQboBillsCsv(invoices: ExportInvoice[]): {
  csv: string;
  rowCount: number;
} {
  const rows = [QBO_BILLS_HEADER.map(field).join(",")];
  let rowCount = 0;
  const memo = (invoice: InvoiceRow) =>
    `InvoiceIQ export — approved by ${invoice.approved_by ?? "—"}`;
  const pushRow = (cols: (string | number | null | undefined)[]) => {
    rows.push(cols.map(field).join(","));
    rowCount++;
  };

  for (const { invoice, lineItems, allocations, vendorMapping } of invoices) {
    // ---- QUICK_EVEN: one row per allocation -----------------------------
    if (allocations && allocations.length > 0) {
      for (const a of allocations) {
        pushRow([
          invoice.invoice_number,
          invoice.vendor,
          toQboDate(invoice.inv_date),
          toQboDate(invoice.due_date),
          "Net 30",
          a.gl_account ?? "",
          `Even split — ${a.class} (${(a.percentage ?? 0)}%)`,
          a.amount.toFixed(2),
          `${a.business}:${a.class}`,
          memo(invoice),
        ]);
      }
      continue;
    }

    // ---- PER_LINE: any line item carries a business/class --------------
    const coded = lineItems.filter((li) => li.business && li.class);
    if (coded.length > 0) {
      for (const li of leaves(coded)) {
        const account =
          li.gl_category ?? resolveGlAccount(vendorMapping, li.gl_category);
        pushRow([
          invoice.invoice_number,
          invoice.vendor,
          toQboDate(invoice.inv_date),
          toQboDate(invoice.due_date),
          "Net 30",
          account,
          li.description ?? "",
          (li.amount ?? 0).toFixed(2),
          li.class && li.class !== "None"
            ? `${li.business}:${li.class}`
            : (li.business ?? ""),
          memo(invoice),
        ]);
      }
      continue;
    }

    // ---- Default: existing behavior unchanged --------------------------
    const leaf = leaves(lineItems);
    const lines =
      leaf.length > 0
        ? leaf
        : [
            {
              description: invoice.vendor,
              amount: invoice.total_amount,
              gl_category: "Miscellaneous",
            } as Partial<LineItemRow>,
          ];
    for (const li of lines) {
      pushRow([
        invoice.invoice_number,
        invoice.vendor,
        toQboDate(invoice.inv_date),
        toQboDate(invoice.due_date),
        "Net 30",
        li.gl_category ?? "",
        li.description ?? "",
        (li.amount ?? 0).toFixed(2),
        invoice.class && invoice.class !== "None"
          ? `${invoice.business}:${invoice.class}`
          : (invoice.business ?? ""),
        memo(invoice),
      ]);
    }
  }
  return { csv: rows.join("\r\n"), rowCount };
}

export function buildExportFilename(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `InvoiceIQ_QBO_Bills_${date.getFullYear()}${p(date.getMonth() + 1)}${p(
    date.getDate(),
  )}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.csv`;
}
