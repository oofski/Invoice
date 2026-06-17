import { runPrompt1 } from "./prompt1";
import { runPrompt2 } from "./prompt2";
import { runPrompt3 } from "./prompt3";
import type { PipelineResult, Prompt3LineItem } from "@/lib/types";
import {
  APPROVERS,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
  CONFIDENCE_LEVEL,
  type Approver,
} from "@/lib/constants";

/**
 * Runs the three Claude prompts in parallel (Brief §04 step 4: Promise.all)
 * and merges the results.
 *
 * Critical rules enforced here (Brief §13):
 *  - Prompt 2's ApprovedBy ALWAYS overrides Prompt 1's.
 *  - Any Prompt 3 category not in the 47 allowed list, or any item flagged
 *    MANUAL_REVIEW / below-confidence, becomes REQUIRES_MANUAL_REVIEW.
 */
export async function runPipeline(
  textractText: string,
): Promise<PipelineResult> {
  const [prompt1, prompt2, prompt3Raw] = await Promise.all([
    runPrompt1(textractText),
    runPrompt2(textractText),
    runPrompt3(textractText),
  ]);

  // Prompt 2 ALWAYS wins. Guard against an out-of-enum value defensively.
  const candidate = prompt2?.ApprovedBy as Approver;
  const finalApprover: Approver = APPROVERS.includes(candidate)
    ? candidate
    : (APPROVERS.includes(prompt1?.ApprovedBy as Approver)
        ? (prompt1.ApprovedBy as Approver)
        : "Bonnie");

  const allowed = new Set(GL_CATEGORIES_FLAT);
  const prompt3: Prompt3LineItem[] = (
    Array.isArray(prompt3Raw) ? prompt3Raw : []
  ).map((item) => {
    const validCategory =
      item.Category === REQUIRES_MANUAL_REVIEW || allowed.has(item.Category);
    if (!validCategory) {
      return {
        ...item,
        Category: REQUIRES_MANUAL_REVIEW,
        ConfidenceLevel: CONFIDENCE_LEVEL.MANUAL_REVIEW,
        LogicPathUsed: "LEVEL 5",
      };
    }
    // Normalize a MANUAL_REVIEW category to carry the MANUAL_REVIEW confidence.
    if (item.Category === REQUIRES_MANUAL_REVIEW) {
      return {
        ...item,
        ConfidenceLevel: CONFIDENCE_LEVEL.MANUAL_REVIEW,
      };
    }
    return item;
  });

  return {
    prompt1,
    prompt2: { ApprovedBy: finalApprover },
    prompt3,
    finalApprover,
  };
}
