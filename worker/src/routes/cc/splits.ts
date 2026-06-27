/**
 * CCRMS entity-split routes (NEW; owned by A2). §6.3.
 *
 *   GET /transactions/:id/splits — list the splits for a transaction.
 *   PUT /transactions/:id/splits — replace-all (Amex-only else 409; sum must
 *                                  equal the tx amount exact-to-cent else 400;
 *                                  owner-or-manager else 403).
 *
 * Mounted at "/" by the mounter, so it declares the FULL `/transactions/...`
 * sub-paths here. Implements the §2 preamble (404→503→403→400→success).
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { uuid, nowIso } from "../../lib/util";
import { roundCents, validateSplits } from "../../cc/ccRules";
import type { EntitySplit, EntitySplitInput, EntitySplitRow, TxRow } from "../../cc/ccTypes";

export const splits = new Hono<AppEnv>();

function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN);
}

/**
 * True if the current user may read/write this transaction's splits: a manager,
 * or the cardholder who owns it (resolved via the cc_cardholders row linked to
 * the user by user_id or first-name — mirrors `ccScopeClause`).
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

async function listSplits(env: AppEnv["Bindings"], txId: string): Promise<EntitySplit[]> {
  const res = await env.DB.prepare(
    "SELECT id, transaction_id, entity_name, amount FROM cc_entity_splits WHERE transaction_id = ? ORDER BY created_at ASC",
  )
    .bind(txId)
    .all<EntitySplitRow>();
  return (res.results ?? []).map((r) => ({
    id: r.id,
    transaction_id: r.transaction_id,
    entity_name: r.entity_name,
    amount: r.amount,
  }));
}

// ----- GET /transactions/:id/splits -----------------------------------------
splits.get("/transactions/:id/splits", async (c) => {
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

  return c.json({ splits: await listSplits(c.env, id) });
});

// ----- PUT /transactions/:id/splits -----------------------------------------
splits.put("/transactions/:id/splits", async (c) => {
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

  // Splits/coding are available for both Amex and Capital One transactions (a
  // cardholder uploads + codes their own receipt in-app for either card).

  const body = (await c.req.json().catch(() => ({}))) as { splits?: EntitySplitInput[] };
  const rows = Array.isArray(body.splits) ? body.splits : [];

  const valid = validateSplits(tx.amount, rows);
  if (!valid.ok) return c.json({ error: valid.error }, 400);

  // Replace-all: DELETE then INSERT (zero-amount rows are dropped on write).
  const at = nowIso();
  await c.env.DB.prepare("DELETE FROM cc_entity_splits WHERE transaction_id = ?")
    .bind(id)
    .run();
  for (const s of rows) {
    const amount = roundCents(typeof s.amount === "number" ? s.amount : Number(s.amount));
    if (amount === 0) continue;
    await c.env.DB.prepare(
      "INSERT INTO cc_entity_splits (id, transaction_id, entity_name, amount, created_at) VALUES (?,?,?,?,?)",
    )
      .bind(uuid(), id, s.entity_name, amount, at)
      .run();
  }

  await c.env.DB.prepare("UPDATE cc_transactions SET updated_at = ? WHERE id = ?")
    .bind(at, id)
    .run();

  return c.json({ splits: await listSplits(c.env, id) });
});
