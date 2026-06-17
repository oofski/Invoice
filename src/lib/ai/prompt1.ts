import { callClaudeJSON } from "./anthropic";
import type { Prompt1Output } from "@/lib/types";
import { LOCATION_DICTIONARY } from "@/lib/constants";

/**
 * Prompt 1 — Extraction + Business Routing (Brief §05).
 *
 * Extracts all header fields and matches the delivery address / keywords to the
 * correct business entity, class, and first-pass approver using the location
 * dictionary. Its ApprovedBy is a FIRST PASS only — Prompt 2 always overrides
 * it (Brief §13).
 */

function locationDictionaryText(): string {
  return LOCATION_DICTIONARY.map(
    (m) =>
      `- Address/keywords "${m.keywords.join('", "')}" => Business=${m.business}, Class=${m.class}, FirstPassApprover=${m.default_approver}`,
  ).join("\n");
}

const SYSTEM = `You are an expert accounts-payable data extraction engine for a multi-entity salon and wellness business (brands: Neroli, SKNBar, IBW, Chicago, and Admin/Corporate).

You receive the structured output of AWS Textract Analyze Expense, already labeled. Extract the invoice header fields and determine the business entity, class, and first-pass approver by matching the delivery/ship-to address (or other address keywords) against the LOCATION DICTIONARY.

LOCATION DICTIONARY (source of truth for routing):
${locationDictionaryText()}

RULES:
- Match the SHIP-TO / delivery address first; if absent, use the receiver/bill-to address; if no address matches any entry, set Business="Admin", Class="None", ApprovedBy="Bonnie".
- Class MUST be one of: Mequon, Downtown, Eastside, North Shore, Brookfield, Shorewood, Pewaukee, Milwaukee, Madison, Chicago, None.
- Business MUST be one of: Neroli, SKNBar, IBW, Chicago, Admin.
- ApprovedBy MUST be one of: Lori, Lisa, Kari, Bonnie, Susan.
- All money values are strings (e.g. "1234.56"). SalesTax is "0.00" if none.
- Dates are MM/DD/YYYY. If DueDate is missing, use InvDate.
- Output ONLY the JSON object, no prose, no code fences.`;

const SCHEMA = `Return exactly this JSON shape:
{
  "Vendor": "full legal vendor name",
  "Subtotal": "amount before tax",
  "SalesTax": "tax amount, 0.00 if none",
  "TotalAmount": "final balance due",
  "InvDate": "MM/DD/YYYY",
  "DueDate": "MM/DD/YYYY (use InvDate if missing)",
  "InvoiceNumber": "unique invoice ID",
  "Business": "Neroli | SKNBar | IBW | Chicago | Admin",
  "Class": "Mequon | Downtown | Eastside | North Shore | Brookfield | Shorewood | Pewaukee | Milwaukee | Madison | Chicago | None",
  "ApprovedBy": "Lori | Lisa | Kari | Bonnie | Susan"
}`;

export async function runPrompt1(
  textractText: string,
): Promise<Prompt1Output> {
  const user = `${SCHEMA}\n\nHere is the Textract-extracted invoice data:\n\n${textractText}`;
  return callClaudeJSON<Prompt1Output>(SYSTEM, user, 1024);
}
