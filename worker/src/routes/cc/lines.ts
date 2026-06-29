/**
 * CCRMS line-by-line receipt-coding routes (NEW; backend agent B). §4.
 *
 *   GET /transactions/:id/lines — the OCR lines + current coding for a tx.
 *   PUT /transactions/:id/lines — replace-all writer for lines + allocations;
 *                                 re-derives cc_entity_splits; bumps tx.updated_at;
 *                                 does NOT change receipt_status.
 *
 * Mounted at "/" by the mounter, so it declares the FULL `/transactions/...`
 * sub-paths here (the 3-segment `/transactions/:id/lines` never shadows
 * `/transactions/:id` or `/transactions/:id/splits`). Implements the §2 preamble
 * (404→503→403→400→success). Edit rights = the owning cardholder OR a manager.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { nowIso } from "../../lib/util";
import {
  validateLineCoding,
  replaceLines,
  readLines,
  deriveEntitySplits,
} from "../../cc/ccLines";
import type { ReceiptLine, TxRow } from "../../cc/ccTypes";

export const lines = new Hono<AppEnv>();

function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN);
}

/**
 * True if the current user may read/write this transaction's lines: a manager,
 * or the cardholder who owns it (resolved via the cc_cardholders row linked to
 * the user by user_id or first-name). Copied from splits.ts/receipts.ts per the
 * module's no-cross-file-import convention.
 */
async function ownsOrManages(
  c: import("hono").Context<AppEnv>,
  tx: TxRow,
): Promise<boolean> {
  if (isManager(c)) return true;
  if (!tx.cardholder_id) return false;
  const u = user(c);
  const first = (u.name || "").trim().split(/\s+/)[0] ?? "";
  try {
    const row = await c.env.DB.prepare(
      "SELECT id FROM cc_cardholders WHERE id = ? AND (user_id = ? OR lower(first_name) = lower(?))",
    )
      .bind(tx.cardholder_id, u.id, first)
      .first<{ id: string }>();
    return !!row;
  } catch {
    return false;
  }
}

function fetchTx(env: AppEnv["Bindings"], id: string): Promise<TxRow | null> {
  return env.DB.prepare("SELECT * FROM cc_transactions WHERE id = ?")
    .bind(id)
    .first<TxRow>();
}

// ----- GET /transactions/:id/lines ------------------------------------------
lines.get("/transactions/:id/lines", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );

  const id = c.req.param("id");
  const tx = await fetchTx(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);
  if (!(await ownsOrManages(c, tx))) return c.json({ error: "Forbidden" }, 403);

  return c.json(await readLines(c.env, id, tx.amount));
});

// ----- PUT /transactions/:id/lines (replace-all) ----------------------------
lines.put("/transactions/:id/lines", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );

  const id = c.req.param("id");
  const tx = await fetchTx(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);
  if (!(await ownsOrManages(c, tx))) return c.json({ error: "Forbidden" }, 403);

  // Coding is allowed for both Amex and Capital One (matching PUT /splits).
  const body = (await c.req.json().catch(() => ({}))) as { lines?: ReceiptLine[] };
  const incoming = Array.isArray(body.lines) ? body.lines : [];

  const valid = validateLineCoding(tx.amount, incoming);
  if (!valid.ok) return c.json({ error: valid.error }, 400);

  // Replace-all: rewrite lines + allocations, re-derive cc_entity_splits, and
  // bump updated_at — all under one `at` timestamp. receipt_status is unchanged.
  const at = nowIso();
  await replaceLines(c.env, id, incoming, at);
  await deriveEntitySplits(c.env, id, incoming, at);
  await c.env.DB.prepare("UPDATE cc_transactions SET updated_at = ? WHERE id = ?")
    .bind(at, id)
    .run();

  return c.json(await readLines(c.env, id, tx.amount));
});
