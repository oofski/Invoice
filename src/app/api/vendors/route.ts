import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES } from "@/lib/constants";

export const dynamic = "force-dynamic";

/** GET /api/vendors — list all vendor mappings (Brief §07). */
export const GET = withErrorHandling(async (_request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_mappings")
    .select("*")
    .order("vendor_name", { ascending: true });
  if (error) throw new Error(error.message);
  return ok({ vendors: data ?? [] });
});

/** POST /api/vendors — create a new vendor mapping (Brief §07). */
export const POST = withErrorHandling(async (request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const body = await request.json().catch(() => ({}));
  const vendor_name = (body?.vendor_name as string | undefined)?.trim();
  if (!vendor_name) return fail("vendor_name is required", 400);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("vendor_mappings")
    .insert({
      vendor_name,
      business_entity: body.business_entity ?? null,
      class: body.class ?? null,
      default_approver: body.default_approver ?? null,
      is_inventory: !!body.is_inventory,
      gl_override: body.gl_override ?? null,
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505")
      return fail("A mapping for that vendor already exists", 409);
    throw new Error(error.message);
  }
  return ok({ vendor: data }, 201);
});
