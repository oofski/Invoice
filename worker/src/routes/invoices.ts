import { Hono } from "hono";
import type { AppEnv } from "./helpers";
import { user, hasRole, isStaffOrAdmin, canViewInvoice } from "./helpers";
import {
  audit,
  getInvoice,
  getInvoiceWithRelations,
  reviewCounts,
  resolveApproverUser,
  hydrateInvoice,
} from "../lib/db";
import { processInvoiceAI, findDuplicate } from "../lib/process";
import { putPdf, getPdf, pdfKey } from "../lib/storage";
import { ocrPdf } from "../lib/reducto";
import { runPrompt1 } from "../lib/ai/prompts";
import { sendReminderEmail, sendRejectionEmail } from "../lib/email";
import { uuid, nowIso, parseAmount, toIsoDate, hoursSince } from "../lib/util";
import {
  AUDIT_ACTION,
  APPROVAL_STATUS,
  INVOICE_STATUS,
  OVERDUE_HOURS,
  ROLES,
} from "../lib/constants";
import type { InvoiceRow, ApprovalRow, UserRow } from "../lib/types";

export const invoices = new Hono<AppEnv>();

// ----- helper: scoped invoice list -------------------------------------
function scopeClause(c: import("hono").Context<AppEnv>): {
  clause: string;
  params: string[];
} {
  const u = user(c);
  if (u.role === ROLES.EXECUTIVE)
    return { clause: " AND approved_by = ?", params: [u.name] };
  if (u.role === ROLES.STAFF)
    return { clause: " AND submitted_by = ?", params: [u.id] };
  return { clause: "", params: [] };
}

async function withReviewCounts(c: import("hono").Context<AppEnv>, rows: InvoiceRow[]) {
  const counts = await reviewCounts(c.env, rows.map((r) => r.id));
  return rows.map((r) => ({ ...hydrateInvoice(r), review_count: counts[r.id] ?? 0 }));
}

// ----- POST /upload ----------------------------------------------------
invoices.post("/upload", async (c) => {
  const u = user(c);
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.STAFF, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  const form = await c.req.formData();
  // Type the entry explicitly so we don't depend on the ambient File type
  // (workers-types vs lib.dom differ on FormDataEntryValue).
  const file = form.get("file") as unknown as
    | { arrayBuffer(): Promise<ArrayBuffer>; name?: string }
    | string
    | null;
  const override = form.get("override") === "true";
  const submissionType =
    u.role === ROLES.STAFF
      ? "STAFF"
      : form.get("submissionType") === "STAFF"
        ? "STAFF"
        : "ACCOUNTANT";

  if (!file || typeof file === "string")
    return c.json({ error: "No file provided" }, 400);
  const buf = await file.arrayBuffer();
  const fileName = file.name ?? "invoice.pdf";

  // Reducto parse -> Prompt 1 reads the header -> duplicate check BEFORE the
  // heavier Claude steps (Prompt 2 + line-item coding). The stored parse output
  // is reused by processInvoiceAI, so the parser is not re-billed.
  const { raw, text } = await ocrPdf(c.env, buf, fileName);
  const header = await runPrompt1(c.env, text);
  const vendor = header.Vendor || "Unknown Vendor";
  const invoiceNumber = header.InvoiceNumber || `NO-INV-${Date.now()}`;
  const total = parseAmount(header.TotalAmount);

  if (!override) {
    const dup = await findDuplicate(c.env, vendor, invoiceNumber, total);
    if (dup)
      return c.json(
        {
          duplicate: true,
          existingInvoiceId: dup.id,
          vendor,
          invoice_number: invoiceNumber,
          total_amount: total,
        },
        409,
      );
  }

  const id = uuid();
  try {
    await c.env.DB.prepare(
      `INSERT INTO invoices (id, vendor, invoice_number, subtotal, sales_tax, total_amount,
         inv_date, due_date, business, class, status, has_pdf, submitted_by, submission_type, textract_raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        id,
        vendor,
        invoiceNumber,
        header.Subtotal ? parseAmount(header.Subtotal) : null,
        header.SalesTax ? parseAmount(header.SalesTax) : 0,
        total,
        toIsoDate(header.InvDate),
        toIsoDate(header.DueDate) ?? toIsoDate(header.InvDate),
        header.Business ?? null,
        header.Class ?? null,
        INVOICE_STATUS.PROCESSING,
        1,
        u.id,
        submissionType,
        JSON.stringify(raw),
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE"))
      return c.json(
        { duplicate: true, vendor, invoice_number: invoiceNumber, total_amount: total },
        409,
      );
    throw e;
  }

  const key = pdfKey(id);
  await putPdf(c.env, key, buf);
  await c.env.DB.prepare(
    "INSERT INTO pdf_files (invoice_id, file_name, mime, r2_key, size) VALUES (?,?,?,?,?)",
  )
    .bind(id, fileName, "application/pdf", key, buf.byteLength)
    .run();

  await audit(c.env, {
    invoiceId: id,
    userId: u.id,
    action: AUDIT_ACTION.INVOICE_UPLOADED,
    newValue: { vendor, invoice_number: invoiceNumber, total_amount: total, submission_type: submissionType },
    note: `Uploaded ${fileName}`,
  });

  const result = await processInvoiceAI(c.env, id, u.id);
  return c.json({ invoiceId: id, ...result }, 201);
});

// ----- POST /process ---------------------------------------------------
invoices.post("/process", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const invoiceId = (body as { invoiceId?: string }).invoiceId;
  if (!invoiceId) return c.json({ error: "invoiceId required" }, 400);
  const result = await processInvoiceAI(c.env, invoiceId, user(c).id);
  return c.json({ invoiceId, ...result });
});

// ----- GET /pending ----------------------------------------------------
invoices.get("/pending", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const approver = c.req.query("approver");
  let sql = "SELECT * FROM invoices WHERE status = ?";
  const params: string[] = [INVOICE_STATUS.PENDING_APPROVAL];
  if (approver) {
    sql += " AND approved_by = ?";
    params.push(approver);
  }
  sql += " ORDER BY created_at ASC";
  const rows = await c.env.DB.prepare(sql).bind(...params).all<InvoiceRow>();
  return c.json({ invoices: await withReviewCounts(c, rows.results ?? []) });
});

// ----- GET /overdue ----------------------------------------------------
invoices.get("/overdue", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const cutoff = new Date(Date.now() - OVERDUE_HOURS * 3_600_000).toISOString();
  const rows = await c.env.DB.prepare(
    "SELECT * FROM invoices WHERE status = ? AND created_at <= ? ORDER BY created_at ASC",
  )
    .bind(INVOICE_STATUS.PENDING_APPROVAL, cutoff)
    .all<InvoiceRow>();
  const invoicesOut = (rows.results ?? []).map((i) => ({
    ...hydrateInvoice(i),
    hours_pending: Math.round(hoursSince(i.created_at)),
  }));
  return c.json({ invoices: invoicesOut, thresholdHours: OVERDUE_HOURS });
});

// ----- POST /remind-bulk ----------------------------------------------
invoices.post("/remind-bulk", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const cutoff = new Date(Date.now() - OVERDUE_HOURS * 3_600_000).toISOString();
  const rows = await c.env.DB.prepare(
    "SELECT * FROM invoices WHERE status = ? AND created_at <= ?",
  )
    .bind(INVOICE_STATUS.PENDING_APPROVAL, cutoff)
    .all<InvoiceRow>();
  let sent = 0;
  for (const inv of rows.results ?? []) {
    if (await remindInvoice(c, inv)) sent++;
  }
  return c.json({ totalOverdue: (rows.results ?? []).length, sent });
});

// ----- GET / (list) ----------------------------------------------------
invoices.get("/", async (c) => {
  let sql = "SELECT * FROM invoices WHERE 1=1";
  const params: (string | number)[] = [];
  const { clause, params: scopeParams } = scopeClause(c);
  sql += clause;
  params.push(...scopeParams);

  const status = c.req.query("status");
  if (status) { sql += " AND status = ?"; params.push(status); }
  const entity = c.req.query("entity");
  if (entity) { sql += " AND business = ?"; params.push(entity); }
  const approver = c.req.query("approver");
  if (approver) { sql += " AND approved_by = ?"; params.push(approver); }
  const q = c.req.query("q");
  if (q) { sql += " AND vendor LIKE ?"; params.push(`%${q}%`); }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Number(c.req.query("limit") ?? 500));

  const rows = await c.env.DB.prepare(sql).bind(...params).all<InvoiceRow>();
  return c.json({ invoices: await withReviewCounts(c, rows.results ?? []) });
});

// ----- GET /:id/pdf ----------------------------------------------------
invoices.get("/:id/pdf", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, inv)) return c.json({ error: "Forbidden" }, 403);
  const meta = await c.env.DB.prepare(
    "SELECT r2_key, mime, file_name FROM pdf_files WHERE invoice_id = ?",
  )
    .bind(id)
    .first<{ r2_key: string; mime: string; file_name: string }>();
  if (!meta?.r2_key) return c.json({ error: "No PDF" }, 404);
  const obj = await getPdf(c.env, meta.r2_key);
  if (!obj) return c.json({ error: "No PDF" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": meta.mime || "application/pdf",
      "content-disposition": `inline; filename="${meta.file_name ?? "invoice.pdf"}"`,
    },
  });
});

// ----- GET /:id --------------------------------------------------------
invoices.get("/:id", async (c) => {
  const id = c.req.param("id");
  const invoice = await getInvoiceWithRelations(c.env, id, true);
  if (!invoice) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, invoice)) return c.json({ error: "Forbidden" }, 403);
  return c.json({ invoice });
});

// ----- PATCH /:id ------------------------------------------------------
invoices.patch("/:id", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.ADMIN, ROLES.EXECUTIVE))
    return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const existing = await getInvoice(c.env, id);
  if (!existing) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, existing)) return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const allowed = ["vendor", "subtotal", "sales_tax", "total_amount", "inv_date", "due_date", "business", "class", "approved_by", "status"];
  const sets: string[] = [];
  const params: unknown[] = [];
  const prev: Record<string, unknown> = {};
  for (const k of allowed) {
    if (k in body) {
      sets.push(`${k} = ?`);
      params.push(body[k]);
      prev[k] = (existing as unknown as Record<string, unknown>)[k];
    }
  }
  if (!sets.length) return c.json({ error: "No updatable fields" }, 400);
  params.push(id);
  await c.env.DB.prepare(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...params)
    .run();
  await audit(c.env, {
    invoiceId: id,
    userId: user(c).id,
    action: AUDIT_ACTION.INVOICE_UPDATED,
    prevValue: prev,
    newValue: body,
  });
  const updated = await getInvoice(c.env, id);
  return c.json({ invoice: updated && hydrateInvoice(updated) });
});

// ----- POST /:id/approve ----------------------------------------------
invoices.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  const u = user(c);
  const assigned = u.role === ROLES.EXECUTIVE && inv.approved_by === u.name;
  if (!assigned && u.role !== ROLES.ADMIN)
    return c.json({ error: "Only the assigned executive can approve" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?")
    .bind(INVOICE_STATUS.APPROVED, id)
    .run();
  await c.env.DB.prepare(
    "UPDATE approvals SET status = ?, decided_at = ? WHERE invoice_id = ?",
  )
    .bind(APPROVAL_STATUS.APPROVED, nowIso(), id)
    .run();
  await audit(c.env, {
    invoiceId: id, userId: u.id, action: AUDIT_ACTION.APPROVED,
    prevValue: { status: inv.status }, newValue: { status: INVOICE_STATUS.APPROVED },
    note: `Approved by ${u.name}`,
  });
  return c.json({ status: INVOICE_STATUS.APPROVED });
});

// ----- POST /:id/reject -----------------------------------------------
invoices.post("/:id/reject", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const note = (body as { note?: string }).note?.trim();
  if (!note) return c.json({ error: "A rejection note is required" }, 400);

  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  const u = user(c);
  const assigned = u.role === ROLES.EXECUTIVE && inv.approved_by === u.name;
  if (!assigned && u.role !== ROLES.ADMIN)
    return c.json({ error: "Only the assigned executive can reject" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?")
    .bind(INVOICE_STATUS.REJECTED, id)
    .run();
  await c.env.DB.prepare(
    "UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE invoice_id = ?",
  )
    .bind(APPROVAL_STATUS.REJECTED, note, nowIso(), id)
    .run();
  await audit(c.env, {
    invoiceId: id, userId: u.id, action: AUDIT_ACTION.REJECTED,
    prevValue: { status: inv.status }, newValue: { status: INVOICE_STATUS.REJECTED },
    note: `Rejected by ${u.name}: ${note}`,
  });

  const accountants = await c.env.DB.prepare(
    "SELECT * FROM users WHERE role = ? AND is_active = 1",
  ).bind(ROLES.ACCOUNTANT).all<UserRow>();
  for (const acc of accountants.results ?? []) {
    try {
      await sendRejectionEmail(c.env, acc.email, {
        invoiceId: id, vendor: inv.vendor, totalAmount: inv.total_amount,
        business: inv.business, dueDate: inv.due_date, invoiceNumber: inv.invoice_number,
      }, u.name, note);
    } catch (e) { console.error("[reject] email failed:", e); }
  }
  return c.json({ status: INVOICE_STATUS.REJECTED });
});

// ----- POST /:id/remind -----------------------------------------------
invoices.post("/:id/remind", async (c) => {
  if (!isStaffOrAdmin(c)) return c.json({ error: "Forbidden" }, 403);
  const inv = await getInvoice(c.env, c.req.param("id"));
  if (!inv) return c.json({ error: "Not found" }, 404);
  const sent = await remindInvoice(c, inv);
  if (!sent) return c.json({ error: "No assigned approver with an email" }, 422);
  return c.json({ sent: true });
});

// shared reminder routine
async function remindInvoice(
  c: import("hono").Context<AppEnv>,
  inv: InvoiceRow,
): Promise<boolean> {
  const approval = await c.env.DB.prepare(
    "SELECT * FROM approvals WHERE invoice_id = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(inv.id).first<ApprovalRow>();

  let recipient: UserRow | null = null;
  if (approval?.assigned_to)
    recipient = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(approval.assigned_to).first<UserRow>();
  if (!recipient && inv.approved_by)
    recipient = await resolveApproverUser(c.env, inv.approved_by);
  if (!recipient?.email) return false;

  await sendReminderEmail(c.env, recipient.email, {
    invoiceId: inv.id, vendor: inv.vendor, totalAmount: inv.total_amount,
    business: inv.business, dueDate: inv.due_date, invoiceNumber: inv.invoice_number,
  }, hoursSince(inv.created_at));

  if (approval)
    await c.env.DB.prepare(
      "UPDATE approvals SET reminder_sent_at = ?, reminder_count = reminder_count + 1 WHERE id = ?",
    ).bind(nowIso(), approval.id).run();

  await audit(c.env, {
    invoiceId: inv.id, userId: user(c).id, action: AUDIT_ACTION.REMINDER_SENT,
    note: `Reminder sent to ${recipient.name} (${recipient.email})`,
  });
  return true;
}
