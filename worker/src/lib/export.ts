import type {
  InvoiceRow,
  LineItemRow,
  InvoiceAllocationRow,
  VendorMappingRow,
  QboBillRow,
  EntitySheet,
} from "./types";
import { resolveGlAccount } from "./rules";
import { BUSINESS_ENTITIES, ENTITY_LABEL, ENTITY_CODE } from "./constants";

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

export function toQboDate(date: string | null): string {
  if (!date) return "";
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : date;
}

export function leaves(lineItems: LineItemRow[]): LineItemRow[] {
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
        // When the exec set a per-line Type (item_type), the line's own GL
        // category is authoritative — use it directly so a vendor gl_override
        // can't win. Otherwise vendor mapping (gl_override / inventory) takes
        // precedence with the line's GL category as the fallback.
        const account = li.item_type
          ? (li.gl_category ?? "")
          : resolveGlAccount(vendorMapping, li.gl_category);
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

// ---------------------------------------------------------------------------
// QuickBooks Online "Import Bills" multi-entity factoring (structured JSON)
// ---------------------------------------------------------------------------

/**
 * The exact ordered QBO "Import Bills" column header. QboBillRow objects are
 * keyed by these strings. Do not reorder — the frontend writes the .xlsx in
 * this exact column order.
 */
export const QBO_BILL_HEADER = [
  "*Bill Number",
  "*Vendor",
  "Mailing Address",
  "Terms",
  "*Bill Date",
  "Due Date",
  "Location",
  "Memo",
  "*Type",
  "Category/Account",
  "Product/Service",
  "Quantity",
  "Rate",
  "Description",
  "Amount",
  "Billable",
  "Customer/Project",
  "Tax Rate",
  "Class",
] as const;

/** Display label for a canonical business entity. */
function label(business: string | null | undefined): string {
  const b = business ?? "";
  return ENTITY_LABEL[b] ?? b;
}

/** `label(business):cls` when cls is present and !== "None", else `label(business)`. */
function classCell(business: string | null | undefined, cls: string | null | undefined): string {
  const base = label(business);
  return cls && cls !== "None" ? `${base}:${cls}` : base;
}

/** Builds the .xlsx filename: InvoiceIQ_QBO_BillImport_YYYYMMDD-HHMMSS.xlsx */
export function buildFactorFilename(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `InvoiceIQ_QBO_BillImport_${date.getFullYear()}${p(date.getMonth() + 1)}${p(
    date.getDate(),
  )}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}.xlsx`;
}

/** A single Category-Details line, before it's assembled into a QboBillRow. */
interface FactorLine {
  account: string;
  amount: number;
  description: string;
  /** Business + class drive the QBO Class cell for this line. */
  business: string | null | undefined;
  cls: string | null | undefined;
}

/** A logical bill destined for a single entity's sheet. */
interface FactorBill {
  billNumber: string;
  entity: string; // canonical business entity (sheet owner)
  vendor: string;
  terms: string;
  billDate: string;
  dueDate: string;
  memo: string;
  lines: FactorLine[];
}

/**
 * Turns selected invoices into QuickBooks-Online "Import Bills" rows, grouped
 * into one logical sheet per business entity (Brief: "Factor invoices for bill
 * import"). Mirrors the leaf/split logic of generateQboBillsCsv but emits the
 * richer multi-column, multi-entity QBO bill-import shape as structured JSON.
 */
export function generateQboBillFactor(invoices: ExportInvoice[]): {
  entities: EntitySheet[];
  header: string[];
  totalRowCount: number;
} {
  const memo = (invoice: InvoiceRow) =>
    `InvoiceIQ export — approved by ${invoice.approved_by ?? "—"}`;

  const bills: FactorBill[] = [];

  for (const { invoice, lineItems, allocations, vendorMapping } of invoices) {
    const billBase = {
      vendor: invoice.vendor,
      terms: "Net 30",
      billDate: toQboDate(invoice.inv_date),
      dueDate: toQboDate(invoice.due_date),
      memo: memo(invoice),
    };

    // ---- Allocations (quick-even / custom): group by business, one bill --
    // per distinct business (each on its own sheet). Allocations may span
    // multiple entities (custom cross-entity split), so a single-business
    // split keeps the plain invoice number while a multi-business split
    // appends the entity code to keep each bill number unique in QBO.
    if (allocations && allocations.length > 0) {
      const byBusiness = new Map<string, FactorLine[]>();
      for (const a of allocations) {
        const business = a.business;
        const arr = byBusiness.get(business) ?? [];
        arr.push({
          account: a.gl_account ?? "",
          amount: a.amount,
          description: `Split — ${a.class} (${a.percentage ?? 0}%)`,
          business,
          cls: a.class,
        });
        byBusiness.set(business, arr);
      }
      const multiBusiness = byBusiness.size > 1;
      for (const [business, lines] of byBusiness) {
        bills.push({
          ...billBase,
          billNumber: multiBusiness
            ? `${invoice.invoice_number}-${ENTITY_CODE[business] ?? business}`
            : invoice.invoice_number,
          entity: business,
          lines,
        });
      }
      // Tax already baked into allocation amounts — no extra tax line.
      continue;
    }

    // ---- PER_LINE: one bill per distinct business -----------------------
    const coded = leaves(lineItems).filter((li) => li.business && li.class);
    if (coded.length > 0) {
      const byBusiness = new Map<string, FactorLine[]>();
      for (const li of coded) {
        const business = li.business as string;
        const arr = byBusiness.get(business) ?? [];
        arr.push({
          // When the exec set a per-line Type (item_type), the line's own
          // gl_category is authoritative — use it directly so a vendor
          // gl_override can't win. Otherwise fall back to resolveGlAccount.
          account: li.item_type
            ? (li.gl_category ?? "")
            : resolveGlAccount(vendorMapping, li.gl_category),
          amount: li.amount ?? 0,
          description: li.description ?? "",
          business,
          cls: li.class,
        });
        byBusiness.set(business, arr);
      }
      // Primary entity (first coded line's business) carries any tax line.
      const primary = coded[0].business as string;
      const hasTaxLine = coded.some((li) => li.gl_category === "Sales/Use Tax");
      for (const [business, lines] of byBusiness) {
        if (
          business === primary &&
          (invoice.sales_tax ?? 0) > 0 &&
          !hasTaxLine
        ) {
          lines.push({
            account: "Sales/Use Tax",
            amount: invoice.sales_tax ?? 0,
            description: "Sales/Use Tax",
            business,
            cls: invoice.class,
          });
        }
        bills.push({
          ...billBase,
          billNumber: `${invoice.invoice_number}-${ENTITY_CODE[business] ?? business}`,
          entity: business,
          lines,
        });
      }
      continue;
    }

    // ---- No split: one bill on invoice.business's sheet -----------------
    const leaf = leaves(lineItems);
    const sourceLines =
      leaf.length > 0
        ? leaf.map((li) => ({
            account: resolveGlAccount(vendorMapping, li.gl_category),
            amount: li.amount ?? 0,
            description: li.description ?? "",
            business: invoice.business,
            cls: invoice.class,
          }))
        : [
            {
              account: resolveGlAccount(vendorMapping, "Miscellaneous"),
              amount: invoice.total_amount,
              description: invoice.vendor,
              business: invoice.business,
              cls: invoice.class,
            },
          ];
    const lines: FactorLine[] = [...sourceLines];
    const hasTaxLine = leaf.some((li) => li.gl_category === "Sales/Use Tax");
    if ((invoice.sales_tax ?? 0) > 0 && !hasTaxLine) {
      lines.push({
        account: "Sales/Use Tax",
        amount: invoice.sales_tax ?? 0,
        description: "Sales/Use Tax",
        business: invoice.business,
        cls: invoice.class,
      });
    }
    bills.push({
      ...billBase,
      billNumber: invoice.invoice_number,
      entity: invoice.business ?? "",
      lines,
    });
  }

  // ---- Render bills into per-entity sheets, in canonical entity order ---
  const billsByEntity = new Map<string, FactorBill[]>();
  for (const bill of bills) {
    const arr = billsByEntity.get(bill.entity) ?? [];
    arr.push(bill);
    billsByEntity.set(bill.entity, arr);
  }

  const entities: EntitySheet[] = [];
  let totalRowCount = 0;
  for (const entity of BUSINESS_ENTITIES) {
    const entityBills = billsByEntity.get(entity);
    if (!entityBills || entityBills.length === 0) continue;
    const rows: QboBillRow[] = [];
    for (const bill of entityBills) {
      bill.lines.forEach((line, i) => {
        const first = i === 0;
        const row: QboBillRow = {
          "*Bill Number": bill.billNumber,
          "*Vendor": first ? bill.vendor : "",
          "Mailing Address": "",
          Terms: first ? bill.terms : "",
          "*Bill Date": first ? bill.billDate : "",
          "Due Date": first ? bill.dueDate : "",
          Location: "",
          Memo: bill.memo,
          "*Type": "Category Details",
          "Category/Account": line.account,
          "Product/Service": "",
          Quantity: "",
          Rate: "",
          Description: line.description,
          Amount: line.amount.toFixed(2),
          Billable: "",
          "Customer/Project": "",
          "Tax Rate": "",
          Class: classCell(line.business, line.cls),
        };
        rows.push(row);
        totalRowCount++;
      });
    }
    entities.push({ entity, sheetName: label(entity), rows });
  }

  return { entities, header: [...QBO_BILL_HEADER], totalRowCount };
}
