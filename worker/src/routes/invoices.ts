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
import { getPdf, deletePdf, getReductoRaw } from "../lib/storage";
import {
  sendReminderEmail,
  sendRejectionEmail,
  sendApproverDigestEmail,
  sendApprovalEmail,
  sendManualReviewEmail,
  emailConfigured,
} from "../lib/email";
import { nowIso, hoursSince, sameName, uuid } from "../lib/util";
import {
  findVendorMapping,
  loadVendorMappings,
  resolveGlAccount,
  routeApprover,
  codeLineItem,
} from "../lib/rules";
import {
  AUDIT_ACTION,
  APPROVAL_STATUS,
  APPROVERS,
  BUSINESS_CLASSES,
  BUSINESS_ENTITIES,
  CONFIDENCE_LEVEL,
  INVOICE_STATUS,
  OVERDUE_HOURS,
  REQUIRES_MANUAL_REVIEW,
  ROLES,
  TYPE_GL,
  isCategoryValidForEntity,
  type BusinessEntity,
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
  // `rescan` (v1.2.1) forces a fresh OCR read of the PDF (re-bills the parser)
  // instead of re-running the rules over the cached extraction.
  const rescan = (body as { rescan?: boolean }).rescan === true;
  const result = await processInvoiceAI(c.env, invoiceId, user(c).id, { rescan });
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

// ----- GET /:id/suggest-approver --------------------------------------
// Feature A (v1.1.7): when an accountant/admin edits an invoice's
// business/class, suggest the approver the routing rules would pick so the
// edit form can pre-fill it (still editable). Registered BEFORE GET /:id so
// it isn't shadowed (mirrors the /:id/pdf-before-/:id pattern).
invoices.get("/:id/suggest-approver", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, inv)) return c.json({ error: "Forbidden" }, 403);

  const business = c.req.query("business");
  if (!business || !(BUSINESS_ENTITIES as readonly string[]).includes(business))
    return c.json({ error: `Invalid business "${business ?? ""}"` }, 400);
  // class is accepted for validation / forward-compat only — routeApprover keys
  // on business, not class. Validate it (when present) against the business.
  const klass = c.req.query("class");
  if (klass) {
    const valid = BUSINESS_CLASSES[business] ?? [];
    if (!valid.includes(klass))
      return c.json(
        { error: `Invalid class "${klass}" for business "${business}"` },
        400,
      );
  }

  const vendorMapping = findVendorMapping(
    inv.vendor,
    await loadVendorMappings(c.env),
  );
  const liRows = await c.env.DB.prepare(
    "SELECT description, gl_category, amount FROM line_items WHERE invoice_id = ?",
  )
    .bind(id)
    .all<{ description: string | null; gl_category: string | null; amount: number | null }>();
  const lines = liRows.results ?? [];
  const descriptions = lines.map((l) => l.description ?? "").filter(Boolean);
  const glCategories = lines
    .map((l) => l.gl_category ?? "")
    .filter(Boolean);

  const { approver, logic } = routeApprover({
    business: business as BusinessEntity,
    vendor: inv.vendor,
    vendorMapping,
    total: inv.total_amount,
    descriptions,
    glCategories,
    salesTaxPresent: (inv.sales_tax ?? 0) > 0,
  });
  return c.json({ approver, logic });
});

// ----- POST /:id/reroute ----------------------------------------------
// Feature A (v1.1.7): accountant/admin saves edited routing → reassign the
// invoice's business/class/approver, reset it to PENDING_APPROVAL, rebuild the
// approvals row (clearing any prior decision so no stale banner), email the new
// approver (best-effort), and audit. Executives are excluded. Registered BEFORE
// GET /:id / PATCH /:id so it isn't shadowed.
invoices.post("/:id/reroute", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, inv)) return c.json({ error: "Forbidden" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as {
    business?: string;
    class?: string;
    approved_by?: string;
  };
  const business = body.business;
  if (!business || !(BUSINESS_ENTITIES as readonly string[]).includes(business))
    return c.json({ error: `Invalid business "${business ?? ""}"` }, 400);
  // class is optional; when given it must belong to the (new) business.
  let klass: string | null = inv.class;
  if (body.class !== undefined) {
    if (body.class) {
      const valid = BUSINESS_CLASSES[business] ?? [];
      if (!valid.includes(body.class))
        return c.json(
          { error: `Invalid class "${body.class}" for business "${business}"` },
          400,
        );
    }
    klass = body.class || null;
  }
  const approvedBy = body.approved_by?.trim();
  if (!approvedBy || !(APPROVERS as readonly string[]).includes(approvedBy))
    return c.json({ error: `Invalid approver "${approvedBy ?? ""}"` }, 400);

  const approverUser = await resolveApproverUser(c.env, approvedBy);

  await c.env.DB.prepare(
    "UPDATE invoices SET business = ?, class = ?, approved_by = ?, status = ? WHERE id = ?",
  )
    .bind(business, klass, approvedBy, INVOICE_STATUS.PENDING_APPROVAL, id)
    .run();

  // Rebuild the approvals row from scratch so any prior decision_note /
  // decided_at / reminder_* is cleared (no stale rejection/manual-review banner).
  await c.env.DB.prepare("DELETE FROM approvals WHERE invoice_id = ?")
    .bind(id)
    .run();
  await c.env.DB.prepare(
    "INSERT INTO approvals (id, invoice_id, assigned_to, assigned_to_name, status) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(uuid(), id, approverUser?.id ?? null, approvedBy, APPROVAL_STATUS.PENDING)
    .run();

  // Best-effort: notify the new approver. send() never throws.
  let emailed = false;
  if (approverUser?.email) {
    const result = await sendApprovalEmail(c.env, approverUser.email, {
      invoiceId: id,
      vendor: inv.vendor,
      totalAmount: inv.total_amount,
      business,
      dueDate: inv.due_date,
      invoiceNumber: inv.invoice_number,
    });
    emailed = result.ok;
  }

  const u = user(c);
  await audit(c.env, {
    invoiceId: id,
    userId: u.id,
    action: AUDIT_ACTION.INVOICE_REROUTED,
    prevValue: {
      business: inv.business,
      class: inv.class,
      approved_by: inv.approved_by,
      status: inv.status,
    },
    newValue: {
      business,
      class: klass,
      approved_by: approvedBy,
      status: INVOICE_STATUS.PENDING_APPROVAL,
    },
    note: `Re-routed to ${approvedBy} by ${u.name}`,
  });

  const updated = await getInvoice(c.env, id);
  return c.json({
    invoice: updated && hydrateInvoice(updated),
    approver: approvedBy,
    emailed,
    emailConfigured: emailConfigured(c.env),
  });
});

// ----- GET /approvers/pending-counts ----------------------------------
// Exec/admin digest support: how many PENDING_APPROVAL invoices each distinct
// approver name carries, plus whether that name maps to an active, emailable
// user. Counts are computed case-/whitespace-insensitively on approved_by.
invoices.get("/approvers/pending-counts", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.EXECUTIVE, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  // Group pending invoices by normalized approver, but keep one representative
  // raw name per group so we can resolve it to a user.
  const rows = await c.env.DB.prepare(
    `SELECT trim(approved_by) AS name,
            lower(trim(approved_by)) AS norm,
            COUNT(*) AS c
       FROM invoices
      WHERE status = ? AND approved_by IS NOT NULL AND trim(approved_by) <> ''
      GROUP BY lower(trim(approved_by))`,
  )
    .bind(INVOICE_STATUS.PENDING_APPROVAL)
    .all<{ name: string; norm: string; c: number }>();

  const approvers = [];
  for (const r of rows.results ?? []) {
    const u = await resolveApproverUser(c.env, r.name);
    const reachable = !!u?.email;
    approvers.push({
      name: r.name,
      userId: u?.id ?? null,
      email: u?.email ?? null,
      pendingCount: r.c,
      reachable,
    });
  }
  approvers.sort((a, b) => b.pendingCount - a.pendingCount);
  return c.json({ approvers });
});

// ----- POST /remind-approvers -----------------------------------------
// Exec/admin sends a digest email to chosen approvers. Pending counts are
// RE-COUNTED server-side per recipient (never trusts client counts); recipients
// with no resolvable email or zero pending are skipped (counted as failed).
invoices.post("/remind-approvers", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.EXECUTIVE, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    recipients?: { userId?: string; name?: string }[];
    note?: string;
  };
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (recipients.length === 0)
    return c.json({ error: "At least one recipient is required" }, 400);
  const note = body.note?.trim() || undefined;
  const configured = emailConfigured(c.env);

  let sent = 0;
  let failed = 0;
  const results: { name: string; ok: boolean; reason?: string }[] = [];

  for (const r of recipients) {
    // Resolve to an active user: by id first, else by name.
    let target: UserRow | null = null;
    if (r.userId) {
      target = await c.env.DB.prepare(
        "SELECT * FROM users WHERE id = ? AND is_active = 1",
      )
        .bind(r.userId)
        .first<UserRow>();
    }
    if (!target && r.name) target = await resolveApproverUser(c.env, r.name);

    const label = target?.name ?? r.name ?? r.userId ?? "Unknown";
    if (!target?.email) {
      failed++;
      results.push({ name: label, ok: false, reason: "No active user with an email" });
      continue;
    }

    // RE-COUNT this approver's pending invoices server-side.
    const countRow = await c.env.DB.prepare(
      "SELECT COUNT(*) AS c FROM invoices WHERE status = ? AND lower(trim(approved_by)) = lower(trim(?))",
    )
      .bind(INVOICE_STATUS.PENDING_APPROVAL, target.name)
      .first<{ c: number }>();
    const pendingCount = countRow?.c ?? 0;
    if (pendingCount === 0) {
      failed++;
      results.push({ name: target.name, ok: false, reason: "No pending invoices" });
      continue;
    }

    // send() never throws — it returns an EmailResult we inspect for honesty.
    const result = await sendApproverDigestEmail(
      c.env,
      target.email,
      target.name,
      pendingCount,
      note,
    );
    if (!result.ok) {
      failed++;
      // No audit on not_configured — nothing was actually sent or attempted.
      results.push({
        name: target.name,
        ok: false,
        reason:
          result.reason === "not_configured"
            ? "Email not configured"
            : "Email send failed",
      });
      continue;
    }
    sent++;
    results.push({ name: target.name, ok: true });
    await audit(c.env, {
      invoiceId: null,
      userId: user(c).id,
      action: AUDIT_ACTION.REMINDER_SENT,
      note: `Approver digest sent to ${target.name} (${target.email}) — ${pendingCount} pending${note ? `: ${note}` : ""}`,
    });
  }

  return c.json({ sent, failed, emailConfigured: configured, results });
});

// ----- GET /:id/extract-raw (admin only) ------------------------------
// v1.1.8 A: streams the RAW Reducto /extract response stored as an R2 sidecar
// next to the PDF (for diagnosing extraction issues). Admin-only. 404 when the
// sidecar is absent (e.g. invoices ingested before v1.1.8, or no PDF). Registered
// BEFORE GET /:id so the literal suffix isn't shadowed by the :id param route.
invoices.get("/:id/extract-raw", async (c) => {
  if (!hasRole(c, ROLES.ADMIN)) return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);

  const meta = await c.env.DB.prepare(
    "SELECT r2_key FROM pdf_files WHERE invoice_id = ?",
  )
    .bind(id)
    .first<{ r2_key: string }>();
  if (!meta?.r2_key) return c.json({ error: "No raw extract" }, 404);
  const obj = await getReductoRaw(c.env, meta.r2_key);
  if (!obj) return c.json({ error: "No raw extract" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition": `inline; filename="${id}.reducto.json"`,
    },
  });
});

// ----- POST /:id/line-items (accountant/admin) ------------------------
// v1.1.8 I: accountant/admin manually adds a line item to an invoice (e.g. a
// line the extractor missed, flagged by the reconciliation guard). Body:
// { description?, amount (number, may be negative), business?, class?, gl_category? }.
// When gl_category is omitted, codeLineItem suggests one server-side. The category
// is entity-validated. Inserts at sort_order = max+1, manually_overridden=1,
// logic_path='MANUAL ADD'. 404 unknown; canViewInvoice; 409 if EXPORTED. Registered
// BEFORE GET/PATCH /:id so the literal suffix isn't shadowed.
invoices.post("/:id/line-items", async (c) => {
  if (!hasRole(c, ROLES.ACCOUNTANT, ROLES.ADMIN))
    return c.json({ error: "Forbidden" }, 403);
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canViewInvoice(c, inv)) return c.json({ error: "Forbidden" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);

  const body = (await c.req.json().catch(() => ({}))) as {
    description?: string;
    amount?: number;
    business?: string;
    class?: string;
    gl_category?: string;
  };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount))
    return c.json({ error: "A numeric amount is required" }, 400);
  const description = (body.description ?? "").trim() || "(no description)";

  // The line's entity defaults to the invoice's business unless overridden.
  // Validate business/class against the canonical lists when supplied.
  let business: string | null = inv.business;
  if (body.business !== undefined) {
    if (body.business && !(BUSINESS_ENTITIES as readonly string[]).includes(body.business))
      return c.json({ error: `Invalid business "${body.business}"` }, 400);
    business = body.business || null;
  }
  let klass: string | null = inv.class;
  if (body.class !== undefined) {
    if (body.class) {
      const valid = BUSINESS_CLASSES[business ?? ""] ?? [];
      if (!valid.includes(body.class))
        return c.json(
          { error: `Invalid class "${body.class}" for business "${business ?? ""}"` },
          400,
        );
    }
    klass = body.class || null;
  }
  const entity = business ?? inv.business;

  // Resolve the GL category: explicit (validated) or coded server-side.
  let category: string;
  if (body.gl_category) {
    if (!isCategoryValidForEntity(entity, body.gl_category))
      return c.json({ error: `Invalid GL category "${body.gl_category}"` }, 400);
    category = body.gl_category;
  } else {
    const vendorMapping = findVendorMapping(
      inv.vendor,
      await loadVendorMappings(c.env),
    );
    const coded = codeLineItem({
      description,
      vendor: inv.vendor,
      vendorMapping,
      business: (entity ?? "Admin") as BusinessEntity,
      salesTaxPresent: (inv.sales_tax ?? 0) > 0,
      amount,
    });
    category = coded.category;
  }

  const stillReview = category === REQUIRES_MANUAL_REVIEW;
  const requiresReview = stillReview ? 1 : 0;
  const confidence = stillReview
    ? CONFIDENCE_LEVEL.MANUAL_REVIEW
    : CONFIDENCE_LEVEL.HIGH;

  // Persist business/class on the new line ONLY when the invoice is already a
  // per-line split — i.e. every existing leaf line already carries business AND
  // class. The export PER_LINE detector (export.ts) flips to per-line mode when
  // ANY leaf carries business/class and then emits ONLY those leaves, so writing
  // business/class onto a lone added line of an otherwise header-coded invoice
  // would silently drop every AI-coded line from the QBO export. The invariant is
  // "all leaves carry business/class, or none do" — honor it here so a normal
  // (header/even-split) invoice keeps the added line at NULL business/class.
  const existing = await c.env.DB.prepare(
    "SELECT id, split_parent_id, business, class, sort_order FROM line_items WHERE invoice_id = ?",
  )
    .bind(id)
    .all<{
      id: string;
      split_parent_id: string | null;
      business: string | null;
      class: string | null;
      sort_order: number | null;
    }>();
  const existingRows = existing.results ?? [];
  const parentIds = new Set(
    existingRows.map((r) => r.split_parent_id).filter((x): x is string => !!x),
  );
  const existingLeaves = existingRows.filter((r) => !parentIds.has(r.id));
  const isPerLineSplit =
    existingLeaves.length > 0 && existingLeaves.every((r) => r.business && r.class);
  const lineBusiness = isPerLineSplit ? business : null;
  const lineClass = isPerLineSplit ? klass : null;

  // Append after the current lines.
  const sortOrder =
    existingRows.reduce((m, r) => Math.max(m, r.sort_order ?? 0), -1) + 1;

  const lineId = uuid();
  await c.env.DB.prepare(
    `INSERT INTO line_items (id, invoice_id, description, amount, business, class,
       gl_category, confidence_level, logic_path, requires_review,
       manually_overridden, overridden_by, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      lineId,
      id,
      description,
      amount,
      lineBusiness,
      lineClass,
      category,
      confidence,
      "MANUAL ADD",
      requiresReview,
      1,
      user(c).id,
      sortOrder,
    )
    .run();

  await audit(c.env, {
    invoiceId: id,
    userId: user(c).id,
    action: AUDIT_ACTION.LINE_ITEM_ADDED,
    newValue: { description, amount, gl_category: category, business: lineBusiness, class: lineClass },
    note: `${user(c).name} added line "${description}" (${amount.toFixed(2)}) → ${category}`,
  });

  return c.json({ ok: true, id: lineId }, 201);
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
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

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

/** True once the split DB migration (invoice_allocations table) has been run. */
async function splitReady(env: AppEnv["Bindings"]): Promise<boolean> {
  try {
    await env.DB.prepare("SELECT 1 FROM invoice_allocations LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
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
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

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

// ----- POST /:id/split-allocations ------------------------------------
// Flexible cross-entity percentage split: fans an invoice across ANY
// entity+class targets (e.g. an IBW invoice 1/3 to Chicago). Unlike split-even
// (own-business classes only), each allocation names its own business + class.
invoices.post("/:id/split-allocations", async (c) => {
  const id = c.req.param("id");
  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  if (!canSplit(c, inv))
    return c.json({ error: "Only the assigned executive can split" }, 403);
  if (inv.status === INVOICE_STATUS.EXPORTED)
    return c.json({ error: "Invoice already exported" }, 409);
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

  const body = await c.req.json().catch(() => ({}));
  const allocs = (body as {
    allocations?: { business: string; class: string; percentage: number }[];
  }).allocations;
  if (!Array.isArray(allocs) || allocs.length === 0)
    return c.json({ error: "At least one allocation is required" }, 400);

  // Validate every allocation first (all-or-nothing).
  for (const a of allocs) {
    if (!(BUSINESS_ENTITIES as readonly string[]).includes(a.business))
      return c.json({ error: `Invalid business "${a.business}"` }, 400);
    const valid = BUSINESS_CLASSES[a.business] ?? [];
    if (!valid.includes(a.class))
      return c.json(
        { error: `Invalid class "${a.class}" for business "${a.business}"` },
        400,
      );
    if (typeof a.percentage !== "number" || !isFinite(a.percentage))
      return c.json({ error: "Each allocation needs a numeric percentage" }, 400);
  }
  const pctSum = allocs.reduce((s, a) => s + a.percentage, 0);
  if (Math.abs(pctSum - 100) > 0.05)
    return c.json({ error: `Percentages must sum to 100 (got ${pctSum})` }, 400);

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

  const total = inv.total_amount;
  const allocations: InvoiceAllocationRow[] = [];
  let runningSum = 0;
  const at = nowIso();
  for (let i = 0; i < allocs.length; i++) {
    const a = allocs[i];
    const isLast = i === allocs.length - 1;
    // Last row absorbs the rounding remainder so the sum equals total exactly.
    const amount = isLast
      ? roundCents(total - runningSum)
      : roundCents((total * a.percentage) / 100);
    runningSum = roundCents(runningSum + amount);
    const row: InvoiceAllocationRow = {
      id: uuid(),
      invoice_id: id,
      business: a.business,
      class: a.class,
      percentage: a.percentage,
      amount,
      gl_account: glAccount,
      source: "CUSTOM",
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
    .bind("CUSTOM", id)
    .run();

  await audit(c.env, {
    invoiceId: id, userId: user(c).id, action: AUDIT_ACTION.INVOICE_SPLIT,
    newValue: { split_type: "CUSTOM", allocations: allocs },
    note: `Custom split across ${allocs.length} targets by ${user(c).name}`,
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
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

  const body = await c.req.json().catch(() => ({}));
  const lines = (body as {
    lines?: {
      lineItemId: string;
      business: string;
      class: string;
      type?: string;
      customType?: string;
    }[];
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
    if (l.type) {
      // The exec set a Type; it drives item_type + GL so the accountant
      // needn't re-code. Known types map to a fixed GL (auto-confirmed);
      // "Other" routes to manual review for the accountant to confirm.
      const itemType =
        l.type === "Other" ? l.customType || "Other" : l.type;
      const glCategory =
        l.type in TYPE_GL ? TYPE_GL[l.type] : REQUIRES_MANUAL_REVIEW;
      const requiresReview = l.type in TYPE_GL ? 0 : 1;
      await c.env.DB.prepare(
        "UPDATE line_items SET business = ?, class = ?, item_type = ?, gl_category = ?, requires_review = ? WHERE id = ? AND invoice_id = ?",
      )
        .bind(
          l.business, l.class, itemType, glCategory, requiresReview,
          l.lineItemId, id,
        )
        .run();
    } else {
      // No type provided — leave gl_category / item_type unchanged.
      await c.env.DB.prepare(
        "UPDATE line_items SET business = ?, class = ? WHERE id = ? AND invoice_id = ?",
      )
        .bind(l.business, l.class, l.lineItemId, id)
        .run();
    }
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
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

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
  if (!(await splitReady(c.env)))
    return c.json({ error: "Splitting needs a one-time database setup — run the migration." }, 503);

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

// ----- POST /:id/manual-review ----------------------------------------
// Feature B (v1.1.7): the assigned executive (or admin) sends an invoice back
// to the accountants for routing review with a required note. It leaves the
// exec queue (status → NEEDS_REVIEW), keeps the note on the approvals row for
// the accountant, audits, and best-effort emails the accountants. Modeled on
// POST /:id/reject. Only allowed from PENDING_APPROVAL.
invoices.post("/:id/manual-review", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const note = (body as { note?: string }).note?.trim();
  if (!note) return c.json({ error: "A review note is required" }, 400);

  const inv = await getInvoice(c.env, id);
  if (!inv) return c.json({ error: "Not found" }, 404);
  const u = user(c);
  const assigned = u.role === ROLES.EXECUTIVE && sameName(inv.approved_by, u.name);
  if (!assigned && u.role !== ROLES.ADMIN)
    return c.json({ error: "Only the assigned executive can send for review" }, 403);
  if (inv.status !== INVOICE_STATUS.PENDING_APPROVAL)
    return c.json({ error: "Only a pending invoice can be sent for manual review" }, 409);

  await c.env.DB.prepare("UPDATE invoices SET status = ? WHERE id = ?")
    .bind(INVOICE_STATUS.NEEDS_REVIEW, id)
    .run();
  // Keep the approvals row PENDING but stash the exec's note (the accountant
  // sees it as the reason this came back for routing review).
  await c.env.DB.prepare(
    "UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE invoice_id = ?",
  )
    .bind(APPROVAL_STATUS.PENDING, note, nowIso(), id)
    .run();
  await audit(c.env, {
    invoiceId: id, userId: u.id, action: AUDIT_ACTION.MANUAL_REVIEW_REQUESTED,
    prevValue: { status: inv.status }, newValue: { status: INVOICE_STATUS.NEEDS_REVIEW },
    note: `Sent for manual review by ${u.name}: ${note}`,
  });

  const accountants = await c.env.DB.prepare(
    "SELECT * FROM users WHERE role = ? AND is_active = 1",
  ).bind(ROLES.ACCOUNTANT).all<UserRow>();
  for (const acc of accountants.results ?? []) {
    // send() never throws — best-effort, no need to wrap.
    await sendManualReviewEmail(c.env, acc.email, {
      invoiceId: id, vendor: inv.vendor, totalAmount: inv.total_amount,
      business: inv.business, dueDate: inv.due_date, invoiceNumber: inv.invoice_number,
    }, u.name, note);
  }
  return c.json({ status: INVOICE_STATUS.NEEDS_REVIEW });
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
