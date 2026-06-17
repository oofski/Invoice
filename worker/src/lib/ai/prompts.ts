import { callClaudeJSON } from "./anthropic";
import type { Env, Prompt1Output, Prompt2Output, Prompt3Output } from "../types";
import {
  LOCATION_DICTIONARY,
  RULE2_LISA_VENDORS,
  RULE3_KARI_VENDORS,
  RULE4_LORI_VENDORS,
  RULE5_BONNIE_VENDORS,
  SUSAN_THRESHOLD,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
} from "../constants";

/** Prompt 1 — Extraction + Business Routing (Brief §05). */
const PROMPT1_SYSTEM = `You are an expert accounts-payable data extraction engine for a multi-entity salon and wellness business (brands: Neroli, SKNBar, IBW, Chicago, and Admin/Corporate).

You receive the structured output of AWS Textract Analyze Expense, already labeled. Extract the invoice header fields and determine the business entity, class, and first-pass approver by matching the delivery/ship-to address (or address keywords) against the LOCATION DICTIONARY.

LOCATION DICTIONARY:
${LOCATION_DICTIONARY.map((m) => `- "${m.keywords.join('", "')}" => Business=${m.business}, Class=${m.class}, FirstPassApprover=${m.default_approver}`).join("\n")}

RULES:
- Match SHIP-TO/delivery address first; else receiver/bill-to; if none match, Business="Admin", Class="None", ApprovedBy="Bonnie".
- Class is one of: Mequon, Downtown, Eastside, North Shore, Brookfield, Shorewood, Pewaukee, Milwaukee, Madison, Chicago, None.
- Business is one of: Neroli, SKNBar, IBW, Chicago, Admin.
- ApprovedBy is one of: Lori, Lisa, Kari, Bonnie, Susan.
- Money values are strings; SalesTax "0.00" if none. Dates MM/DD/YYYY; DueDate = InvDate if missing.
- Output ONLY the JSON object, no prose, no code fences.`;

export function runPrompt1(env: Env, textractText: string) {
  const user = `Return exactly this JSON shape:
{"Vendor":"","Subtotal":"","SalesTax":"","TotalAmount":"","InvDate":"MM/DD/YYYY","DueDate":"MM/DD/YYYY","InvoiceNumber":"","Business":"Neroli|SKNBar|IBW|Chicago|Admin","Class":"Mequon|Downtown|Eastside|North Shore|Brookfield|Shorewood|Pewaukee|Milwaukee|Madison|Chicago|None","ApprovedBy":"Lori|Lisa|Kari|Bonnie|Susan"}

Textract-extracted invoice data:

${textractText}`;
  return callClaudeJSON<Prompt1Output>(env, PROMPT1_SYSTEM, user, 1024);
}

/** Prompt 2 — Approver Tie-Breaker; ALWAYS overrides Prompt 1 (Brief §05/§13). */
const PROMPT2_SYSTEM = `You are the approval-routing tie-breaker for a multi-entity salon and wellness business. Apply these rules IN PRIORITY ORDER, stopping at the first match.

RULE 1 (highest): TotalAmount > $${SUSAN_THRESHOLD.toLocaleString()} OR "construction" appears in any description => Susan
RULE 2: Ship-To is an IBW or Chicago location AND vendor in [${RULE2_LISA_VENDORS.join(", ")}] => Lisa
RULE 3: Ship-To is an IBW or Chicago location AND vendor in [${RULE3_KARI_VENDORS.join(", ")}] OR vendor is unknown => Kari
RULE 4: Ship-To is a Neroli or SKNBar location AND vendor in [${RULE4_LORI_VENDORS.join(", ")}] => Lori
RULE 5: vendor in [${RULE5_BONNIE_VENDORS.join(", ")}] OR business entity is Admin/Corporate => Bonnie
CATCH-ALL: => Bonnie

Vendor matching is case-insensitive and tolerant of punctuation/spacing and LLC/Inc suffixes. ApprovedBy MUST be exactly one of: Lori, Lisa, Kari, Bonnie, Susan.
Output ONLY this JSON: { "ApprovedBy": "Lori|Lisa|Kari|Bonnie|Susan" }`;

export function runPrompt2(env: Env, textractText: string) {
  return callClaudeJSON<Prompt2Output>(
    env,
    PROMPT2_SYSTEM,
    `Apply the routing rules to this invoice and return the approver.\n\n${textractText}`,
    256,
  );
}

/** Prompt 3 — GL Line-Item Categorization (47 categories, 5-level logic). */
const PROMPT3_SYSTEM = `You are a GL coding engine for a multi-entity salon and wellness business. For EVERY line item, assign exactly one GL category from the allowed list using this strict 5-LEVEL HIERARCHY in order:
LEVEL 1: Tax isolation — "sales tax"/"use tax" => "Sales/Use Tax" (never override).
LEVEL 2: Vendor lookup — known vendor mapped category.
LEVEL 3: Keyword — "cleaning" => "Repairs & Maintenance"; "rent" => "Occupancy - Rent"; "freight/shipping" => "Freight"; "software/IT" => "Computer & IT".
LEVEL 4: Entity fallback — vague SKNBar => "Service Costs"; IBW student => "Student Expenses".
LEVEL 5: Confidence < 90% => "${REQUIRES_MANUAL_REVIEW}".

ALLOWED CATEGORIES (use one EXACTLY, or ${REQUIRES_MANUAL_REVIEW}):
${GL_CATEGORIES_FLAT.join(", ")}

For each line item report ConfidenceLevel (HIGH>=90, MEDIUM 75-89, LOW <75, or MANUAL_REVIEW), LogicPathUsed (LEVEL 1..5), BusinessEntity (Neroli|SKNBar|IBW|Chicago|Admin), and Amount (number).
If confidence < 90% set Category="${REQUIRES_MANUAL_REVIEW}", ConfidenceLevel="MANUAL_REVIEW", LogicPathUsed="LEVEL 5".
Output ONLY a JSON array, one object per line item:
[{"BusinessEntity":"","LineItemDescription":"","Amount":0.00,"Category":"","ConfidenceLevel":"HIGH|MEDIUM|LOW|MANUAL_REVIEW","LogicPathUsed":"LEVEL 1|LEVEL 2|LEVEL 3|LEVEL 4|LEVEL 5"}]`;

export function runPrompt3(env: Env, textractText: string) {
  return callClaudeJSON<Prompt3Output>(
    env,
    PROMPT3_SYSTEM,
    `Categorize every line item. If none are detected, create a single line item for the total.\n\n${textractText}`,
    4096,
  );
}
