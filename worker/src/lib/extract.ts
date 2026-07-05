import type { Env } from "./types";
import { runExtract, MIN_CONFIDENCE_KEY } from "./reducto";
import { GL_CATEGORIES_FLAT, REQUIRES_MANUAL_REVIEW } from "./constants";
import { parseAmount } from "./util";

/**
 * Light confidence gating threshold (v1.1.8 P). A line whose Reducto citation
 * min-confidence is clearly below this is flagged for review. Conservative — only
 * a present, numeric confidence below the bar flags; absent confidence never does.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

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
  /**
   * Optional per-line sales/use tax amount (Group B v1.1.4). Used by the
   * retail-vs-backbar differentiation (B2) when present; if Reducto returns
   * nothing it stays null/undefined and the logic falls back to header-level tax.
   */
  tax?: number | null;
  /**
   * Optional per-line quantity / unit price (v1.1.8). Captured for cross-check
   * only (qty x unit_price ≈ amount) — NOT required and NOT yet rule-bearing.
   */
  quantity?: number | null;
  unit_price?: number | null;
  /**
   * Light confidence gating (v1.1.8 P). True when Reducto citations report a
   * clearly-low min confidence (< LOW_CONFIDENCE_THRESHOLD) across this line's
   * fields, so the pipeline flags the line for review. Absent/false when no
   * numeric confidence is present (degrades to default — never a false flag).
   */
  lowConfidence?: boolean;
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
  /**
   * Header shipping/freight/handling charge from the totals block (v1.6.0 FIX-9);
   * null/0 when absent or when freight is already an itemized line. The pipeline
   * synthesizes a coded "Shipping & Handling" Freight line from this.
   */
  shipping: number | null;
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
    shipping: {
      type: "number",
      description:
        "Shipping/freight/delivery charge from the totals block; 0 if none. Do NOT include if already itemized as a line item.",
    },
    ship_to_address: {
      type: "string",
      description: "The ship-to / delivery address. If absent, the bill-to / receiver address.",
    },
    line_items: {
      type: "array",
      description:
        "Return ONE object per visible line on EVERY page; never merge, summarize, or skip lines. " +
        "Capture discount, credit, rebate, refund, and adjustment lines as their OWN separate line items — " +
        "a discount/credit is a NEGATIVE amount (values shown in parentheses (10.00), with a trailing CR, or a leading minus are negative); " +
        "never drop or net them into another line. " +
        "Invoices may span multiple pages and line-item tables can continue across page breaks — extract every row on every page. " +
        "If the invoice has no itemized lines, return a single item for the total.",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "The line item description text." },
          amount: {
            type: "number",
            description:
              "The extended line amount (qty x price). NEGATIVE for discounts, credits, rebates, refunds, and adjustments " +
              "(parentheses, trailing CR, or a leading minus indicate a negative).",
          },
          suggested_category: {
            type: "string",
            enum: [...GL_CATEGORIES_FLAT, REQUIRES_MANUAL_REVIEW],
            description: "Best-fit GL category from the allowed list; use REQUIRES_MANUAL_REVIEW if unsure.",
          },
          tax: {
            type: "number",
            description: "Sales/use tax charged on THIS line only, if itemized per line; 0 if this line is untaxed. Omit if tax is not broken out per line.",
          },
          quantity: {
            type: "number",
            description: "Optional: the line quantity, for cross-check only. Omit if not shown.",
          },
          unit_price: {
            type: "number",
            description: "Optional: the per-unit price, for cross-check only. Omit if not shown.",
          },
        },
        required: ["description", "amount"],
      },
    },
  },
  required: ["vendor", "total", "line_items"],
};

const SYSTEM_PROMPT = `You are an accounts-payable extraction engine for a multi-entity salon & wellness business. Extract the invoice header fields and EVERY line item.
Return ONE object per visible line on EVERY page; never merge, summarize, or skip lines. Invoices may span multiple pages and line-item tables can continue across page breaks — extract every row on every page.
Capture discount, credit, rebate, refund, and adjustment lines as their OWN separate line items. A discount/credit is a NEGATIVE amount — values in parentheses (10.00), with a trailing CR, or a leading minus are negative; never drop or net them into another line.
For each line item's suggested_category, pick the single best GL category from the allowed enum using these hints: a "sales tax"/"use tax" line => "Sales/Use Tax"; "cleaning" => "Repairs & Maintenance"; "rent" => "Occupancy - Rent"; "freight"/"shipping" => "Freight"; "software"/"IT"/"subscription" => "Computer & IT". If you are not confident, use "${REQUIRES_MANUAL_REVIEW}".
Money values are numbers. Dates are MM/DD/YYYY. quantity and unit_price are OPTIONAL (capture only when shown). If the invoice has no itemized lines, return one line item whose amount is the total.
Capture any shipping/freight/handling charge from the totals block in the \`shipping\` field (0 if none); if freight appears as its own line item, keep it a line item and omit the header field.`;

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
      const amount = num(o.amount);
      const rawDescription = str(o.description);
      const quantity = num(o.quantity);
      const unit_price = num(o.unit_price);
      // E3 (v1.6.0 FIX-7): a line with an amount but no description is surfaced
      // as "(no description)" — and flagged so a reviewer notices it.
      const noDescription = !rawDescription && amount != null;
      const description = rawDescription || (amount != null ? "(no description)" : "");
      // E4 (v1.6.0 FIX-7): cross-check qty x unit_price against the extended
      // amount. Only fires when all three are present; tolerance = the larger of
      // 5c or 1% of the amount, so trivial rounding never flags.
      const qtyMismatch =
        quantity != null &&
        unit_price != null &&
        amount != null &&
        Math.abs(quantity * unit_price - amount) > Math.max(0.05, 0.01 * Math.abs(amount));
      // Light confidence gating (v1.1.8 P): unwrapCitations stamped the per-line
      // min citation confidence. Flag ONLY when a clearly-numeric confidence is
      // present and below threshold; absent confidence => no flag (default).
      const minConf = o[MIN_CONFIDENCE_KEY];
      const lowConfidence =
        o.lowConfidence === true || // R1 (v1.6.0 FIX-7): respect a flag stored on a normalized line
        (typeof minConf === "number" && minConf < LOW_CONFIDENCE_THRESHOLD) ||
        noDescription || // E3
        qtyMismatch; // E4
      return {
        description,
        amount,
        suggested_category: o.suggested_category ? str(o.suggested_category) : undefined,
        tax: num(o.tax),
        quantity,
        unit_price,
        ...(lowConfidence ? { lowConfidence: true } : {}),
      };
    })
    .filter((li) => li.description || li.amount != null);

  const total = num(d.total);
  // Fall back to a single line for the total if no itemized lines came back.
  // E2 (v1.6.0 FIX-7): this synthetic total line is flagged — the whole
  // tax-and-freight-inclusive amount coded to one account must be reviewed.
  if (line_items.length === 0) {
    line_items.push({
      description: str(d.vendor) || "Invoice total",
      amount: total,
      suggested_category: undefined,
      tax: null,
      quantity: null,
      unit_price: null,
      lowConfidence: true,
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
    shipping: num(d.shipping),
    ship_to_address: str(d.ship_to_address),
    line_items,
  };
}

// v1.2.0: the reconciliation guard (reconcile / reconcileAmounts — the synthetic
// "⚠ Extraction incomplete" review line emitted when lines + tax ≠ invoice total)
// was REMOVED by request. The app no longer flags total mismatches; extraction
// runs at highest fidelity and the accountant can add a missed line manually.

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
