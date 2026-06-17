import { AwsClient } from "aws4fetch";
import type { Env } from "./types";
import { bufferToBase64 } from "./util";

/**
 * AWS Textract Analyze Expense via aws4fetch (signs requests with WebCrypto, so
 * it runs in a Cloudflare Worker — the full AWS SDK does not). Brief §04/§10.
 */

interface ExpenseField {
  Type?: { Text?: string };
  LabelDetection?: { Text?: string };
  ValueDetection?: { Text?: string };
}

export async function runTextract(
  env: Env,
  pdf: ArrayBuffer,
): Promise<unknown> {
  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION,
    service: "textract",
  });
  const res = await aws.fetch(
    `https://textract.${env.AWS_REGION}.amazonaws.com/`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "Textract.AnalyzeExpense",
      },
      body: JSON.stringify({ Document: { Bytes: bufferToBase64(pdf) } }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Textract error ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export interface TextractSummary {
  vendor: string;
  vendorAddress: string;
  receiverName: string;
  shipToAddress: string;
  receiverAddress: string;
  subtotal: string;
  tax: string;
  total: string;
  invoiceDate: string;
  dueDate: string;
  invoiceNumber: string;
  poNumber: string;
  lineItems: { description: string; amount: string }[];
  otherFields: { label: string; value: string }[];
}

const t = (f: ExpenseField) => (f.Type?.Text ?? "").toUpperCase();
const v = (f: ExpenseField) => (f.ValueDetection?.Text ?? "").trim();
const l = (f: ExpenseField) => (f.LabelDetection?.Text ?? f.Type?.Text ?? "").trim();

export function parseTextract(raw: unknown): TextractSummary {
  const s: TextractSummary = {
    vendor: "", vendorAddress: "", receiverName: "", shipToAddress: "",
    receiverAddress: "", subtotal: "", tax: "", total: "", invoiceDate: "",
    dueDate: "", invoiceNumber: "", poNumber: "", lineItems: [], otherFields: [],
  };
  const doc = (raw as { ExpenseDocuments?: unknown[] })?.ExpenseDocuments?.[0] as
    | { SummaryFields?: ExpenseField[]; LineItemGroups?: { LineItems?: { LineItemExpenseFields?: ExpenseField[] }[] }[] }
    | undefined;
  if (!doc) return s;

  const set = (k: keyof TextractSummary, val: string) => {
    if (val) (s as unknown as Record<string, unknown>)[k] = val;
  };

  for (const f of doc.SummaryFields ?? []) {
    const val = v(f);
    if (!val) continue;
    switch (t(f)) {
      case "VENDOR_NAME":
      case "NAME": if (!s.vendor) set("vendor", val); break;
      case "VENDOR_ADDRESS": set("vendorAddress", val); break;
      case "RECEIVER_NAME": set("receiverName", val); break;
      case "RECEIVER_ADDRESS": set("receiverAddress", val); break;
      case "SHIP_TO_ADDRESS": set("shipToAddress", val); break;
      case "SUBTOTAL": set("subtotal", val); break;
      case "TAX": set("tax", val); break;
      case "TOTAL":
      case "AMOUNT_DUE": if (!s.total) set("total", val); break;
      case "INVOICE_RECEIPT_DATE": set("invoiceDate", val); break;
      case "DUE_DATE": set("dueDate", val); break;
      case "INVOICE_RECEIPT_ID": set("invoiceNumber", val); break;
      case "PO_NUMBER": set("poNumber", val); break;
      default: s.otherFields.push({ label: l(f), value: val });
    }
  }
  if (!s.shipToAddress) s.shipToAddress = s.receiverAddress;

  for (const group of doc.LineItemGroups ?? []) {
    for (const li of group.LineItems ?? []) {
      let description = "";
      let amount = "";
      for (const f of li.LineItemExpenseFields ?? []) {
        const val = v(f);
        if (!val) continue;
        switch (t(f)) {
          case "ITEM":
          case "DESCRIPTION":
            description = description ? `${description} ${val}` : val;
            break;
          case "PRICE":
          case "AMOUNT":
            amount = val;
            break;
        }
      }
      if (description || amount) s.lineItems.push({ description, amount });
    }
  }
  return s;
}

/** Clean labeled text for the Claude prompts (never raw PDF — Brief §05). */
export function formatForClaude(s: TextractSummary): string {
  const lines: string[] = [
    "=== INVOICE HEADER (from AWS Textract Analyze Expense) ===",
    `Vendor Name: ${s.vendor || "(not detected)"}`,
    `Vendor Address: ${s.vendorAddress || "(not detected)"}`,
    `Receiver/Bill-To Name: ${s.receiverName || "(not detected)"}`,
    `Receiver/Bill-To Address: ${s.receiverAddress || "(not detected)"}`,
    `Ship-To / Delivery Address: ${s.shipToAddress || "(not detected)"}`,
    `Invoice Number: ${s.invoiceNumber || "(not detected)"}`,
    `PO Number: ${s.poNumber || "(not detected)"}`,
    `Invoice Date: ${s.invoiceDate || "(not detected)"}`,
    `Due Date: ${s.dueDate || "(not detected)"}`,
    `Subtotal: ${s.subtotal || "(not detected)"}`,
    `Sales Tax: ${s.tax || "(not detected)"}`,
    `Total Amount Due: ${s.total || "(not detected)"}`,
  ];
  if (s.otherFields.length) {
    lines.push("", "=== OTHER LABELED FIELDS ===");
    for (const f of s.otherFields) lines.push(`${f.label || "Field"}: ${f.value}`);
  }
  lines.push("", "=== LINE ITEMS ===");
  if (s.lineItems.length === 0) {
    lines.push("(no line items detected — treat the total as a single line)");
  } else {
    s.lineItems.forEach((li, i) =>
      lines.push(`${i + 1}. ${li.description || "(no description)"}  |  amount=${li.amount || "?"}`),
    );
  }
  return lines.join("\n");
}
