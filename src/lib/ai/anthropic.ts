import Anthropic from "@anthropic-ai/sdk";

/**
 * Anthropic Claude client + structured-output helper.
 *
 * Model is fixed to claude-sonnet-4-6 per Brief §05. All three prompts request
 * strict JSON; we run at temperature 0 for deterministic routing/categorization
 * and parse the first JSON value out of the response.
 */

export const CLAUDE_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY env var");
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

/** Extracts the first balanced JSON object or array from arbitrary text. */
function extractJson(text: string): string {
  const trimmed = text.trim();
  // Strip ```json fences if present.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;

  const start = body.search(/[[{]/);
  if (start === -1) return body;

  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}

/**
 * Calls Claude and parses a JSON response of type T.
 *
 * @param system  System prompt (role + rules).
 * @param user    User message (the labeled Textract context + the task).
 * @param maxTokens output budget.
 */
export async function callClaudeJSON<T>(
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<T> {
  const client = getClient();
  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  const json = extractJson(text);
  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new Error(
      `Claude returned non-JSON output: ${text.slice(0, 500)}`,
      { cause: err },
    );
  }
}
