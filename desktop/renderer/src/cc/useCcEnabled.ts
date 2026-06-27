/**
 * Renderer mirror of the worker's `isCcEnabled(user)` gate (see
 * worker/src/cc/flag.ts). Single source so the client (nav item + routes) and
 * the server (404-if-disabled) agree on who can see the Credit Cards module.
 *
 * v1.2.9 mode is `lori_only`: enabled when the user's email is in the
 * allowlist OR the first token of their full name is "lori". Flip to role-based
 * by setting CC_FLAG_MODE = "role_based" (must be flipped in BOTH this file and
 * the worker's flag.ts to stay in sync).
 */

import { useProfile } from "@/components/ProfileProvider";
import { ROLES } from "@/lib/constants";
import type { CurrentProfile } from "@/components/ProfileProvider";

// Editable allowlist — pin Lori's exact login email here when known. The
// full-name fallback ships without it. Keep in sync with the worker.
const CC_ALLOWED_EMAILS = new Set<string>([
  /* "lori@company.com" */
]);

const CC_FLAG_MODE: "lori_only" | "role_based" = "lori_only";

/** Pure predicate (testable / reusable outside React). */
export function isCcEnabled(
  profile: Pick<CurrentProfile, "name" | "email" | "role">,
): boolean {
  if (CC_FLAG_MODE === "role_based") {
    // The new credit_card_accountant role is dormant in the renderer's ROLES
    // (worker-only), so compare by string to avoid an import-time coupling.
    const role = profile.role as string;
    return (
      role === ROLES.ADMIN ||
      role === ROLES.EXECUTIVE ||
      role === "credit_card_accountant"
    );
  }
  // lori_only
  const email = (profile.email || "").toLowerCase();
  if (CC_ALLOWED_EMAILS.has(email)) return true;
  const first = (profile.name || "").trim().split(/\s+/)[0]?.toLowerCase();
  return first === "lori";
}

/** Hook form — reads the current profile from context. */
export function useCcEnabled(): boolean {
  const profile = useProfile();
  return isCcEnabled(profile);
}
