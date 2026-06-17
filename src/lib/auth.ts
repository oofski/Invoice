import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UserRow } from "@/lib/types";
import type { Role } from "@/lib/constants";

/**
 * Resolves the currently authenticated user's profile from the `users` table.
 *
 * The Supabase Auth user id is used as the primary key of the `users` row, so
 * we look up by id first; we fall back to email match to tolerate users that
 * were seeded before their first magic-link login.
 */
export async function getSessionProfile(): Promise<{
  authId: string;
  email: string | null;
  profile: UserRow | null;
} | null> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Use the service-role client for the profile lookup so it works regardless
  // of RLS configuration (the user is already authenticated at this point).
  const admin = createAdminClient();
  let { data: profile } = await admin
    .from("users")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile && user.email) {
    const byEmail = await admin
      .from("users")
      .select("*")
      .eq("email", user.email)
      .maybeSingle();
    profile = byEmail.data;
  }

  return {
    authId: user.id,
    email: user.email ?? null,
    profile: (profile as UserRow) ?? null,
  };
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/**
 * Returns the active user profile or throws an {@link AuthError}. Use inside
 * route handlers wrapped by {@link withAuth}.
 */
export async function requireProfile(): Promise<UserRow> {
  const session = await getSessionProfile();
  if (!session) throw new AuthError("Not authenticated", 401);
  if (!session.profile)
    throw new AuthError("No user profile found for account", 403);
  if (!session.profile.is_active)
    throw new AuthError("Account is deactivated", 403);
  return session.profile;
}

/**
 * Returns the profile if it has one of the allowed roles, else throws 403.
 */
export async function requireRole(...roles: Role[]): Promise<UserRow> {
  const profile = await requireProfile();
  if (!roles.includes(profile.role)) {
    throw new AuthError(
      `Forbidden: requires role ${roles.join(" or ")}`,
      403,
    );
  }
  return profile;
}

/** True if the role can see every entity's invoices. */
export function canViewAllEntities(role: Role): boolean {
  return role === "accountant" || role === "admin";
}
