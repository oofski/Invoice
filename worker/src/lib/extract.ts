import type { Env } from "./types";
import { runExtract } from "./reducto";
import { GL_CATEGORIES_FLAT, REQUIRES_MANUAL_REVIEW } from "./constants";
import { parseAmount } from "./util";

/**
 * Structured invoice extraction with Reducto /extract — replaces the Claude
 * extraction prompt. Reducto returns the header fields plus EVERY line item
 * (array_extract), and a best-effort `suggested_category` per line that the
 * deterministic rules engine (lib/rules.ts) may keep, override, or discard.
 */

export interface ExtractedLineItem {
  description: string;
  amount: number | null;
  suggested_category?: string;
}

export interface ExtractedInvoice {
  vendor: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  subtotal: number | null;
  sales_tax: number | null;
  total: number | null;
  ship_to_address: string;
  line_items: ExtractedLineItem[];
}

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: "string", description: "The vendor / supplier company name on the invoice." },
    invoice_number: { type: "string", description: "The invoice number / ID." },
    invoice_date: { type: "string", description: "Invoice date, formatted MM/DD/YYYY." },
    due_date: { type: "string", description: "Payment due date MM/DD/YYYY; same as invoice_date if not present." },
    subtotal: { type: "number", description: "Subtotal before tax." },
    sales_tax: { type: "number", description: "Sales/use tax amount; 0 if none." },
    total: { type: "number", description: "Grand total amount due." },
    ship_to_address: {
      type: "string",
      description: "The ship-to / delivery address. If absent, the bill-to / receiver address.",
    },
    line_items: {
      type: "array",
      description: "One object per invoice line item. If the invoice has no itemized lines, return a single item for the total.",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "The line item description text." },
          amount: { type: "number", description: "The extended line amount (qty x price)." },
          suggested_category: {
            type: "string",
            enum: [...GL_CATEGORIES_FLAT, REQUIRES_MANUAL_REVIEW],
            description: "Best-fit GL category from the allowed list; use REQUIRES_MANUAL_REVIEW if unsure.",
          },
        },
        required: ["description", "amount"],
      },
    },
  },
  required: ["vendor", "total", "line_items"],
};

const SYSTEM_PROMPT = `You are an accounts-payable extraction engine for a multi-entity salon & wellness business. Extract the invoice header fields and EVERY line item.
For each line item's suggested_category, pick the single best GL category from the allowed enum using these hints: a "sales tax"/"use tax" line => "Sales/Use Tax"; "cleaning" => "Repairs & Maintenance"; "rent" => "Occupancy - Rent"; "freight"/"shipping" => "Freight"; "software"/"IT"/"subscription" => "Computer & IT". If you are not confident, use "${REQUIRES_MANUAL_REVIEW}".
Money values are numbers. Dates are MM/DD/YYYY. If the invoice has no itemized lines, return one line item whose amount is the total.`;

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseAmount(String(v));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v.trim() : String(v);
}

/** Coerces Reducto's structured output into a stable ExtractedInvoice. */
export function normalizeExtract(data: unknown): ExtractedInvoice {
  const d = (data ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(d.line_items) ? d.line_items : [];
  const line_items: ExtractedLineItem[] = rawItems
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return {
        description: str(o.description),
        amount: num(o.amount),
        suggested_category: o.suggested_category ? str(o.suggested_category) : undefined,
      };
    })
    .filter((li) => li.description || li.amount != null);

  const total = num(d.total);
  // Fall back to a single line for the total if no itemized lines came back.
  if (line_items.length === 0) {
    line_items.push({
      description: str(d.vendor) || "Invoice total",
      amount: total,
      suggested_category: undefined,
    });
  }

  return {
    vendor: str(d.vendor),
    invoice_number: str(d.invoice_number),
    invoice_date: str(d.invoice_date),
    due_date: str(d.due_date) || str(d.invoice_date),
    subtotal: num(d.subtotal),
    sales_tax: num(d.sales_tax) ?? 0,
    total,
    ship_to_address: str(d.ship_to_address),
    line_items,
  };
}

/** Runs Reducto /extract for an uploaded document and returns the raw + normalized data. */
export async function extractInvoice(
  env: Env,
  documentUrl: string,
): Promise<{ raw: unknown; data: ExtractedInvoice }> {
  const { raw, data } = await runExtract(env, documentUrl, {
    schema: INVOICE_SCHEMA,
    systemPrompt: SYSTEM_PROMPT,
    arrayExtract: true,
  });
  return { raw, data: normalizeExtract(data) };
}
