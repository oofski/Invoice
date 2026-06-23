import { runPrompt1, runPrompt2, runPrompt3 } from "./prompts";
import type { Env, PipelineResult, Prompt3LineItem } from "../types";
import {
  APPROVERS,
  GL_CATEGORIES_FLAT,
  REQUIRES_MANUAL_REVIEW,
  CONFIDENCE_LEVEL,
  type Approver,
} from "../constants";

/**
 * Runs the three Claude prompts in parallel and merges (Brief §04/§13):
 * Prompt 2 ApprovedBy ALWAYS overrides Prompt 1; invalid GL categories or
 * sub-confidence items become REQUIRES_MANUAL_REVIEW.
 */
export async function runPipeline(
  env: Env,
  textractText: string,
): Promise<PipelineResult> {
  const [prompt1, prompt2, prompt3Raw] = await Promise.all([
    runPrompt1(env, textractText),
    runPrompt2(env, textractText),
    runPrompt3(env, textractText),
  ]);

  const candidate = prompt2?.ApprovedBy as Approver;
  const finalApprover: Approver = APPROVERS.includes(candidate)
    ? candidate
    : APPROVERS.includes(prompt1?.ApprovedBy as Approver)
      ? (prompt1.ApprovedBy as Approver)
      : "Bonnie";

  const allowed = new Set(GL_CATEGORIES_FLAT);
  const prompt3: Prompt3LineItem[] = (Array.isArray(prompt3Raw) ? prompt3Raw : []).map(
    (item) => {
      if (item.Category !== REQUIRES_MANUAL_REVIEW && !allowed.has(item.Category)) {
        return {
          ...item,
          Category: REQUIRES_MANUAL_REVIEW,
          ConfidenceLevel: CONFIDENCE_LEVEL.MANUAL_REVIEW,
          LogicPathUsed: "LEVEL 5",
        };
      }
      if (item.Category === REQUIRES_MANUAL_REVIEW) {
        return { ...item, ConfidenceLevel: CONFIDENCE_LEVEL.MANUAL_REVIEW };
      }
      return item;
    },
  );

  return { prompt1, prompt2: { ApprovedBy: finalApprover }, prompt3, finalApprover };
}
