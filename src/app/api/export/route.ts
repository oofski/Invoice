import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { requireRole } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadExport } from "@/lib/storage";
import { writeAudit } from "@/lib/audit";
import {
  generateQboBillsCsv,
  buildExportFilename,
  type ExportInvoice,
} from "@/lib/export/qbo";
import { INVOICE_STATUS, AUDIT_ACTION, ROLES } from "@/lib/constants";
import type { InvoiceRow, LineItemRow, ExportRow, UserRow } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** GET /api/export — export history (recent first). Auth: accountant, admin. */
export const GET = withErrorHandling(async () => {
  await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("exports")
    .select("*")
    .order("exported_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);

  const rows = (data as ExportRow[]) ?? [];
  const userIds = Array.from(
    new Set(rows.map((r) => r.exported_by).filter(Boolean)),
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
    exports: rows.map((r) => ({
      ...r,
      exported_by_name: r.exported_by
        ? (nameById[r.exported_by] ?? "—")
        : "—",
    })),
  });
});

/**
 * POST /api/export — generate a QBO Bills import CSV for selected invoices
 * (Brief §06, Session 6). Auth: accountant, admin.
 *
 * Enforces the critical rules (Brief §13):
 *  - Invoices must be APPROVED.
 *  - Already-EXPORTED invoices are rejected (export lock).
 *  - Invoices with unresolved REQUIRES_MANUAL_REVIEW items are blocked.
 *
 * Body: { "invoiceIds": ["uuid", ...] }
 * Returns the export record AND the CSV content for immediate download.
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const profile = await requireRole(ROLES.ACCOUNTANT, ROLES.ADMIN);
  const body = await request.json().catch(() => ({}));
  const invoiceIds = body?.invoiceIds as string[] | undefined;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return fail("Provide at least one invoiceId to export", 400);
  }

  const admin = createAdminClient();
  const { data: invoiceData, error: invErr } = await admin
    .from("invoices")
    .select("*")
    .in("id", invoiceIds);
  if (invErr) throw new Error(invErr.message);
  const invoices = (invoiceData as InvoiceRow[]) ?? [];

  if (invoices.length !== invoiceIds.length) {
    return fail("One or more invoices were not found", 404);
  }

  // --- Guardrails ---
  const alreadyExported = invoices.filter(
    (i) => i.status === INVOICE_STATUS.EXPORTED,
  );
  if (alreadyExported.length) {
    return fail(
      "One or more invoices were already exported and are locked",
      409,
      {
        lockedInvoices: alreadyExported.map((i) => ({
          id: i.id,
          vendor: i.vendor,
          exported_at: i.exported_at,
          export_id: i.export_id,
        })),
      },
    );
  }

  const notApproved = invoices.filter(
    (i) => i.status !== INVOICE_STATUS.APPROVED,
  );
  if (notApproved.length) {
    return fail("Only APPROVED invoices can be exported", 422, {
      notApproved: notApproved.map((i) => ({
        id: i.id,
        vendor: i.vendor,
        status: i.status,
      })),
    });
  }

  // Manual-review block (Brief §13).
  const { data: reviewItems } = await admin
    .from("line_items")
    .select("invoice_id")
    .in("invoice_id", invoiceIds)
    .eq("requires_review", true);
  if (reviewItems && reviewItems.length) {
    const blocking: Record<string, number> = {};
    for (const r of reviewItems as { invoice_id: string }[]) {
      blocking[r.invoice_id] = (blocking[r.invoice_id] ?? 0) + 1;
    }
    return fail(
      "Some invoices have unresolved manual-review items and cannot be exported",
      422,
      { blocking },
    );
  }

  // --- Build CSV ---
  const { data: lineItemData } = await admin
    .from("line_items")
    .select("*")
    .in("invoice_id", invoiceIds);
  const lineItemsByInvoice = new Map<string, LineItemRow[]>();
  for (const li of (lineItemData as LineItemRow[]) ?? []) {
    const arr = lineItemsByInvoice.get(li.invoice_id) ?? [];
    arr.push(li);
    lineItemsByInvoice.set(li.invoice_id, arr);
  }

  const exportInvoices: ExportInvoice[] = invoices.map((invoice) => ({
    invoice,
    lineItems: lineItemsByInvoice.get(invoice.id) ?? [],
  }));

  const { csv, rowCount } = generateQboBillsCsv(exportInvoices);
  const fileName = buildExportFilename();
  const filePath = await uploadExport(csv, fileName);

  // --- Persist export + lock invoices ---
  const { data: exportRow, error: exportErr } = await admin
    .from("exports")
    .insert({
      exported_by: profile.id,
      invoice_ids: invoiceIds,
      file_name: fileName,
      row_count: rowCount,
      file_url: filePath,
    })
    .select("*")
    .single();
  if (exportErr) throw new Error(exportErr.message);

  const exportedAt = new Date().toISOString();
  await admin
    .from("invoices")
    .update({
      status: INVOICE_STATUS.EXPORTED,
      exported_at: exportedAt,
      export_id: exportRow.id,
    })
    .in("id", invoiceIds);

  for (const invoice of invoices) {
    await writeAudit({
      invoiceId: invoice.id,
      userId: profile.id,
      action: AUDIT_ACTION.EXPORTED,
      prevValue: { status: invoice.status },
      newValue: { status: INVOICE_STATUS.EXPORTED, export_id: exportRow.id },
      note: `Exported to ${fileName}`,
    });
  }

  return ok(
    {
      exportId: exportRow.id,
      fileName,
      rowCount,
      invoiceCount: invoices.length,
      csv,
    },
    201,
  );
});
