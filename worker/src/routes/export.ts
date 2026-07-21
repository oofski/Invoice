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
  droppedSplitLines,
  type ExportInvoice,
} from "../lib/export";
import { findVendorMapping, loadVendorMappings } from "../lib/rules";
import { uuid, nowIso, chunk } from "../lib/util";
import { INVOICE_STATUS, AUDIT_ACTION, REQUIRES_MANUAL_REVIEW } from "../lib/constants";
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
  const acknowledgeWarnings =
    (body as { acknowledgeWarnings?: boolean }).acknowledgeWarnings === true;
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0)
    return { ok: false, response: c.json({ error: "Provide at least one invoiceId" }, 400) };

  // D1 caps bound params at 100, so batch the invoice-id list (one `?` per id)
  // and merge the rows instead of binding all ids in a single statement.
  const invoices: InvoiceRow[] = [];
  for (const batch of chunk(invoiceIds)) {
    const ph = batch.map(() => "?").join(",");
    const invRows = await c.env.DB.prepare(
      `SELECT * FROM invoices WHERE id IN (${ph})`,
    ).bind(...batch).all<InvoiceRow>();
    invoices.push(...(invRows.results ?? []));
  }
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

  // FIX-11 (v1.6.0): HARD-BLOCK (422) only for the REQUIRES_MANUAL_REVIEW sentinel
  // category — those lines have no real account number to export. All other review
  // flags (concrete-category requires_review, ambiguity, reconciliation) only WARN.
  // Batch the id list (one `?` per id + the gl_category param). Each invoice_id
  // lives in exactly one batch, so the per-batch GROUP BY rows just concatenate.
  // v1.9.7 (bug #14): allocation-based splits (QUICK_EVEN / CUSTOM) export
  // entirely from invoice_allocations, not per-line coding — so stale line-level
  // review flags / sentinel categories on those invoices don't affect the output
  // and must not block or warn the export. Exclude them from the line guards.
  const allocSplit = new Set(
    invoices
      .filter((i) => i.split_type === "QUICK_EVEN" || i.split_type === "CUSTOM")
      .map((i) => i.id),
  );

  const blockingRows: { invoice_id: string; c: number }[] = [];
  for (const batch of chunk(invoiceIds)) {
    const ph = batch.map(() => "?").join(",");
    const blocking = await c.env.DB.prepare(
      `SELECT invoice_id, COUNT(*) AS c FROM line_items
         WHERE gl_category = ? AND invoice_id IN (${ph})
         GROUP BY invoice_id`,
    ).bind(REQUIRES_MANUAL_REVIEW, ...batch).all<{ invoice_id: string; c: number }>();
    blockingRows.push(
      ...(blocking.results ?? []).filter((r) => !allocSplit.has(r.invoice_id)),
    );
  }
  if (blockingRows.length) {
    const blockingMap: Record<string, number> = {};
    for (const r of blockingRows) blockingMap[r.invoice_id] = r.c;
    return { ok: false, response: c.json({ error: "Some invoices have unresolved manual-review items", blocking: blockingMap }, 422) };
  }

  // Load each invoice's line items once — used both by the split-drop guard
  // below and the final export assembly.
  const byInvoice = new Map<string, LineItemRow[]>();
  for (const batch of chunk(invoiceIds)) {
    const ph = batch.map(() => "?").join(",");
    const liRows = await c.env.DB.prepare(
      `SELECT * FROM line_items WHERE invoice_id IN (${ph})`,
    ).bind(...batch).all<LineItemRow>();
    for (const li of liRows.results ?? []) {
      const arr = byInvoice.get(li.invoice_id) ?? [];
      arr.push(li);
      byInvoice.set(li.invoice_id, arr);
    }
  }

  // FIX-11 (v1.6.0): WARN (409 REVIEW_FLAGS) when selected invoices carry
  // non-blocking review flags — concrete-category requires_review lines, ambiguous
  // locations, or a reconciliation gap — unless the caller acknowledged them.
  if (!acknowledgeWarnings) {
    const flagRows: { invoice_id: string; c: number }[] = [];
    for (const batch of chunk(invoiceIds)) {
      const ph = batch.map(() => "?").join(",");
      const flags = await c.env.DB.prepare(
        `SELECT invoice_id, COUNT(*) AS c FROM line_items
           WHERE requires_review = 1 AND gl_category != ? AND invoice_id IN (${ph})
           GROUP BY invoice_id`,
      ).bind(REQUIRES_MANUAL_REVIEW, ...batch).all<{ invoice_id: string; c: number }>();
      flagRows.push(
        ...(flags.results ?? []).filter((r) => !allocSplit.has(r.invoice_id)),
      );
    }
    const flaggedLines: Record<string, number> = {};
    for (const r of flagRows) flaggedLines[r.invoice_id] = r.c;

    const locationAmbiguous: string[] = [];
    const reconciliation: Record<string, number> = {};
    for (const inv of invoices) {
      if (inv.location_ambiguous) locationAmbiguous.push(inv.id);
      if (inv.reconciliation_delta != null) reconciliation[inv.id] = inv.reconciliation_delta;
    }

    // Split-drop guard (v1.8.9): a per-line split silently omits any leaf that
    // was left uncoded (no entity/location). This is a PRECISE check on the
    // actual dropped lines — it never compares to the OCR'd invoice total, so a
    // line OCR simply missed cannot false-positive. Warn with the count + $.
    const droppedLines: Record<string, { count: number; amount: number }> = {};
    for (const inv of invoices) {
      const d = droppedSplitLines(byInvoice.get(inv.id) ?? []);
      if (d.count > 0) droppedLines[inv.id] = d;
    }

    if (
      Object.keys(flaggedLines).length ||
      locationAmbiguous.length ||
      Object.keys(reconciliation).length ||
      Object.keys(droppedLines).length
    ) {
      return {
        ok: false,
        response: c.json(
          {
            warning: "REVIEW_FLAGS",
            flaggedLines,
            locationAmbiguous,
            reconciliation,
            droppedLines,
          },
          409,
        ),
      };
    }
  }

  // (line items were loaded into `byInvoice` above, before the split-drop guard)

  // Tolerate a pre-migration DB (no invoice_allocations table yet): treat as
  // "no allocations" so export keeps working until the migration is applied.
  const allocByInvoice = new Map<string, InvoiceAllocationRow[]>();
  try {
    for (const batch of chunk(invoiceIds)) {
      const ph = batch.map(() => "?").join(",");
      const allocRows = await c.env.DB.prepare(
        `SELECT * FROM invoice_allocations WHERE invoice_id IN (${ph})`,
      ).bind(...batch).all<InvoiceAllocationRow>();
      for (const a of allocRows.results ?? []) {
        const arr = allocByInvoice.get(a.invoice_id) ?? [];
        arr.push(a);
        allocByInvoice.set(a.invoice_id, arr);
      }
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

/**
 * Atomically CLAIMS the batch for export: flips each still-APPROVED invoice to
 * EXPORTED and stamps our unique exportId, guarded by `AND status='APPROVED'` so
 * two concurrent exports (or Export + Factor on the same selection) can't both
 * win. If we didn't claim every id (someone else exported one first), we roll
 * back only OUR rows (matched by exportId, race-safe) and report the conflict.
 * (v1.9.10 — H1: previously an unguarded UPDATE let the same batch book twice.)
 */
async function claimInvoicesForExport(
  c: Context<AppEnv>,
  invoiceIds: string[],
  exportId: string,
  at: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  let claimed = 0;
  for (const batch of chunk(invoiceIds)) {
    const ph = batch.map(() => "?").join(",");
    const res = await c.env.DB.prepare(
      `UPDATE invoices SET status=?, exported_at=?, export_id=?
         WHERE id IN (${ph}) AND status=?`,
    )
      .bind(INVOICE_STATUS.EXPORTED, at, exportId, ...batch, INVOICE_STATUS.APPROVED)
      .run();
    claimed += res.meta?.changes ?? 0;
  }
  if (claimed !== invoiceIds.length) {
    // Lost the race on at least one invoice — undo the ones WE just claimed
    // (only rows carrying our exportId) and tell the caller to refresh.
    await c.env.DB.prepare(
      "UPDATE invoices SET status=?, exported_at=NULL, export_id=NULL WHERE export_id=?",
    )
      .bind(INVOICE_STATUS.APPROVED, exportId)
      .run();
    return {
      ok: false,
      response: c.json(
        {
          error:
            "One or more invoices were exported by another action. Refresh and retry.",
        },
        409,
      ),
    };
  }
  return { ok: true };
}

/** Writes the EXPORTED audit entry for each invoice in a completed export. */
async function auditExports(
  c: Context<AppEnv>,
  invoices: InvoiceRow[],
  exportId: string,
  fileName: string,
): Promise<void> {
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
  for (const batch of chunk(ids)) {
    const us = await c.env.DB.prepare(
      `SELECT id, name FROM users WHERE id IN (${batch.map(() => "?").join(",")})`,
    ).bind(...batch).all<Pick<UserRow, "id" | "name">>();
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
//
// CSV exports store CSV text as `content` and stream back verbatim. Factor
// (.xlsx) exports store the structured `{entities,header,...}` JSON payload as
// `content` — the workbook is built client-side by the renderer — so for those
// we return JSON (not raw bytes under an .xlsx name, which Excel can't open).
exportRoutes.get("/:id", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const row = await c.env.DB.prepare(
    "SELECT file_name, content FROM exports WHERE id = ?",
  ).bind(c.req.param("id")).first<{ file_name: string; content: string }>();
  if (!row) return c.json({ error: "Export not found" }, 404);
  if (row.file_name.toLowerCase().endsWith(".xlsx")) {
    return new Response(row.content, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
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

  // Generate first (pure, no writes), then CLAIM the batch atomically before we
  // persist anything — so a lost race aborts with 409 instead of double-booking.
  const { csv, rowCount } = generateQboBillsCsv(exportInvoices);
  const fileName = buildExportFilename();
  const exportId = uuid();
  const claim = await claimInvoicesForExport(c, invoiceIds, exportId, nowIso());
  if (!claim.ok) return claim.response;
  await c.env.DB.prepare(
    "INSERT INTO exports (id, exported_by, invoice_ids, file_name, row_count, content) VALUES (?,?,?,?,?,?)",
  ).bind(exportId, user(c).id, JSON.stringify(invoiceIds), fileName, rowCount, csv).run();

  await auditExports(c, invoices, exportId, fileName);

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

  // Claim the batch atomically before persisting anything (see POST /).
  const claim = await claimInvoicesForExport(c, invoiceIds, exportId, nowIso());
  if (!claim.ok) return claim.response;
  await c.env.DB.prepare(
    "INSERT INTO exports (id, exported_by, invoice_ids, file_name, row_count, content) VALUES (?,?,?,?,?,?)",
  ).bind(exportId, user(c).id, JSON.stringify(invoiceIds), fileName, totalRowCount, JSON.stringify(payload)).run();

  await auditExports(c, invoices, exportId, fileName);

  return c.json(payload, 201);
});
