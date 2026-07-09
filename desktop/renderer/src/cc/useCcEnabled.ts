/**
 * Renderer mirror of the worker's CC gate (see worker/src/cc/flag.ts). Single
 * source so the client (nav item, sub-nav, routes, landing redirect) and the
 * server agree on who sees the Credit Cards module and in which mode.
 *
 *   - manager  (credit_card_accountant / admin) → the full dashboard + all screens.
 *   - cardholder (executive; limited to the pinned test cardholder "Lori" during
 *                 the controlled rollout) → only their own "My Receipts" view.
 *
 * Keep CC_ALLOWED_EMAILS / CC_CARDHOLDERS_ALL_EXECUTIVES in sync with the worker.
 */

import { useProfile } from "@/components/ProfileProvider";
import { ROLES } from "@/lib/constants";
import type { CurrentProfile } from "@/components/ProfileProvider";

// Editable allowlist — pin the test cardholder's exact login email here when
// known. The full-name fallback ("lori") ships without it. Keep in sync with the worker.
const CC_ALLOWED_EMAILS = new Set<string>([
  /* "lori@company.com" */
]);

// While false, the cardholder view is limited to the pinned test cardholder(s).
// Flip to true to give every Executive their own "My Receipts" view.
const CC_CARDHOLDERS_ALL_EXECUTIVES = false;

type CcProfile = Pick<CurrentProfile, "name" | "email" | "role">;

function isPinnedCardholder(profile: CcProfile): boolean {
  const email = (profile.email || "").toLowerCase();
  if (email && CC_ALLOWED_EMAILS.has(email)) return true;
  const first = (profile.name || "").trim().split(/\s+/)[0]?.toLowerCase();
  return first === "lori";
}

/** Full manager dashboard: the credit_card_accountant role + admins. */
export function isCcManager(profile: CcProfile): boolean {
  return (
    profile.role === ROLES.ADMIN || profile.role === ROLES.CREDIT_CARD_ACCOUNTANT
  );
}

/** Own "My Receipts" view only: executives (limited to the pinned cardholder for now). */
export function isCcCardholder(profile: CcProfile): boolean {
  if ((profile.role as string) !== ROLES.EXECUTIVE) return false;
  return CC_CARDHOLDERS_ALL_EXECUTIVES || isPinnedCardholder(profile);
}

/** Visible at all (manager OR cardholder). */
export function isCcEnabled(profile: CcProfile): boolean {
  return isCcManager(profile) || isCcCardholder(profile);
}

/** Hook: is the module visible to the current user? */
export function useCcEnabled(): boolean {
  return isCcEnabled(useProfile());
}

/** Hook: does the current user get the full manager dashboard? */
export function useCcManager(): boolean {
  return isCcManager(useProfile());
}
