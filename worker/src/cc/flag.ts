/**
 * CCRMS feature-flag + scoping gate trio.
 *
 *   - `isCcManager(u)`   — does this user get the FULL manager dashboard? The
 *                          dedicated credit-card-accountant role (+ admin).
 *   - `isCcCardholder(u)`— does this user get only their OWN "My Receipts" view?
 *                          Executives. During the controlled rollout this is
 *                          limited to the pinned test cardholder(s) (Lori); set
 *                          `CC_CARDHOLDERS_ALL_EXECUTIVES = true` to open it to
 *                          every executive.
 *   - `isCcEnabled(u)`   — is the credit-card module visible at all? manager OR
 *                          cardholder.
 *   - `ccReady(env)`     — has the CC schema been migrated? (mirrors invoice
 *                          `splitReady`/`archiveReady`: a probe SELECT in try/catch).
 *   - `ccScopeClause(c)` — manager/admin see all; a cardholder-scoped user is
 *                          limited to their own transactions (mirrors invoice
 *                          `scopeClause`).
 *
 * Routes import these from this one module.
 */
import type { Context } from "hono";
import type { Env, AuthUser } from "../lib/types";
import { ROLES } from "../lib/constants";
import { user, hasRole } from "../routes/helpers";
import type { AppEnv } from "../routes/helpers";

/**
 * Editable allowlist — pin the test cardholder's exact login email here when
 * known. The `full_name` first-token fallback ("lori") ships without it, so the
 * gate works even if the email is not yet pinned. Lower-cased on compare.
 */
export const CC_ALLOWED_EMAILS = new Set<string>([
  /* "lori@company.com" */
]);

/**
 * Controlled rollout switch. While `false`, the cardholder ("My Receipts") view
 * is limited to the pinned test cardholder(s) below (Lori). Flip to `true` to
 * give every Executive their own cardholder view.
 */
export const CC_CARDHOLDERS_ALL_EXECUTIVES = false;

/** Is this user the pinned test cardholder (Lori)? email allowlist OR name. */
function isPinnedCardholder(u: AuthUser): boolean {
  const email = (u.email || "").toLowerCase();
  if (email && CC_ALLOWED_EMAILS.has(email)) return true;
  const first = (u.name || "").trim().split(/\s+/)[0]?.toLowerCase();
  return first === "lori";
}

/**
 * Managers see the full dashboard: the dedicated credit-card-accountant role and
 * admins. (This is exactly the role set the route handlers gate on via
 * `hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN)`.)
 */
export function isCcManager(u: AuthUser): boolean {
  return (
    u.role === ROLES.CREDIT_CARD_ACCOUNTANT ||
    u.role === ROLES.ADMIN ||
    // v1.9.3: the general accountant is a full CC manager too (delete/split/all).
    u.role === ROLES.ACCOUNTANT
  );
}

/**
 * Cardholders see ONLY their own "My Receipts" view: executives. Limited to the
 * pinned test cardholder during the controlled rollout (unless opened to all).
 */
export function isCcCardholder(u: AuthUser): boolean {
  if (u.role !== ROLES.EXECUTIVE) return false;
  return CC_CARDHOLDERS_ALL_EXECUTIVES || isPinnedCardholder(u);
}

/** Whether the credit-card module is visible to `u` at all (manager OR cardholder). */
export function isCcEnabled(u: AuthUser): boolean {
  return isCcManager(u) || isCcCardholder(u);
}

/**
 * True once the CC schema migration has run (the `cc_transactions` table exists).
 * Mirrors `splitReady` — a probe SELECT in try/catch returns false on a stale,
 * un-migrated isolate so routes can answer 503 instead of throwing.
 */
export async function ccReady(env: Env): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1 FROM cc_transactions LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cardholder-scoping clause for transaction queries. The CC manager (role
 * `credit_card_accountant`) and admin see everything → `{ clause:"", params:[] }`.
 * A cardholder-scoped user is limited to the `cc_cardholders` row(s) linked to
 * them — by `user_id` first, else by first-name match (mirrors invoice
 * `scopeClause`'s name-tolerant fallback). The clause is meant to be appended to
 * a `WHERE …` that already filters `cc_transactions`.
 */
/**
 * The subquery selecting the cc_cardholders ids a scoped user may access.
 *
 * v1.9.10 (H3): ownership matches on `user_id` first. The first-name fallback is
 * kept for cardholders not yet linked to a login, but ONLY when that first name
 * is UNIQUE across cc_cardholders — otherwise two executives sharing a first name
 * (or an unlinked row whose name collides) would cross-access each other's
 * transactions/receipts. When a name is ambiguous, name-matching is disabled and
 * access requires a real `user_id` link (fail closed, never cross-access).
 */
export function cardholderScopeSubquery(u: AuthUser): {
  sql: string;
  params: string[];
} {
  const first = (u.name || "").trim().split(/\s+/)[0] ?? "";
  return {
    sql:
      "SELECT id FROM cc_cardholders WHERE user_id = ?" +
      " OR (user_id IS NULL AND lower(first_name) = lower(?)" +
      " AND (SELECT COUNT(*) FROM cc_cardholders x WHERE lower(x.first_name) = lower(?)) = 1)",
    params: [u.id, first, first],
  };
}

export function ccScopeClause(c: Context<AppEnv>): { clause: string; params: string[] } {
  if (hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT)) {
    return { clause: "", params: [] };
  }
  const { sql, params } = cardholderScopeSubquery(user(c));
  return { clause: ` AND cardholder_id IN (${sql})`, params };
}

/**
 * True if the current user manages CC (sees everything) or owns the given
 * cardholder row (via `cardholderScopeSubquery`). The single shared owns-check
 * behind every route's local `ownsTx` / `ownsOrManages` so they can't drift.
 */
export async function ownsCardholder(
  c: Context<AppEnv>,
  cardholderId: string | null | undefined,
): Promise<boolean> {
  if (hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return true;
  if (!cardholderId) return false;
  const { sql, params } = cardholderScopeSubquery(user(c));
  try {
    const row = await c.env.DB.prepare(
      `SELECT 1 FROM cc_cardholders WHERE id = ? AND id IN (${sql})`,
    )
      .bind(cardholderId, ...params)
      .first();
    return !!row;
  } catch {
    return false;
  }
}
