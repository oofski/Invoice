import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ROLES } from "@/lib/constants";
import type { AuditLogRow, UserRow, InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/audit — global audit log, filterable by user, action, and date
 * range (Brief §08). Auth: accountant, admin. Enriched with user + vendor names
 * for display and CSV export.
 * Query: action, userId, from, to, limit
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const sp = request.nextUrl.searchParams;
  const admin = createAdminClient();

  let query = admin
    .from("audit_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Number(sp.get("limit") ?? 500));

  const action = sp.get("action");
  if (action) query = query.eq("action", action);
  const userId = sp.get("userId");
  if (userId) query = query.eq("user_id", userId);
  const from = sp.get("from");
  if (from) query = query.gte("created_at", from);
  const to = sp.get("to");
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const entries = (data as AuditLogRow[]) ?? [];

  const userIds = Array.from(
    new Set(entries.map((e) => e.user_id).filter(Boolean)),
  ) as string[];
  const invoiceIds = Array.from(
    new Set(entries.map((e) => e.invoice_id).filter(Boolean)),
  ) as string[];

  const [usersRes, invoicesRes] = await Promise.all([
    userIds.length
      ? admin.from("users").select("id,name").in("id", userIds)
      : Promise.resolve({ data: [] }),
    invoiceIds.length
      ? admin.from("invoices").select("id,vendor").in("id", invoiceIds)
      : Promise.resolve({ data: [] }),
  ]);

  const userName = Object.fromEntries(
    ((usersRes.data as Pick<UserRow, "id" | "name">[]) ?? []).map((u) => [
      u.id,
      u.name,
    ]),
  );
  const vendorName = Object.fromEntries(
    ((invoicesRes.data as Pick<InvoiceRow, "id" | "vendor">[]) ?? []).map((i) => [
      i.id,
      i.vendor,
    ]),
  );

  return ok({
    entries: entries.map((e) => ({
      ...e,
      user_name: e.user_id ? (userName[e.user_id] ?? "System") : "System",
      vendor: e.invoice_id ? (vendorName[e.invoice_id] ?? null) : null,
    })),
  });
});
