import { callClaudeJSON } from "./anthropic";
import type { Prompt2Output } from "@/lib/types";
import {
  RULE2_LISA_VENDORS,
  RULE3_KARI_VENDORS,
  RULE4_LORI_VENDORS,
  RULE5_BONNIE_VENDORS,
  SUSAN_THRESHOLD,
} from "@/lib/constants";

/**
 * Prompt 2 — Approver Tie-Breaker (Brief §05). ALWAYS overrides Prompt 1's
 * ApprovedBy (Brief §13). Applies the priority-ordered routing rules using
 * vendor lists, the $10k+ threshold, inventory vs non-inventory classification,
 * and the Ship-To tie-breaker.
 */

const SYSTEM = `You are the approval-routing tie-breaker for a multi-entity salon and wellness business. Given an invoice's extracted data, determine the single correct approving executive by applying these rules IN PRIORITY ORDER and stopping at the first match.

RULE 1 (highest priority): TotalAmount > $${SUSAN_THRESHOLD.toLocaleString()} OR the word "construction" appears in any description  =>  Susan
RULE 2: Ship-To is an IBW or Chicago location AND vendor is one of [${RULE2_LISA_VENDORS.join(", ")}]  =>  Lisa
RULE 3: Ship-To is an IBW or Chicago location AND vendor is one of [${RULE3_KARI_VENDORS.join(", ")}] OR the vendor is unknown/unrecognized  =>  Kari
RULE 4: Ship-To is a Neroli or SKNBar location AND vendor is one of [${RULE4_LORI_VENDORS.join(", ")}]  =>  Lori
RULE 5: vendor is one of [${RULE5_BONNIE_VENDORS.join(", ")}] OR the business entity is Admin/Corporate  =>  Bonnie
CATCH-ALL (no rule above matched): => Bonnie

Vendor matching is case-insensitive and tolerant of minor punctuation/spacing differences and "LLC/Inc" suffixes. ApprovedBy MUST be exactly one of: Lori, Lisa, Kari, Bonnie, Susan.

Output ONLY this JSON, no prose, no code fences:
{ "ApprovedBy": "Lori | Lisa | Kari | Bonnie | Susan" }`;

export async function runPrompt2(
  textractText: string,
): Promise<Prompt2Output> {
  const user = `Apply the routing rules to this invoice and return the approver.\n\n${textractText}`;
  return callClaudeJSON<Prompt2Output>(SYSTEM, user, 256);
}
