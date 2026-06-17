import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ALL_ROLES, ROLES } from "@/lib/constants";

export const dynamic = "force-dynamic";

/** GET /api/users — list all users (Brief §07). Read: accountant + admin. */
export const GET = withErrorHandling(async (_request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("users")
    .select("*")
    .order("role", { ascending: true })
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return ok({ users: data ?? [] });
});

/**
 * POST /api/users — create a user (Brief §07). Admin only.
 *
 * Inserts the profile (role + entity_access) and best-effort invites the user
 * via Supabase Auth so they receive a magic-link. The handle_new_user trigger
 * links the auth account to this profile by email on first login.
 *
 * Body: { name, email, role, entity_access? }
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireRole(ROLES.ADMIN);
  const body = await request.json().catch(() => ({}));
  const name = (body?.name as string | undefined)?.trim();
  const email = (body?.email as string | undefined)?.trim().toLowerCase();
  const role = body?.role as string | undefined;

  if (!name || !email || !role) return fail("name, email and role are required", 400);
  if (!ALL_ROLES.includes(role as never)) return fail("Invalid role", 400);

  const admin = createAdminClient();
  const { data: profile, error } = await admin
    .from("users")
    .insert({
      name,
      email,
      role,
      entity_access: Array.isArray(body.entity_access)
        ? body.entity_access
        : null,
      is_active: true,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505")
      return fail("A user with that email already exists", 409);
    throw new Error(error.message);
  }

  // Best-effort auth invite (does not fail user creation if email isn't set up).
  let invited = false;
  try {
    const redirectTo = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/auth/callback`;
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(
      email,
      { data: { name }, redirectTo },
    );
    invited = !inviteErr;
  } catch {
    invited = false;
  }

  return ok({ user: profile, invited }, 201);
});
