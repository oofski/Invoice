import { type NextRequest } from "next/server";
import { ok, withErrorHandling } from "@/lib/api";
import { requireProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { scopeInvoiceQuery, reviewCounts } from "@/lib/visibility";
import type { InvoiceRow } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/invoices — list invoices with filters (Brief §07).
 * Query params: status, entity, approver, from, to, q, limit.
 * Visibility is scoped by role.
 */
export const GET = withErrorHandling(async (request: NextRequest) => {
  const profile = await requireProfile();
  const sp = request.nextUrl.searchParams;

  const admin = createAdminClient();
  let query = admin
    .from("invoices")
    .select("*")
    .order("created_at", { ascending: false });

  query = scopeInvoiceQuery(query, profile);

  const status = sp.get("status");
  if (status) query = query.eq("status", status);
  const entity = sp.get("entity");
  if (entity) query = query.eq("business", entity);
  const approver = sp.get("approver");
  if (approver) query = query.eq("approved_by", approver);
  const from = sp.get("from");
  if (from) query = query.gte("created_at", from);
  const to = sp.get("to");
  if (to) query = query.lte("created_at", to);
  const q = sp.get("q");
  if (q) query = query.ilike("vendor", `%${q}%`);
  const limit = Number(sp.get("limit") ?? 200);
  query = query.limit(Number.isFinite(limit) ? limit : 200);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const invoices = (data as InvoiceRow[]) ?? [];
  const counts = await reviewCounts(invoices.map((i) => i.id));

  return ok({
    invoices: invoices.map((i) => ({
      ...i,
      review_count: counts[i.id] ?? 0,
    })),
  });
});
