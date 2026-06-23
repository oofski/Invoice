import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES } from "@/lib/constants";
import type { VendorMappingRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/** PATCH /api/vendors/[id] — update a vendor mapping (Brief §07). */
export const PATCH = withErrorHandling(
  async (request: NextRequest, { params }: Ctx) => {
    await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
    const body = await request.json().catch(() => ({}));

    const allowed: (keyof VendorMappingRow)[] = [
      "vendor_name",
      "business_entity",
      "class",
      "default_approver",
      "is_inventory",
      "gl_override",
    ];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) if (key in body) update[key] = body[key];

    const admin = createAdminClient();
    const { data, error } = await admin
      .from("vendor_mappings")
      .update(update)
      .eq("id", params.id)
      .select("*")
      .single();
    if (error) {
      if (error.code === "23505")
        return fail("A mapping with that vendor name already exists", 409);
      throw new Error(error.message);
    }
    if (!data) return fail("Vendor mapping not found", 404);
    return ok({ vendor: data });
  },
);
