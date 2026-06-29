/**
 * CCRMS receipt OCR + cardholder match (NEW).
 *
 * MIRRORS `lib/extract.ts` (schema + system prompt + `normalizeExtract`'s
 * `num()`/`str()` narrowing) but is a receipt-specific engine: it adds
 * `card_last_4` + `cardholder_name`, and a `matchCardholder` step that resolves
 * the receipt to a registry cardholder by last-4 / Amex last-5 suffix, using the
 * purchaser name as a secondary / disambiguation signal.
 *
 * Imports ONLY `runExtract`/`uploadToReducto` from `lib/reducto.ts` — it never
 * touches `extract.ts`.
 */
import type { Env } from "../lib/types";
import { runExtract, uploadToReducto } from "../lib/reducto";
import { parseAmount } from "../lib/util";
import type {
  CcSource,
  NormalizedReceipt,
  NormalizedReceiptLine,
  MatchResult,
} from "./ccTypes";

/** Reducto extraction schema for a single credit-card receipt (§3a). */
export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant_name: {
      type: "string",
      description: "Merchant / vendor name printed on the receipt.",
    },
    transaction_date: {
      type: "string",
      description: "Purchase date, formatted MM/DD/YYYY.",
    },
    total: {
      type: "number",
      description: "Receipt grand total charged to the card.",
    },
    card_last_4: {
      type: "string",
      description:
        "The last 4 digits of the credit card used, digits only. Often printed as 'XXXX-XXXX-XXXX-1234', 'ending in 1234', or 'Acct #...1234'.",
    },
    cardholder_name: {
      type: "string",
      description:
        "The cardholder / purchaser name printed near the signature or authorization line.",
    },
    line_items: {
      type: "array",
      description: "Optional itemized lines if the receipt is itemized; otherwise omit.",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number", description: "Quantity if printed; omit otherwise." },
          unit_price: { type: "number", description: "Per-unit price if printed; omit otherwise." },
          amount: { type: "number", description: "Extended line amount (qty × unit price)." },
        },
        required: ["description", "amount"],
      },
    },
    sales_tax: {
      type: "number",
      description: "Total sales tax printed on the receipt (the tax line). Omit if none.",
    },
  },
  required: ["merchant_name", "total"],
};

/** Receipt-specific system prompt (§3b). */
export const RECEIPT_SYSTEM_PROMPT = `You are a receipt-extraction engine. Extract a SINGLE credit-card receipt: the merchant name, purchase date (MM/DD/YYYY), and grand total. Find the last 4 digits of the card — typically printed as \`XXXX-XXXX-XXXX-1234\`, \`ending in 1234\`, or \`Acct #...1234\`; return digits only. Find the cardholder/purchaser name near the signature/authorization line. Money values are numbers. Capture itemized lines only if the receipt is itemized; otherwise omit \`line_items\`; capture each line's quantity and unit price when printed. Capture the sales-tax total as \`sales_tax\` when printed.`;

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

/** Extracts a digits-only last-4 from any printed card string. */
function last4(v: unknown): string {
  return String(v ?? "")
    .replace(/\D/g, "")
    .slice(-4);
}

/**
 * Coerces Reducto's structured output into a stable `NormalizedReceipt`. Mirrors
 * `normalizeExtract`'s narrowing; empty/absent fields degrade to `""`/`null` and
 * never throw.
 */
export function normalizeReceipt(data: unknown): NormalizedReceipt {
  const d = (data ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(d.line_items) ? d.line_items : [];
  const line_items: NormalizedReceiptLine[] = rawItems
    .map((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return {
        description: str(o.description),
        quantity: num(o.quantity),
        unit_price: num(o.unit_price),
        amount: num(o.amount),
      };
    })
    .filter((li) => li.description || li.amount != null);

  return {
    merchant_name: str(d.merchant_name),
    transaction_date: str(d.transaction_date),
    total: num(d.total),
    card_last_4: last4(d.card_last_4),
    cardholder_name: str(d.cardholder_name),
    line_items,
    sales_tax: num(d.sales_tax),
  };
}

/** Runs Reducto /extract for an uploaded receipt and returns raw + normalized. */
export async function extractReceipt(
  env: Env,
  documentUrl: string,
): Promise<{ raw: unknown; data: NormalizedReceipt }> {
  const { raw, data } = await runExtract(env, documentUrl, {
    schema: RECEIPT_SCHEMA,
    systemPrompt: RECEIPT_SYSTEM_PROMPT,
    arrayExtract: true,
  });
  return { raw, data: normalizeReceipt(data) };
}

/** Convenience: receipt bytes -> { raw, data } (upload + extract). */
export async function extractReceiptBytes(
  env: Env,
  bytes: ArrayBuffer,
  fileName: string,
): Promise<{ raw: unknown; data: NormalizedReceipt }> {
  const documentUrl = await uploadToReducto(env, bytes, fileName);
  return extractReceipt(env, documentUrl);
}

/** Minimal active-cardholder shape returned by the match lookups. */
interface MatchCandidate {
  id: string;
  first_name: string;
  last_name: string | null;
}

/** Tolerant name compare: trims/lower-cases and tests substring either way. */
function nameAgrees(printed: string, first: string, last: string | null): boolean {
  const p = printed.trim().toLowerCase();
  if (!p) return false;
  const f = (first || "").trim().toLowerCase();
  const l = (last || "").trim().toLowerCase();
  const full = `${f} ${l}`.trim();
  if (!f) return false;
  return (
    p === f ||
    p === full ||
    (l ? p.includes(f) && p.includes(l) : p.includes(f)) ||
    f.includes(p)
  );
}

/**
 * Resolves a receipt to a registry cardholder (§3d).
 *
 * 1. PRIMARY — last-4/last-5 lookup against ACTIVE cardholders:
 *    - CAPITAL_ONE: `cap_one_last4 = receipt.card_last_4`.
 *    - AMEX: receipts usually print last-4, registry stores last-5. If the
 *      extractor yields 5 digits, prefer exact `amex_last5 = ?` first, then fall
 *      back to suffix-match `substr(amex_last5,-4) = receipt last-4`.
 * 2. SECONDARY — purchaser-name signal: raises confidence to HIGH when last-4
 *    matches AND the printed name agrees; MEDIUM when name absent/unclear;
 *    disambiguates a multi-row last-4 result by the name-agreeing row; flags
 *    NAME_MISMATCH (still returns the last-4 cardholder_id) when last-4 says X but
 *    a clearly-different name is printed.
 * 3. UNMATCHED — when the last-4 resolves to no active cardholder:
 *    `{ cardholder_id:null, match:"UNMATCHED", confidence:"LOW" }`.
 *
 * Never throws — any D1 hiccup degrades to UNMATCHED/LOW.
 */
export async function matchCardholder(
  env: Env,
  receipt: NormalizedReceipt,
  source: CcSource,
): Promise<MatchResult> {
  const digits = receipt.card_last_4 || "";
  const printedName = receipt.cardholder_name || "";

  try {
    let candidates: MatchCandidate[] = [];

    if (source === "CAPITAL_ONE") {
      if (digits.length >= 4) {
        const res = await env.DB.prepare(
          "SELECT id, first_name, last_name FROM cc_cardholders WHERE is_active = 1 AND cap_one_last4 = ?",
        )
          .bind(digits.slice(-4))
          .all<MatchCandidate>();
        candidates = res.results ?? [];
      }
    } else {
      // AMEX. If the extractor yielded 5 digits, try an exact last-5 first.
      const all5 = String(receipt.card_last_4 ?? "").replace(/\D/g, "");
      if (all5.length === 5) {
        const exact = await env.DB.prepare(
          "SELECT id, first_name, last_name FROM cc_cardholders WHERE is_active = 1 AND amex_last5 = ?",
        )
          .bind(all5)
          .all<MatchCandidate>();
        candidates = exact.results ?? [];
      }
      // Fall back to suffix-match on the last 4 of the stored last-5.
      if (candidates.length === 0 && digits.length >= 4) {
        const suffix = await env.DB.prepare(
          "SELECT id, first_name, last_name FROM cc_cardholders WHERE is_active = 1 AND substr(amex_last5, -4) = ?",
        )
          .bind(digits.slice(-4))
          .all<MatchCandidate>();
        candidates = suffix.results ?? [];
      }
    }

    if (candidates.length === 0) {
      return { cardholder_id: null, match: "UNMATCHED", confidence: "LOW" };
    }

    // Disambiguate a multi-row last-4 result by the name-agreeing row.
    if (candidates.length > 1) {
      const byName = candidates.find((ch) =>
        nameAgrees(printedName, ch.first_name, ch.last_name),
      );
      if (byName) {
        return { cardholder_id: byName.id, match: "MATCHED", confidence: "HIGH" };
      }
      // Ambiguous: take the first but flag for review.
      return { cardholder_id: candidates[0].id, match: "NAME_MISMATCH", confidence: "LOW" };
    }

    // Exactly one last-4 candidate. Use the name as a confidence / mismatch signal.
    const ch = candidates[0];
    if (!printedName) {
      return { cardholder_id: ch.id, match: "MATCHED", confidence: "MEDIUM" };
    }
    if (nameAgrees(printedName, ch.first_name, ch.last_name)) {
      return { cardholder_id: ch.id, match: "MATCHED", confidence: "HIGH" };
    }
    // Last-4 says this person, but a clearly-different name is printed: flag it
    // (still return the cardholder_id for manual review; do not auto-reject).
    return { cardholder_id: ch.id, match: "NAME_MISMATCH", confidence: "LOW" };
  } catch (e) {
    console.error("[cc] matchCardholder failed (degrading to UNMATCHED):", e);
    return { cardholder_id: null, match: "UNMATCHED", confidence: "LOW" };
  }
}
