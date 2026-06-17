import { callClaudeJSON } from "./anthropic";
import type { Prompt3Output } from "@/lib/types";
import { GL_CATEGORIES_FLAT, REQUIRES_MANUAL_REVIEW } from "@/lib/constants";

/**
 * Prompt 3 — GL Line-Item Categorization (Brief §05).
 *
 * Extracts every line item and categorizes each into one of the 47 allowed GL
 * accounts using the strict 5-level logic hierarchy, returning one object per
 * line item with confidence scoring. Anything below 90% confidence becomes
 * REQUIRES_MANUAL_REVIEW (which blocks export until resolved — Brief §13).
 */

const SYSTEM = `You are a GL coding engine for a multi-entity salon and wellness business. For EVERY line item on the invoice, assign exactly one GL category from the allowed list using this strict 5-LEVEL LOGIC HIERARCHY, evaluated in order:

LEVEL 1: Tax isolation — if the description contains "sales tax" or "use tax", category = "Sales/Use Tax". NEVER override this.
LEVEL 2: Vendor lookup — if the vendor has a known mapped category, use it.
LEVEL 3: Keyword match — e.g. "cleaning" => "Repairs & Maintenance"; "rent" => "Occupancy - Rent"; "shipping/freight" => "Freight"; "software/IT" => "Computer & IT"; "insurance" => "Insurance - Business".
LEVEL 4: Entity fallback — a vague SKNBar item => "Service Costs"; an IBW student-related item => "Student Expenses".
LEVEL 5: Confidence below 90% => category = "${REQUIRES_MANUAL_REVIEW}".

ALLOWED GL CATEGORIES (use one of these EXACTLY, or ${REQUIRES_MANUAL_REVIEW}):
${GL_CATEGORIES_FLAT.join(", ")}

For each line item also report:
- ConfidenceLevel: HIGH (>=90%), MEDIUM (75-89%), LOW (<75%), or MANUAL_REVIEW (when category is ${REQUIRES_MANUAL_REVIEW}).
- LogicPathUsed: which level decided it — "LEVEL 1", "LEVEL 2", "LEVEL 3", "LEVEL 4", or "LEVEL 5".
- BusinessEntity: the entity the item belongs to (Neroli | SKNBar | IBW | Chicago | Admin).
- Amount: the numeric line amount (a number, not a string).

If confidence is below 90%, you MUST set Category="${REQUIRES_MANUAL_REVIEW}", ConfidenceLevel="MANUAL_REVIEW", LogicPathUsed="LEVEL 5".

Output ONLY a JSON array, one object per line item, no prose, no code fences:
[
  {
    "BusinessEntity": "Neroli | SKNBar | IBW | Chicago | Admin",
    "LineItemDescription": "exact extracted description",
    "Amount": 0.00,
    "Category": "one of the 47 allowed categories OR ${REQUIRES_MANUAL_REVIEW}",
    "ConfidenceLevel": "HIGH | MEDIUM | LOW | MANUAL_REVIEW",
    "LogicPathUsed": "LEVEL 1 | LEVEL 2 | LEVEL 3 | LEVEL 4 | LEVEL 5"
  }
]`;

export async function runPrompt3(
  textractText: string,
): Promise<Prompt3Output> {
  const user = `Categorize every line item on this invoice. If there are no detected line items, create a single line item for the total amount.\n\n${textractText}`;
  return callClaudeJSON<Prompt3Output>(SYSTEM, user, 4096);
}
