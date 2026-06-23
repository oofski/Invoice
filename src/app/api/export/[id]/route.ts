import { type NextRequest } from "next/server";
import { fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { downloadExport } from "@/lib/storage";
import { ROLES } from "@/lib/constants";
import type { ExportRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: { id: string } };

/**
 * GET /api/export/[id] — re-download a previously generated export file
 * (Brief §07). Auth: accountant, admin. Returns the CSV as an attachment.
 */
export const GET = withErrorHandling(
  async (_request: NextRequest, { params }: Ctx) => {
    await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);

    const admin = createAdminClient();
    const { data: row } = await admin
      .from("exports")
      .select("*")
      .eq("id", params.id)
      .maybeSingle();
    if (!row) return fail("Export not found", 404);
    const exp = row as ExportRow;
    if (!exp.file_url) return fail("Export file is unavailable", 410);

    const csv = await downloadExport(exp.file_url);
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exp.file_name}"`,
      },
    });
  },
);
