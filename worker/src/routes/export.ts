import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "./helpers";
import { user, isStaffOrAdmin } from "./helpers";
import { audit } from "../lib/db";
import {
  generateQboBillsCsv,
  generateQboBillFactor,
  buildExportFilename,
  buildFactorFilename,
  type ExportInvoice,
} from "../lib/export";
import { findVendorMapping, loadVendorMappings } from "../lib/rules";
import { uuid, nowIso } from "../lib/util";
import { INVOICE_STATUS, AUDIT_ACTION } from "../lib/constants";
import type {
  InvoiceRow,
  LineItemRow,
  UserRow,
  InvoiceAllocationRow,
} from "../lib/types";

export const exportRoutes = new Hono<AppEnv>();

/**
 * Shared validation + assembly for the export endpoints (CSV and factor). On
 * success returns the assembled ExportInvoice[] (with the original invoice rows
 * and the resolved invoiceIds). On failure returns a ready JSON `Response` that
 * the caller should return verbatim, so POST / and POST /factor can't drift.
 */
async function assembleExportInvoices(
  c: Context<AppEnv>,
): Promise<
  | { ok: true; invoices: InvoiceRow[]; invoiceIds: string[]; exportInvoices: ExportInvoice[] }
  | { ok: false; response: Response }
> {
  const body = await c.req.json().catch(() => ({}));
  const invoiceIds = (body as { invoiceIds?: string[] }).invoiceIds;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0)
    return { ok: false, response: c.json({ error: "Provide at least one invoiceId" }, 400) };

  const ph = invoiceIds.map(() => "?").join(",");
  const invRows = await c.env.DB.prepare(
    `SELECT * FROM invoices WHERE id IN (${ph})`,
  ).bind(...invoiceIds).all<InvoiceRow>();
  const invoices = invRows.results ?? [];
  if (invoices.length !== invoiceIds.length)
    return { ok: false, response: c.json({ error: "One or more invoices not found" }, 404) };

  const exported = invoices.filter((i) => i.status === INVOICE_STATUS.EXPORTED);
  if (exported.length)
    return {
      ok: false,
      response: c.json(
        { error: "One or more invoices were already exported and are locked", lockedInvoices: exported.map((i) => ({ id: i.id, vendor: i.vendor, exported_at: i.exported_at })) },
        409,
      ),
    };
  const notApproved = invoices.filter((i) => i.status !== INVOICE_STATUS.APPROVED);
  if (notApproved.length)
    return {
      ok: false,
      response: c.json(
        { error: "Only APPROVED invoices can be exported", notApproved: notApproved.map((i) => ({ id: i.id, vendor: i.vendor, status: i.status })) },
        422,
      ),
    };

  const reviews = await c.env.DB.prepare(
    `SELECT invoice_id FROM line_items WHERE requires_review = 1 AND invoice_id IN (${ph})`,
  ).bind(...invoiceIds).all<{ invoice_id: string }>();
  if ((reviews.results ?? []).length) {
    const blocking: Record<string, number> = {};
    for (const r of reviews.results ?? []) blocking[r.invoice_id] = (blocking[r.invoice_id] ?? 0) + 1;
    return { ok: false, response: c.json({ error: "Some invoices have unresolved manual-review items", blocking }, 422) };
  }

  const liRows = await c.env.DB.prepare(
    `SELECT * FROM line_items WHERE invoice_id IN (${ph})`,
  ).bind(...invoiceIds).all<LineItemRow>();
  const byInvoice = new Map<string, LineItemRow[]>();
  for (const li of liRows.results ?? []) {
    const arr = byInvoice.get(li.invoice_id) ?? [];
    arr.push(li);
    byInvoice.set(li.invoice_id, arr);
  }

  // Tolerate a pre-migration DB (no invoice_allocations table yet): treat as
  // "no allocations" so export keeps working until the migration is applied.
  const allocByInvoice = new Map<string, InvoiceAllocationRow[]>();
  try {
    const allocRows = await c.env.DB.prepare(
      `SELECT * FROM invoice_allocations WHERE invoice_id IN (${ph})`,
    ).bind(...invoiceIds).all<InvoiceAllocationRow>();
    for (const a of allocRows.results ?? []) {
      const arr = allocByInvoice.get(a.invoice_id) ?? [];
      arr.push(a);
      allocByInvoice.set(a.invoice_id, arr);
    }
  } catch {
    // invoice_allocations table not present yet — proceed with no allocations.
  }

  const vendorMappings = await loadVendorMappings(c.env);
  const exportInvoices: ExportInvoice[] = invoices.map((invoice) => ({
    invoice,
    lineItems: byInvoice.get(invoice.id) ?? [],
    allocations: allocByInvoice.get(invoice.id) ?? [],
    vendorMapping: findVendorMapping(invoice.vendor, vendorMappings),
  }));

  return { ok: true, invoices, invoiceIds, exportInvoices };
}

/** Marks invoices EXPORTED + writes an audit entry for the given export. */
async function finalizeExport(
  c: Context<AppEnv>,
  invoices: InvoiceRow[],
  invoiceIds: string[],
  exportId: string,
  fileName: string,
): Promise<void> {
  const ph = invoiceIds.map(() => "?").join(",");
  const at = nowIso();
  await c.env.DB.prepare(
    `UPDATE invoices SET status=?, exported_at=?, export_id=? WHERE id IN (${ph})`,
  ).bind(INVOICE_STATUS.EXPORTED, at, exportId, ...invoiceIds).run();

  for (const invoice of invoices) {
    await audit(c.env, {
      invoiceId: invoice.id, userId: user(c).id, action: AUDIT_ACTION.EXPORTED,
      prevValue: { status: invoice.status },
      newValue: { status: INVOICE_STATUS.EXPORTED, export_id: exportId },
      note: `Exported to ${fileName}`,
    });
  }
}

// GET / — export history
exportRoutes.get("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const rows = await c.env.DB.prepare(
    "SELECT id, exported_by, exported_at, invoice_ids, file_name, row_count FROM exports ORDER BY exported_at DESC LIMIT 100",
  ).all<{ id: string; exported_by: string; exported_at: string; invoice_ids: string; file_name: string; row_count: number }>();

  const list = rows.results ?? [];
  const ids = Array.from(new Set(list.map((r) => r.exported_by).filter(Boolean)));
  const nameById: Record<string, string> = {};
  if (ids.length) {
    const us = await c.env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<Pick<UserRow, "id" | "name">>();
    for (const u of us.results ?? []) nameById[u.id] = u.name;
  }
  return c.json({
    exports: list.map((e) => ({
      ...e,
      invoice_ids: JSON.parse(e.invoice_ids || "[]"),
      exported_by_name: nameById[e.exported_by] ?? "—",
    })),
  });
});

// GET /:id — re-download
exportRoutes.get("/:id", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const row = await c.env.DB.prepare(
    "SELECT file_name, content FROM exports WHERE id = ?",
  ).bind(c.req.param("id")).first<{ file_name: string; content: string }>();
  if (!row) return c.json({ error: "Export not found" }, 404);
  return new Response(row.content, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${row.file_name}"`,
    },
  });
});

// POST / — generate CSV
exportRoutes.post("/", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);

  const assembled = await assembleExportInvoices(c);
  if (!assembled.ok) return assembled.response;
  const { invoices, invoiceIds, exportInvoices } = assembled;

  const { csv, rowCount } = generateQboBillsCsv(exportInvoices);
  const fileName = buildExportFilename();
  const exportId = uuid();
  await c.env.DB.prepare(
    "INSERT INTO exports (id, exported_by, invoice_ids, file_name, row_count, content) VALUES (?,?,?,?,?,?)",
  ).bind(exportId, user(c).id, JSON.stringify(invoiceIds), fileName, rowCount, csv).run();

  await finalizeExport(c, invoices, invoiceIds, exportId, fileName);

  return c.json({ exportId, fileName, rowCount, invoiceCount: invoices.length, csv }, 201);
});

// POST /factor — generate multi-entity QBO bill-import sheets (structured JSON)
exportRoutes.post("/factor", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);

  const assembled = await assembleExportInvoices(c);
  if (!assembled.ok) return assembled.response;
  const { invoices, invoiceIds, exportInvoices } = assembled;

  const { entities, header, totalRowCount } = generateQboBillFactor(exportInvoices);
  const fileName = buildFactorFilename();
  const exportId = uuid();

  const payload = {
    entities,
    header,
    fileName,
    totalRowCount,
    invoiceCount: invoices.length,
    exportId,
  };

  await c.env.DB.prepare(
    "INSERT INTO exports (id, exported_by, invoice_ids, file_name, row_count, content) VALUES (?,?,?,?,?,?)",
  ).bind(exportId, user(c).id, JSON.stringify(invoiceIds), fileName, totalRowCount, JSON.stringify(payload)).run();

  await finalizeExport(c, invoices, invoiceIds, exportId, fileName);

  return c.json(payload, 201);
});
