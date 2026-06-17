import {
  TextractClient,
  AnalyzeExpenseCommand,
  type AnalyzeExpenseCommandOutput,
  type ExpenseField,
} from "@aws-sdk/client-textract";

/**
 * AWS Textract — Analyze Expense API integration (Brief §04 step 3, §10).
 *
 * analyzeExpense() returns structured invoice JSON (vendor, totals, line items,
 * dates, addresses already labeled). We keep the raw response for the audit
 * trail (stored in invoices.textract_raw) AND produce a clean labeled-text
 * rendering that is what the three Claude prompts actually consume — never raw
 * PDF text (Brief §05 implementation note).
 */

let _client: TextractClient | null = null;

function getClient(): TextractClient {
  if (!_client) {
    _client = new TextractClient({ region: process.env.AWS_REGION });
  }
  return _client;
}

/** Calls Textract analyzeExpense() on a PDF buffer. ~2-5 sec per page. */
export async function runTextract(
  pdfBuffer: Buffer,
): Promise<AnalyzeExpenseCommandOutput> {
  const command = new AnalyzeExpenseCommand({
    Document: { Bytes: pdfBuffer },
  });
  return getClient().send(command);
}

export interface TextractLineItem {
  description: string;
  amount: string;
  quantity?: string;
  unitPrice?: string;
  productCode?: string;
}

export interface TextractSummary {
  vendor: string;
  vendorAddress: string;
  receiverName: string;
  /** Ship-to / delivery address — used by Prompt 2 ShipTo tie-breaker. */
  shipToAddress: string;
  receiverAddress: string;
  subtotal: string;
  tax: string;
  total: string;
  invoiceDate: string;
  dueDate: string;
  invoiceNumber: string;
  poNumber: string;
  lineItems: TextractLineItem[];
  /** All raw summary label/value pairs, for completeness in the prompt. */
  otherFields: { label: string; value: string }[];
}

function fieldType(f: ExpenseField): string {
  return (f.Type?.Text ?? "").toUpperCase();
}
function fieldValue(f: ExpenseField): string {
  return (f.ValueDetection?.Text ?? "").trim();
}
function fieldLabel(f: ExpenseField): string {
  return (f.LabelDetection?.Text ?? f.Type?.Text ?? "").trim();
}

/**
 * Extracts a normalized {@link TextractSummary} from the raw Textract output.
 * Reads the first ExpenseDocument; multi-page invoices are merged by Textract
 * into a single document.
 */
export function parseTextract(
  response: AnalyzeExpenseCommandOutput,
): TextractSummary {
  const doc = response.ExpenseDocuments?.[0];
  const summary: TextractSummary = {
    vendor: "",
    vendorAddress: "",
    receiverName: "",
    shipToAddress: "",
    receiverAddress: "",
    subtotal: "",
    tax: "",
    total: "",
    invoiceDate: "",
    dueDate: "",
    invoiceNumber: "",
    poNumber: "",
    lineItems: [],
    otherFields: [],
  };
  if (!doc) return summary;

  const set = (key: keyof TextractSummary, value: string) => {
    if (value) (summary as unknown as Record<string, unknown>)[key] = value;
  };

  for (const f of doc.SummaryFields ?? []) {
    const type = fieldType(f);
    const value = fieldValue(f);
    if (!value) continue;
    switch (type) {
      case "VENDOR_NAME":
      case "NAME":
        if (!summary.vendor) set("vendor", value);
        break;
      case "VENDOR_ADDRESS":
        set("vendorAddress", value);
        break;
      case "RECEIVER_NAME":
        set("receiverName", value);
        break;
      case "RECEIVER_ADDRESS":
        set("receiverAddress", value);
        break;
      case "SHIP_TO_ADDRESS":
        set("shipToAddress", value);
        break;
      case "SUBTOTAL":
        set("subtotal", value);
        break;
      case "TAX":
        set("tax", value);
        break;
      case "TOTAL":
      case "AMOUNT_DUE":
        if (!summary.total) set("total", value);
        break;
      case "INVOICE_RECEIPT_DATE":
        set("invoiceDate", value);
        break;
      case "DUE_DATE":
        set("dueDate", value);
        break;
      case "INVOICE_RECEIPT_ID":
        set("invoiceNumber", value);
        break;
      case "PO_NUMBER":
        set("poNumber", value);
        break;
      default:
        summary.otherFields.push({ label: fieldLabel(f), value });
    }
  }

  // If no explicit SHIP_TO_ADDRESS, fall back to receiver address (Prompt 2
  // uses ship-to as a tie-breaker, and many invoices only carry a single
  // delivery address).
  if (!summary.shipToAddress) {
    summary.shipToAddress = summary.receiverAddress;
  }

  for (const group of doc.LineItemGroups ?? []) {
    for (const li of group.LineItems ?? []) {
      const item: TextractLineItem = { description: "", amount: "" };
      for (const f of li.LineItemExpenseFields ?? []) {
        const type = fieldType(f);
        const value = fieldValue(f);
        if (!value) continue;
        switch (type) {
          case "ITEM":
          case "DESCRIPTION":
            item.description = item.description
              ? `${item.description} ${value}`
              : value;
            break;
          case "PRICE":
          case "AMOUNT":
            item.amount = value;
            break;
          case "QUANTITY":
            item.quantity = value;
            break;
          case "UNIT_PRICE":
            item.unitPrice = value;
            break;
          case "PRODUCT_CODE":
            item.productCode = value;
            break;
        }
      }
      if (item.description || item.amount) summary.lineItems.push(item);
    }
  }

  return summary;
}

/**
 * Renders the parsed Textract summary as clean, labeled text for the Claude
 * prompts. This is the single shared context passed to Prompt 1, 2 and 3.
 */
export function formatForClaude(summary: TextractSummary): string {
  const lines: string[] = [];
  lines.push("=== INVOICE HEADER (from AWS Textract Analyze Expense) ===");
  lines.push(`Vendor Name: ${summary.vendor || "(not detected)"}`);
  lines.push(`Vendor Address: ${summary.vendorAddress || "(not detected)"}`);
  lines.push(`Receiver/Bill-To Name: ${summary.receiverName || "(not detected)"}`);
  lines.push(`Receiver/Bill-To Address: ${summary.receiverAddress || "(not detected)"}`);
  lines.push(`Ship-To / Delivery Address: ${summary.shipToAddress || "(not detected)"}`);
  lines.push(`Invoice Number: ${summary.invoiceNumber || "(not detected)"}`);
  lines.push(`PO Number: ${summary.poNumber || "(not detected)"}`);
  lines.push(`Invoice Date: ${summary.invoiceDate || "(not detected)"}`);
  lines.push(`Due Date: ${summary.dueDate || "(not detected)"}`);
  lines.push(`Subtotal: ${summary.subtotal || "(not detected)"}`);
  lines.push(`Sales Tax: ${summary.tax || "(not detected)"}`);
  lines.push(`Total Amount Due: ${summary.total || "(not detected)"}`);

  if (summary.otherFields.length) {
    lines.push("");
    lines.push("=== OTHER LABELED FIELDS ===");
    for (const { label, value } of summary.otherFields) {
      lines.push(`${label || "Field"}: ${value}`);
    }
  }

  lines.push("");
  lines.push("=== LINE ITEMS ===");
  if (summary.lineItems.length === 0) {
    lines.push("(no line items detected — treat the total as a single line)");
  } else {
    summary.lineItems.forEach((li, i) => {
      const parts = [`${i + 1}. ${li.description || "(no description)"}`];
      if (li.quantity) parts.push(`qty=${li.quantity}`);
      if (li.unitPrice) parts.push(`unit=${li.unitPrice}`);
      parts.push(`amount=${li.amount || "?"}`);
      if (li.productCode) parts.push(`code=${li.productCode}`);
      lines.push(parts.join("  |  "));
    });
  }

  return lines.join("\n");
}
