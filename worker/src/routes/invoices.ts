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
import { processInvoiceAI, ingestInvoicePdf } from "../lib/process";
import { getPdf, deletePdf } from "../lib/storage";
import { sendReminderEmail, sendRejectionEmail } from "../lib/email";
import { nowIso, hoursSince, sameName, uuid } from "../lib/util";
import {
  findVendorMapping,
  loadVendorMappings,
  resolveGlAccount,
} from "../lib/rules";
import {
  AUDIT_ACTION,
  APPROVAL_STATUS,
  BUSINESS_CLASSES,
  INVOICE_STATUS,
  OVERDUE_HOURS,
  ROLES,
} from "../lib/constants";
import type {
  InvoiceRow,
  ApprovalRow,
  UserRow,
  InvoiceAllocationRow,
} from "../lib/types";

export const invoices = new Hono<AppEnv>();

// ----- helper: scoped invoice list -------------------------------------
function scopeClause(c: import("hono").Context<AppEnv>): {
  clause: string;
  params: string[];
} {
  const u = user(c);
  if (u.role === ROLES.EXECUTIVE)
    // Case-insensitive / whitespace-tolerant so "Lisa" matches "lisa" / "Lisa ".
    return { clause: " AND lower(trim(approved_by)) = lower(trim(?))", params: [u.name] };
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

  const result = await ingestInvoicePdf(c.env, {
    buf,
    fileName,
    submittedBy: u.id,
    submissionType,
    override,
  });
  if (result.duplicate) return c.json(result, 409);
  return c.json(result, 201);
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
  const invoice = await getInvoiceWithRelations(c.env, id, true, user(c).role);
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

// ----- DELETE /:id (admin only) ---------------------------------------
invoices.delete("/:id", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);

  // Remove the PDF from R2 (best effort), then delete the invoice row. The
  // pdf_files / line_items / approvals rows cascade via ON DELETE CASCADE.
  const meta = await c.env.DB.prepare(
    "SELECT r2_key FROM pdf_files WHERE invoice_id = ?",
  )
    .bind(id)
    .first<{ r2_key: string }>();
  if (meta?.r2_key) {
    try {
      await deletePdf(c.env, meta.r2_key);
    } catch (e) {
      console.error("[delete] R2 delete failed:", e);
    }
  }
  await c.env.DB.prepare("DELETE FROM invoices WHERE id = ?").bind(id).run();

  await audit(c.env, {
    invoiceId: id,
    userId: user(c).id,
    action: AUDIT_ACTION.INVOICE_DELETED,
    prevValue: {
      vendor: inv.vendor,
      invoice_number: inv.invoice_number,
      total_amount: inv.total_amount,
      status: inv.status,
    },
    note: `Invoice deleted by ${user(c).name}`,
  });
  return c.json({ ok: true });
});

// ----- POST /:id/approve ----------------------------------------------
invoices.post("/:id/approve", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  const u = user(c);
  const assigned = u.role === ROLES.EXECUTIVE && sameName(inv.approved_by, u.name);
  if (!assigned && u.role !== ROLES.ADMIN)
    return c.json({ error: "Only the assigned executive can approve" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  const body = await c.req.json().catch(() => ({}));
  const comment = (body as { comment?: string }).comment?.trim();

  await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?")
    .bind(INVOICE_STATUS.APPROVED, id)
    .run();
  if (comment) {
    await c.env.DB.prepare(
      "UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE invoice_id = ?",
    )
      .bind(APPROVAL_STATUS.APPROVED, comment, nowIso(), id)
      .run();
  } else {
    await c.env.DB.prepare(
      "UPDATE approvals SET status = ?, decided_at = ? WHERE invoice_id = ?",
    )
      .bind(APPROVAL_STATUS.APPROVED, nowIso(), id)
      .run();
  }
  await audit(c.env, {
    invoiceId: id, userId: u.id, action: AUDIT_ACTION.APPROVED,
    prevValue: { status: inv.status }, newValue: { status: INVOICE_STATUS.APPROVED },
    note: comment ? `Approved by ${u.name}: ${comment}` : `Approved by ${u.name}`,
  });
  return c.json({ status: INVOICE_STATUS.APPROVED });
});

// ----- shared: gate split routes to assigned executive or admin ---------
function canSplit(c: import("hono").Context<AppEnv>, inv: InvoiceRow): boolean {
  const u = user(c);
  if (u.role === ROLES.ADMIN) return true;
  return u.role === ROLES.EXECUTIVE && sameName(inv.approved_by, u.name);
}

/** Rounds to cents (2 dp). */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

// ----- POST /:id/split-even -------------------------------------------
invoices.post("/:id/split-even", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canSplit(c, inv))
    return c.json({ error: "Only the assigned executive can split" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  const classes = BUSINESS_CLASSES[inv.business ?? ""] ?? [];
  if (classes.length < 2)
    return c.json(
      { error: "Nothing to split — this business has a single class" },
      400,
    );

  const vendorMapping = findVendorMapping(
    inv.vendor,
    await loadVendorMappings(c.env),
  );
  const glAccount = resolveGlAccount(vendorMapping);

  // Clear any existing split state.
  await c.env.DB.prepare(
    "DELETE FROM invoice_allocations WHERE invoice_id = ?",
  ).bind(id).run();
  await c.env.DB.prepare(
    "UPDATE line_items SET business = NULL, class = NULL WHERE invoice_id = ?",
  ).bind(id).run();

  const n = classes.length;
  const total = inv.total_amount;
  const per = roundCents(total / n);
  const pct = roundCents(100 / n);

  const allocations: InvoiceAllocationRow[] = [];
  let runningSum = 0;
  const at = nowIso();
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    // Last row absorbs the rounding remainder so the sum equals total exactly.
    const amount = isLast ? roundCents(total - runningSum) : per;
    runningSum = roundCents(runningSum + amount);
    const row: InvoiceAllocationRow = {
      id: uuid(),
      invoice_id: id,
      business: inv.business ?? "",
      class: classes[i],
      percentage: pct,
      amount,
      gl_account: glAccount,
      source: "QUICK_EVEN",
      created_at: at,
    };
    allocations.push(row);
    await c.env.DB.prepare(
      `INSERT INTO invoice_allocations
         (id, invoice_id, business, class, percentage, amount, gl_account, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id, row.invoice_id, row.business, row.class,
        row.percentage, row.amount, row.gl_account, row.source, row.created_at,
      )
      .run();
  }

  await c.env.DB.prepare("UPDATE invoices SET split_type = ? WHERE id = ?")
    .bind("QUICK_EVEN", id)
    .run();

  await audit(c.env, {
    invoiceId: id, userId: user(c).id, action: AUDIT_ACTION.INVOICE_SPLIT,
    newValue: { split_type: "QUICK_EVEN", classes },
    note: `Even split across ${n} classes by ${user(c).name}`,
  });

  return c.json({ allocations });
});

// ----- POST /:id/split-lines ------------------------------------------
invoices.post("/:id/split-lines", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canSplit(c, inv))
    return c.json({ error: "Only the assigned executive can split" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  const body = await c.req.json().catch(() => ({}));
  const lines = (body as {
    lines?: { lineItemId: string; business: string; class: string }[];
  }).lines;
  if (!Array.isArray(lines) || lines.length === 0)
    return c.json({ error: "lines required" }, 400);

  // Validate every line first (all-or-nothing).
  for (const l of lines) {
    const valid = BUSINESS_CLASSES[l.business] ?? [];
    if (!valid.includes(l.class))
      return c.json(
        { error: `Invalid class "${l.class}" for business "${l.business}"` },
        400,
      );
  }

  for (const l of lines) {
    await c.env.DB.prepare(
      "UPDATE line_items SET business = ?, class = ? WHERE id = ? AND invoice_id = ?",
    )
      .bind(l.business, l.class, l.lineItemId, id)
      .run();
  }

  // Per-line splits supersede any quick-even allocations.
  await c.env.DB.prepare(
    "DELETE FROM invoice_allocations WHERE invoice_id = ?",
  ).bind(id).run();

  await c.env.DB.prepare("UPDATE invoices SET split_type = ? WHERE id = ?")
    .bind("PER_LINE", id)
    .run();

  await audit(c.env, {
    invoiceId: id, userId: user(c).id, action: AUDIT_ACTION.INVOICE_SPLIT,
    newValue: { split_type: "PER_LINE", lines },
    note: `Per-line split (${lines.length} lines) by ${user(c).name}`,
  });

  return c.json({ ok: true });
});

// ----- DELETE /:id/split ----------------------------------------------
invoices.delete("/:id/split", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canSplit(c, inv))
    return c.json({ error: "Only the assigned executive can split" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  await c.env.DB.prepare(
    "DELETE FROM invoice_allocations WHERE invoice_id = ?",
  ).bind(id).run();
  await c.env.DB.prepare(
    "UPDATE line_items SET business = NULL, class = NULL WHERE invoice_id = ?",
  ).bind(id).run();
  await c.env.DB.prepare("UPDATE invoices SET split_type = NULL WHERE id = ?")
    .bind(id)
    .run();

  await audit(c.env, {
    invoiceId: id, userId: user(c).id, action: AUDIT_ACTION.SPLIT_CLEARED,
    prevValue: { split_type: inv.split_type },
    note: `Split cleared by ${user(c).name}`,
  });

  return c.json({ ok: true });
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
  const assigned = u.role === ROLES.EXECUTIVE && sameName(inv.approved_by, u.name);
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
