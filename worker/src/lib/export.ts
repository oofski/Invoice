import type {
  InvoiceRow,
  LineItemRow,
  InvoiceAllocationRow,
  VendorMappingRow,
  QboBillRow,
  EntitySheet,
} from "./types";
import { resolveGlAccount } from "./rules";
import {
  BUSINESS_ENTITIES,
  ENTITY_LABEL,
  ENTITY_CODE,
  glAccountNumber,
} from "./constants";

/**
 * Formats a QBO `Category/Account` cell as "<number> <name>" when this entity's
 * COA resolves the category to a real account number (e.g. "6239 Marketing").
 * Falls back to the bare category name when the number is empty, "Varies", or
 * "None" — never throws on those sentinels. `account` is the canonical GL
 * category NAME (the value `resolveGlAccount` returns).
 */
export function formatCategoryAccount(
  business: string | null | undefined,
  account: string,
): string {
  const num = glAccountNumber(business, account);
  if (num && num !== "Varies" && num !== "None") return `${num} ${account}`;
  return account;
}

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

export function field(value: string | number | null | undefined): string {
  if (value == null) return "";
  const isNumber = typeof value === "number";
  let s = String(value);
  // CSV formula-injection guard (v1.9.11 — L6): a TEXT cell beginning with
  // = + - @ (or a leading tab/CR) is evaluated as a formula by Excel/Sheets.
  // Neutralize by prefixing a single quote. Numbers pass through untouched so a
  // real negative amount (-5.00) is not mangled.
  if (!isNumber && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
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

const round2 = (n: number): number => Math.round((n || 0) * 100) / 100;

/**
 * The taxable BASE of a PER_LINE entity bucket: the summed amount of its typed,
 * non-Retail, non-Discounts, non-negative lines. Retail is exempt and negatives
 * / discounts are never taxed (v1.1.8 H). Used as the weight when apportioning
 * the invoice's real sales tax across split buckets.
 */
function bucketTaxableBase(
  lines: Pick<LineItemRow, "amount" | "item_type" | "gl_category">[],
): number {
  let b = 0;
  for (const li of lines) {
    const taxable =
      !!li.item_type &&
      li.item_type !== "Retail" &&
      li.gl_category !== "Discounts" &&
      (li.amount ?? 0) >= 0;
    if (taxable) b += li.amount ?? 0;
  }
  return b;
}

/**
 * Apportions the invoice's ACTUAL sales tax across the PER_LINE entity buckets
 * (v1.8.9) so the exported bills reconcile to the invoice total — instead of
 * recomputing tax from each location's rate (which could drift from the real
 * total). Weight = each bucket's taxable base (falling back to its coded amount
 * when no line is strictly taxable); the LAST bucket absorbs the rounding
 * remainder so the parts sum to `invoiceTax` EXACTLY. Returns a business->tax
 * map (0 for every bucket when the invoice has no tax). The caller skips this
 * entirely when tax is already itemized as its own coded line (no double-tax).
 */
function apportionInvoiceTax(
  buckets: [string, LineItemRow[]][],
  invoiceTax: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [b] of buckets) out.set(b, 0);
  const tax = round2(invoiceTax);
  if (tax <= 0 || buckets.length === 0) return out;
  let weights = buckets.map(([, lines]) => bucketTaxableBase(lines));
  let total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    // No strictly-taxable line (e.g. all-retail): weight by coded amount so the
    // tax still lands somewhere and the totals reconcile.
    weights = buckets.map(([, lines]) =>
      Math.max(0, lines.reduce((s, li) => s + (li.amount ?? 0), 0)),
    );
    total = weights.reduce((a, b) => a + b, 0);
  }
  if (total <= 0) return out;
  let allocated = 0;
  buckets.forEach(([b], i) => {
    const t =
      i === buckets.length - 1
        ? round2(tax - allocated)
        : round2(tax * (weights[i] / total));
    if (i < buckets.length - 1) allocated = round2(allocated + t);
    out.set(b, t);
  });
  return out;
}

/**
 * Splits the invoice's ACTUAL sales tax across the (entity, location) buckets of
 * a PER_LINE split (v1.8.9) — so each location carries its own share and the
 * parts sum to the real tax EXACTLY (last bucket absorbs the rounding cent).
 * Your example: $15 tax across five Neroli locations → $3 on each location.
 * Returns one entry per taxed (business, class), in first-appearance order.
 * Empty when the invoice has no tax OR tax is itemized as its own coded line
 * (then it is already in the base rows — apportioning again would double it).
 */
export function splitTaxByLocation(
  coded: LineItemRow[],
  invoiceTax: number,
): { business: string; cls: string; tax: number }[] {
  if (coded.some((li) => li.gl_category === "Sales/Use Tax")) return [];
  const buckets = new Map<string, LineItemRow[]>();
  const meta = new Map<string, { business: string; cls: string }>();
  for (const li of coded) {
    const key = JSON.stringify([li.business, li.class]);
    const arr = buckets.get(key) ?? [];
    arr.push(li);
    buckets.set(key, arr);
    if (!meta.has(key))
      meta.set(key, { business: li.business as string, cls: li.class as string });
  }
  const taxByKey = apportionInvoiceTax([...buckets.entries()], invoiceTax);
  const out: { business: string; cls: string; tax: number }[] = [];
  for (const key of buckets.keys()) {
    const t = taxByKey.get(key) ?? 0;
    const m = meta.get(key);
    if (t > 0 && m) out.push({ business: m.business, cls: m.cls, tax: t });
  }
  return out;
}

/**
 * Uncoded leaf lines that would be silently DROPPED from a PER_LINE split
 * export (v1.8.9): a leaf with a non-zero amount but no entity/location coding,
 * present when OTHER leaves ARE coded (which is what flips the invoice into the
 * per-line export path). This is a precise signal — it never compares against
 * the OCR'd invoice total — so a line OCR simply missed can't false-positive.
 */
export function droppedSplitLines(lineItems: LineItemRow[]): {
  count: number;
  amount: number;
} {
  const all = leaves(lineItems);
  const coded = all.filter((li) => li.business && li.class);
  if (coded.length === 0) return { count: 0, amount: 0 };
  const dropped = all.filter(
    (li) => !(li.business && li.class) && round2(li.amount ?? 0) !== 0,
  );
  return {
    count: dropped.length,
    amount: round2(dropped.reduce((s, li) => s + (li.amount ?? 0), 0)),
  };
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
          formatCategoryAccount(a.business, a.gl_account ?? ""),
          `Even split — ${a.class} (${(a.percentage ?? 0)}%)`,
          a.amount.toFixed(2),
          `${a.business}:${a.class}`,
          memo(invoice),
        ]);
      }
      continue;
    }

    // ---- PER_LINE: any line item carries a business/class --------------
    const coded = leaves(lineItems).filter((li) => li.business && li.class);
    if (coded.length > 0) {
      // Group coded leaves into per-entity buckets, preserving line order.
      const byBusiness = new Map<string, LineItemRow[]>();
      for (const li of coded) {
        const business = li.business as string;
        const arr = byBusiness.get(business) ?? [];
        arr.push(li);
        byBusiness.set(business, arr);
      }
      const bucketList = [...byBusiness.entries()];
      // Tax (v1.8.9): apportion the invoice's ACTUAL sales tax across each
      // (entity, location) so it splits per location and the parts sum to the
      // real tax exactly — instead of recomputing it from location rates (which
      // could drift from the invoice total).
      const perLocTax = splitTaxByLocation(coded, invoice.sales_tax ?? 0);
      for (const [business, bucket] of bucketList) {
        for (const li of bucket) {
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
            formatCategoryAccount(li.business, account),
            li.description ?? "",
            (li.amount ?? 0).toFixed(2),
            li.class && li.class !== "None"
              ? `${li.business}:${li.class}`
              : (li.business ?? ""),
            memo(invoice),
          ]);
        }
        // One Sales/Use Tax row per location in THIS entity (its share of the
        // invoice's real tax).
        for (const t of perLocTax) {
          if (t.business !== business) continue;
          pushRow([
            invoice.invoice_number,
            invoice.vendor,
            toQboDate(invoice.inv_date),
            toQboDate(invoice.due_date),
            "Net 30",
            formatCategoryAccount(business, "Sales/Use Tax"),
            "Sales/Use Tax (split)",
            t.tax.toFixed(2),
            t.cls && t.cls !== "None" ? `${business}:${t.cls}` : business,
            memo(invoice),
          ]);
        }
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
        formatCategoryAccount(invoice.business, li.gl_category ?? ""),
        li.description ?? "",
        (li.amount ?? 0).toFixed(2),
        invoice.class && invoice.class !== "None"
          ? `${invoice.business}:${invoice.class}`
          : (invoice.business ?? ""),
        memo(invoice),
      ]);
    }
    // v1.9.7 (bug #5): sales tax is a header value, not a leaf line, so the rows
    // above foot to (total − tax) and the imported bill was short by the tax.
    // Emit a Sales/Use Tax line — mirroring the factor path and the PER_LINE CSV
    // branch. Guard on real leaves (the total_amount fallback already includes
    // tax) and skip when tax is already itemized as a leaf.
    const hasTaxLine = leaf.some((li) => li.gl_category === "Sales/Use Tax");
    if (leaf.length > 0 && (invoice.sales_tax ?? 0) > 0 && !hasTaxLine) {
      pushRow([
        invoice.invoice_number,
        invoice.vendor,
        toQboDate(invoice.inv_date),
        toQboDate(invoice.due_date),
        "Net 30",
        formatCategoryAccount(invoice.business, "Sales/Use Tax"),
        "Sales/Use Tax",
        (invoice.sales_tax ?? 0).toFixed(2),
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

/**
 * Factor Class cell = the bare LOCATION only (the entity is already the tab and
 * the footer row). `Mequon`, `Madison`, etc.; Admin / "None" / empty → "".
 * The CSV path keeps its own `Entity:Class` formatting inline — unchanged.
 */
function classCellFactor(cls: string | null | undefined): string {
  return cls && cls !== "None" ? cls : "";
}

/**
 * Strips a trailing legal suffix (and a trailing comma) from a vendor name for
 * the factor export's display cell. Case-insensitive; only removes from the END;
 * never touches the core of the name. Iterates so "Foo Inc, LLC" → "Foo".
 * Preserves the original casing of the kept part. Does NOT fix spelling
 * (e.g. "Olivia Garden" stays "Olivia Garden"). Factor-only — does NOT touch
 * `normalizeVendor` (rules.ts) used for matching.
 */
const VENDOR_SUFFIXES = new Set([
  "INC", // also INC. / INCORPORATED
  "INCORPORATED",
  "LLC", // also L.L.C. (dots stripped before lookup)
  "CORP", // also CORP. / CORPORATION
  "CORPORATION",
  "CO", // also CO. / COMPANY
  "COMPANY",
  "LTD", // also LTD. / LIMITED
  "LIMITED",
  "LP", // also L.P.
  "LLP",
  "PLLC",
  "PC", // also P.C.
]);

export function cleanVendorName(vendor: string | null | undefined): string {
  const original = (vendor ?? "").trim();
  let v = original;
  let changed = true;
  while (changed) {
    changed = false;
    // Final whitespace/comma-delimited token of letters and dots, optional
    // trailing period/comma/space.
    const m = v.match(/[\s,]+([A-Za-z.]+)\.?\s*$/);
    if (m && m.index !== undefined) {
      const token = m[1].replace(/\./g, "").toUpperCase();
      if (VENDOR_SUFFIXES.has(token)) {
        v = v.slice(0, m.index).replace(/[\s,]+$/, "").trim();
        changed = true;
      }
    }
  }
  return v || original;
}

/**
 * Factor `Category/Account` cell = the bare GL category NAME, WITHOUT the
 * leading GL number (QBO matches the account by name). The stored value is
 * already the bare name. Factor-only so the CSV export's numbered-account
 * contract (`formatCategoryAccount`) doesn't drift.
 */
function formatCategoryAccountName(account: string): string {
  return account;
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
      vendor: cleanVendorName(invoice.vendor),
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
      // Keep the source coded leaves per bucket so each bucket can recompute
      // its OWN purchase tax (v1.1.6 Feature 2), alongside the FactorLine list.
      const byBusiness = new Map<string, FactorLine[]>();
      const codedByBusiness = new Map<string, LineItemRow[]>();
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
        const src = codedByBusiness.get(business) ?? [];
        src.push(li);
        codedByBusiness.set(business, src);
      }
      // Tax (v1.8.9): apportion the invoice's ACTUAL sales tax across each
      // (entity, location) so it splits per location and reconciles to the
      // invoice total (was: recomputed per-location rate, which could drift).
      const perLocTax = splitTaxByLocation(coded, invoice.sales_tax ?? 0);
      for (const [business, lines] of byBusiness) {
        for (const t of perLocTax) {
          if (t.business !== business) continue;
          lines.push({
            account: "Sales/Use Tax",
            amount: t.tax,
            description: "Sales/Use Tax (split)",
            business,
            cls: t.cls,
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
          "Category/Account": formatCategoryAccountName(line.account),
          "Product/Service": "",
          Quantity: "",
          Rate: "",
          Description: line.description,
          Amount: line.amount.toFixed(2),
          Billable: "",
          "Customer/Project": "",
          "Tax Rate": "",
          Class: classCellFactor(line.cls),
        };
        rows.push(row);
        totalRowCount++;
      });
    }
    entities.push({ entity, sheetName: label(entity), rows });
  }

  return { entities, header: [...QBO_BILL_HEADER], totalRowCount };
}
