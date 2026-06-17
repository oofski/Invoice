import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES } from "@/lib/constants";
import type { AuditLogRow, UserRow } from "@/lib/types";

export const dynamic = "force-dynamic";

type Ctx = { params: { invoiceId: string } };

/**
 * GET /api/audit/[invoiceId] — full chronological audit trail for one invoice,
 * enriched with the acting user's name (Brief §07/§08). Auth: accountant, admin.
 */
export const GET = withErrorHandling(
  async (_request: NextRequest, { params }: Ctx) => {
    await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
    const admin = createAdminClient();

    const { data, error } = await admin
      .from("audit_log")
      .select("*")
      .eq("invoice_id", params.invoiceId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const entries = (data as AuditLogRow[]) ?? [];
    const userIds = Array.from(
      new Set(entries.map((e) => e.user_id).filter(Boolean)),
    ) as string[];

    let nameById: Record<string, string> = {};
    if (userIds.length) {
      const { data: users } = await admin
        .from("users")
        .select("id,name")
        .in("id", userIds);
      nameById = Object.fromEntries(
        ((users as Pick<UserRow, "id" | "name">[]) ?? []).map((u) => [
          u.id,
          u.name,
        ]),
      );
    }

    return ok({
      entries: entries.map((e) => ({
        ...e,
        user_name: e.user_id ? (nameById[e.user_id] ?? "System") : "System",
      })),
    });
  },
);
