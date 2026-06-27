/**
 * CCRMS feature-flag + scoping gate trio (NEW).
 *
 *   - `isCcEnabled(u)`  — is the credit-card module visible to this user? In
 *                         v1.2.9 (`lori_only`) only Lori passes; the role-based
 *                         branch is coded but dormant.
 *   - `ccReady(env)`    — has the CC schema been migrated? (mirrors invoice
 *                         `splitReady`/`archiveReady`: a probe SELECT in try/catch).
 *   - `ccScopeClause(c)` — manager/admin see all; a cardholder-scoped user is
 *                         limited to their own transactions (mirrors invoice
 *                         `scopeClause`). Dormant in v1.2.9 (Lori is the manager).
 *
 * Routes import all three from this one module.
 */
import type { Context } from "hono";
import type { Env, AuthUser } from "../lib/types";
import { ROLES } from "../lib/constants";
import { user, hasRole } from "../routes/helpers";
import type { AppEnv } from "../routes/helpers";

/**
 * Editable allowlist — pin Lori's exact login email here when known. The
 * `full_name` first-token fallback ships without it, so the flag works even if
 * the email is not yet pinned. Lower-cased on compare.
 */
export const CC_ALLOWED_EMAILS = new Set<string>([
  /* "lori@company.com" */
]);

/**
 * v1.2.9 ships in `lori_only` mode. Flip this ONE constant to `"role_based"` to
 * grant access by role (credit_card_accountant / executive / admin) — all role
 * plumbing (`ccScopeClause`, the role gates in the routes) is already built.
 */
export const CC_FLAG_MODE: "lori_only" | "role_based" = "lori_only";

/**
 * Whether the credit-card module is enabled for `u`.
 *   - role_based: credit_card_accountant | executive | admin.
 *   - lori_only (default): allowlisted email OR full-name first token === "lori".
 */
export function isCcEnabled(u: AuthUser): boolean {
  if (CC_FLAG_MODE === "role_based") {
    return (
      u.role === ROLES.CREDIT_CARD_ACCOUNTANT ||
      u.role === ROLES.EXECUTIVE ||
      u.role === ROLES.ADMIN
    );
  }
  // lori_only: allowlist email OR full_name first token == "lori"
  const email = (u.email || "").toLowerCase();
  if (CC_ALLOWED_EMAILS.has(email)) return true;
  const first = (u.name || "").trim().split(/\s+/)[0]?.toLowerCase();
  return first === "lori";
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
 *
 * Dormant in v1.2.9 (Lori is the manager and sees all), but coded for the
 * `role_based` flip.
 */
export function ccScopeClause(c: Context<AppEnv>): { clause: string; params: string[] } {
  if (hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN)) {
    return { clause: "", params: [] };
  }
  const u = user(c);
  const first = (u.name || "").trim().split(/\s+/)[0] ?? "";
  return {
    clause:
      " AND cardholder_id IN (SELECT id FROM cc_cardholders WHERE user_id = ? OR lower(first_name) = lower(?))",
    params: [u.id, first],
  };
}
