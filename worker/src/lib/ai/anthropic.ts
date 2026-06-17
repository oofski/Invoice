import type { Env } from "../types";

/**
 * Claude client via the Messages REST API (fetch — runs natively in Workers).
 * Model fixed to claude-sonnet-4-6 per Brief §05; temperature 0 for
 * deterministic routing/coding. Parses the first JSON value from the response.
 */
export const CLAUDE_MODEL = "claude-sonnet-4-6";

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : trimmed;
  const start = body.search(/[[{]/);
  if (start === -1) return body;
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return body.slice(start, i + 1);
  }
  return body.slice(start);
}

export async function callClaudeJSON<T>(
  env: Env,
  system: string,
  user: string,
  maxTokens = 4096,
): Promise<T> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
  };
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  return JSON.parse(extractJson(text)) as T;
}
