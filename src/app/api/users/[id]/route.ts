import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ALL_ROLES, ROLES } from "@/lib/constants";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * PATCH /api/users/[id] — update role, entity access, active status, name
 * (Brief §07). Admin only.
 *
 * Body: { role?, entity_access?, is_active?, name? }
 */
export const PATCH = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    await requireRole(ROLES.ADMIN);
    const body = await request.json().catch(() => ({}));

    const update: Record<string, unknown> = {};
    if ("role" in body) {
      if (!ALL_ROLES.includes(body.role)) return fail("Invalid role", 400);
      update.role = body.role;
    }
    if ("entity_access" in body)
      update.entity_access = Array.isArray(body.entity_access)
        ? body.entity_access
        : null;
    if ("is_active" in body) update.is_active = !!body.is_active;
    if ("name" in body) update.name = body.name;

    if (Object.keys(update).length === 0)
      return fail("No updatable fields provided", 400);

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("users")
      .update(update)
      .eq("id", params.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    if (!data) return fail("User not found", 404);
    return ok({ user: data });
  },
);
