import type { Context } from "hono";
import type { Env, AuthUser } from "../lib/types";
import { ROLES } from "../lib/constants";
import { sameName } from "../lib/util";

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };

export function user(c: Context<AppEnv>): AuthUser {
  return c.get("user");
}

/** True if the current user has one of the allowed roles. */
export function hasRole(c: Context<AppEnv>, ...roles: string[]): boolean {
  return roles.includes(user(c).role);
}

export function isStaffOrAdmin(c: Context<AppEnv>): boolean {
  return hasRole(c, ROLES.ACCOUNTANT, ROLES.ADMIN);
}

/** Whether the current user may view a given invoice (Brief §03). */
export function canViewInvoice(
  c: Context<AppEnv>,
  invoice: { approved_by: string | null; submitted_by: string | null },
): boolean {
  const u = user(c);
  if (u.role === ROLES.ACCOUNTANT || u.role === ROLES.ADMIN) return true;
  if (u.role === ROLES.EXECUTIVE) return sameName(invoice.approved_by, u.name);
  if (u.role === ROLES.STAFF) return invoice.submitted_by === u.id;
  return false;
}
