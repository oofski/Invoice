/**
 * CCRMS transactions routes (NEW — Agent A3).
 *
 * Read/serve surface for `cc_transactions`:
 *   - GET    /transactions        — filtered, paginated list (scoped).
 *   - GET    /transactions/:id     — single tx + embedded splits + receipts.
 *   - PATCH  /transactions/:id     — subset update (manager full; cardholder limited).
 *   - PATCH  /transactions/bulk    — manager bulk receipt_status/in_qb update.
 *
 * Every handler runs the §2 preamble in order: flag gate (404), migration gate
 * (503), role gate (403), validation (400). Reads honor `ccScopeClause(c)` so a
 * scoped cardholder only ever sees / patches their own rows. The mounter (A2)
 * imports this file by the fixed name `transactions`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady, ccScopeClause } from "../../cc/flag";
import {
  CC_RECEIPT_STATUSES,
  CC_SOURCES,
  type CcReceiptStatus,
} from "../../cc/ccConstants";
import type {
  Tx,
  TxRow,
  EntitySplit,
  EntitySplitRow,
  Receipt,
  ReceiptRow,
  ReceiptOcrData,
} from "../../cc/ccTypes";

export const transactions = new Hono<AppEnv>();

const MIGRATION_MSG =
  "Credit Cards needs a one-time database setup — run the migration.";

/** True once cc_transactions.archived_at exists (the v1.3.8 archive migration). */
async function ccArchiveReady(env: AppEnv["Bindings"]): Promise<boolean> {
  try { await env.DB.prepare("SELECT archived_at FROM cc_transactions LIMIT 1").first(); return true; }
  catch { return false; }
}

/** True once cc_transactions.gl_category exists (the v1.9.0 overall-GL migration). */
async function ccGlReady(env: AppEnv["Bindings"]): Promise<boolean> {
  try { await env.DB.prepare("SELECT gl_category FROM cc_transactions LIMIT 1").first(); return true; }
  catch { return false; }
}

/** A `cc_transactions` row joined with the cardholder display name. */
type TxRowJoined = TxRow & { cardholder_name: string | null };

/** Hydrate a joined tx row → the API `Tx` DTO (0/1 → bool; name fallback). */
function hydrateTx(r: TxRowJoined): Tx {
  return {
    id: r.id,
    source: r.source as Tx["source"],
    upload_batch_id: r.upload_batch_id,
    cardholder_id: r.cardholder_id,
    cardholder_name: r.cardholder_name || "UNMATCHED",
    transaction_date: r.transaction_date,
    posted_date: r.posted_date,
    vendor: r.vendor,
    description: r.description,
    category: r.category,
    amount: r.amount,
    is_credit: !!r.is_credit,
    is_payment: !!r.is_payment,
    receipt_status: r.receipt_status as CcReceiptStatus,
    in_qb: !!r.in_qb,
    exp_acct: r.exp_acct,
    notes: r.notes,
    gl_category: r.gl_category ?? null,
    dedup_key: r.dedup_key,
    archived_at: r.archived_at ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function hydrateSplit(r: EntitySplitRow): EntitySplit {
  return {
    id: r.id,
    transaction_id: r.transaction_id,
    entity_name: r.entity_name,
    amount: r.amount,
  };
}

function hydrateReceipt(r: ReceiptRow): Receipt {
  let ocr: ReceiptOcrData | null = null;
  if (r.ocr_extracted_data) {
    try {
      ocr = JSON.parse(r.ocr_extracted_data) as ReceiptOcrData;
    } catch {
      ocr = null;
    }
  }
  return {
    id: r.id,
    transaction_id: r.transaction_id,
    uploaded_by: r.uploaded_by,
    upload_method: r.upload_method as Receipt["upload_method"],
    r2_key: r.r2_key,
    file_name: r.file_name,
    file_type: r.file_type,
    file_size_bytes: r.file_size_bytes,
    ocr_extracted_data: ocr,
    verified_by: r.verified_by,
    verified_at: r.verified_at,
    created_at: r.created_at,
  };
}

/** SELECT a single joined tx row by id (with cardholder name). */
async function selectTxJoined(
  env: AppEnv["Bindings"],
  id: string,
): Promise<TxRowJoined | null> {
  const row = await env.DB.prepare(
    `SELECT t.*, trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) AS cardholder_name
       FROM cc_transactions t
       LEFT JOIN cc_cardholders ch ON ch.id = t.cardholder_id
      WHERE t.id = ?`,
  )
    .bind(id)
    .first<TxRowJoined>();
  return row ?? null;
}

/**
 * Whether a scoped (non-manager) user owns this transaction. Manager/admin own
 * everything. Mirrors `ccScopeClause`: a row is "owned" when its cardholder maps
 * to the user by `user_id` or first-name match.
 */
async function ownsTx(
  c: import("hono").Context<AppEnv>,
  txCardholderId: string | null,
): Promise<boolean> {
  if (hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT)) return true;
  if (!txCardholderId) return false;
  const u = user(c);
  const first = (u.name || "").trim().split(/\s+/)[0] ?? "";
  const row = await c.env.DB.prepare(
    `SELECT 1 FROM cc_cardholders
      WHERE id = ? AND (user_id = ? OR lower(first_name) = lower(?))`,
  )
    .bind(txCardholderId, u.id, first)
    .first();
  return !!row;
}

// ----- GET / (list) ----------------------------------------------------
transactions.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);

  let sql =
    `SELECT t.*, trim(ch.first_name || ' ' || coalesce(ch.last_name, '')) AS cardholder_name
       FROM cc_transactions t
       LEFT JOIN cc_cardholders ch ON ch.id = t.cardholder_id
      WHERE 1=1`;
  const params: (string | number)[] = [];

  // Cardholder scoping (clause keys on cc_transactions.cardholder_id, which is
  // t.cardholder_id here — the JOIN doesn't shadow the column name).
  const { clause, params: scopeParams } = ccScopeClause(c);
  sql += clause;
  params.push(...scopeParams);

  const cardholderId = c.req.query("cardholder_id");
  if (cardholderId) { sql += " AND t.cardholder_id = ?"; params.push(cardholderId); }

  const source = c.req.query("source");
  if (source) {
    if (!(CC_SOURCES as readonly string[]).includes(source))
      return c.json({ error: `Invalid source "${source}"` }, 400);
    sql += " AND t.source = ?";
    params.push(source);
  }

  const receiptStatus = c.req.query("receipt_status");
  if (receiptStatus) {
    if (!(CC_RECEIPT_STATUSES as readonly string[]).includes(receiptStatus))
      return c.json({ error: `Invalid receipt_status "${receiptStatus}"` }, 400);
    sql += " AND t.receipt_status = ?";
    params.push(receiptStatus);
  }

  const dateFrom = c.req.query("date_from");
  if (dateFrom) { sql += " AND t.transaction_date >= ?"; params.push(dateFrom); }
  const dateTo = c.req.query("date_to");
  if (dateTo) { sql += " AND t.transaction_date <= ?"; params.push(dateTo); }

  const category = c.req.query("category");
  if (category) { sql += " AND t.category = ?"; params.push(category); }

  const q = c.req.query("q");
  if (q) { sql += " AND t.vendor LIKE ?"; params.push(`%${q}%`); }

  // Pagination: page default 1, per_page default 50 (max 200).
  let page = Number(c.req.query("page") ?? 1);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);
  let perPage = Number(c.req.query("per_page") ?? 50);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 50;
  perPage = Math.min(200, Math.floor(perPage));
  const offset = (page - 1) * perPage;

  // Total count over the SAME WHERE filters (rebuilt independently of the SELECT
  // string so it stays correct; LIMIT/OFFSET deliberately excluded).
  let cSql = "SELECT COUNT(*) AS c FROM cc_transactions t WHERE 1=1";
  const cParams: (string | number)[] = [];
  cSql += clause;
  cParams.push(...scopeParams);
  if (cardholderId) { cSql += " AND t.cardholder_id = ?"; cParams.push(cardholderId); }
  if (source) { cSql += " AND t.source = ?"; cParams.push(source); }
  if (receiptStatus) { cSql += " AND t.receipt_status = ?"; cParams.push(receiptStatus); }
  if (dateFrom) { cSql += " AND t.transaction_date >= ?"; cParams.push(dateFrom); }
  if (dateTo) { cSql += " AND t.transaction_date <= ?"; cParams.push(dateTo); }
  if (category) { cSql += " AND t.category = ?"; cParams.push(category); }
  if (q) { cSql += " AND t.vendor LIKE ?"; cParams.push(`%${q}%`); }

  // v1.3.8: hide archived rows by default. ?includeArchived=1 (any truthy) shows
  // them. Applied to BOTH the list and the count so `total` matches the page.
  // Gated on ccArchiveReady so a pre-migration DB (no archived_at column) is
  // tolerated — when the column is absent the clause is skipped and all rows show.
  // Both queries alias the table `t`, so `t.archived_at` resolves in each.
  const includeArchived = !!c.req.query("includeArchived");
  if (!includeArchived && (await ccArchiveReady(c.env))) {
    sql += " AND t.archived_at IS NULL";
    cSql += " AND t.archived_at IS NULL";
  }

  const countRow = await c.env.DB.prepare(cSql).bind(...cParams).first<{ c: number }>();
  const total = countRow?.c ?? 0;

  sql += " ORDER BY t.transaction_date DESC, t.created_at DESC LIMIT ? OFFSET ?";
  params.push(perPage, offset);

  const rows = await c.env.DB.prepare(sql).bind(...params).all<TxRowJoined>();
  const out = (rows.results ?? []).map(hydrateTx);
  return c.json({ transactions: out, total, page, per_page: perPage });
});

// ----- PATCH /bulk (manager only) -------------------------------------
// Registered BEFORE GET/PATCH /:id so the literal "bulk" path isn't shadowed by
// the :id param route.
transactions.patch("/bulk", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    transaction_ids?: unknown;
    updates?: { receipt_status?: unknown; in_qb?: unknown; cardholder_id?: unknown };
  };
  const ids = Array.isArray(body.transaction_ids)
    ? body.transaction_ids.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (ids.length === 0)
    return c.json({ error: "transaction_ids (non-empty array) is required" }, 400);

  const updates = body.updates ?? {};
  const sets: string[] = [];
  const setParams: (string | number | null)[] = [];

  if ("receipt_status" in updates && updates.receipt_status !== undefined) {
    const rs = updates.receipt_status;
    if (typeof rs !== "string" || !(CC_RECEIPT_STATUSES as readonly string[]).includes(rs))
      return c.json({ error: `Invalid receipt_status "${String(rs)}"` }, 400);
    sets.push("receipt_status = ?");
    setParams.push(rs);
  }
  if ("in_qb" in updates && updates.in_qb !== undefined) {
    sets.push("in_qb = ?");
    setParams.push(updates.in_qb ? 1 : 0);
  }
  // cardholder_id reassignment (mirrors the SINGLE PATCH logic): null unassigns;
  // a string must be an ACTIVE cardholder. Validated ONCE here, before the loop.
  if ("cardholder_id" in updates && updates.cardholder_id !== undefined) {
    const ch = updates.cardholder_id;
    if (ch !== null && typeof ch !== "string")
      return c.json({ error: "cardholder_id must be a string or null" }, 400);
    if (ch) {
      const found = await c.env.DB.prepare(
        "SELECT id FROM cc_cardholders WHERE id = ? AND is_active = 1",
      )
        .bind(ch)
        .first();
      if (!found)
        return c.json({ error: `Unknown or inactive cardholder "${ch}"` }, 400);
    }
    sets.push("cardholder_id = ?");
    setParams.push((ch as string | null) ?? null);
  }
  if (sets.length === 0)
    return c.json(
      { error: "At least one update field (receipt_status, in_qb, cardholder_id) is required" },
      400,
    );

  sets.push("updated_at = ?");
  setParams.push(new Date().toISOString());

  // Apply per-id (skip unknown ids — they simply don't update).
  let updated = 0;
  for (const id of ids) {
    const res = await c.env.DB.prepare(
      `UPDATE cc_transactions SET ${sets.join(", ")} WHERE id = ?`,
    )
      .bind(...setParams, id)
      .run();
    // D1 reports affected-row count; unknown ids contribute 0.
    const changes = res.meta?.changes ?? 0;
    if (changes > 0) updated += changes;
  }
  return c.json({ updated_count: updated });
});

// ----- POST /archive (batch, manager only) ----------------------------
// v1.3.8: archive a set of transactions (safe, reversible — sets archived_at,
// never deletes). Body { ids: string[] }. Registered BEFORE GET/PATCH /:id so
// the literal path isn't shadowed by the :id param route (POST has no method
// collision regardless). Preamble: flag → archive-ready 503 → manager 403 → 400.
transactions.post("/archive", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccArchiveReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (ids.length === 0)
    return c.json({ error: "ids (non-empty array) is required" }, 400);

  const at = new Date().toISOString();
  let archived = 0;
  for (const id of ids) {
    // Skip unknown / already-archived (archived_at IS NULL guard). Bump
    // updated_at alongside for parity with the PATCH handlers.
    const res = await c.env.DB.prepare(
      "UPDATE cc_transactions SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
    )
      .bind(at, at, id)
      .run();
    archived += res.meta?.changes ?? 0;
  }
  return c.json({ ok: true, archived });
});

// ----- POST /:id/archive (manager only) -------------------------------
// v1.3.8: archive a single transaction (reversible). Registered BEFORE GET /:id.
transactions.post("/:id/archive", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccArchiveReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const tx = await selectTxJoined(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);

  const at = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE cc_transactions SET archived_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(at, at, id)
    .run();
  return c.json({ ok: true, archived_at: at });
});

// ----- POST /:id/unarchive (manager only) -----------------------------
// v1.3.8: restore an archived transaction to the default view. Before GET /:id.
transactions.post("/:id/unarchive", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccArchiveReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const tx = await selectTxJoined(c.env, id);
  if (!tx) return c.json({ error: "Not found" }, 404);

  const at = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE cc_transactions SET archived_at = NULL, updated_at = ? WHERE id = ?",
  )
    .bind(at, id)
    .run();
  return c.json({ ok: true });
});

// ----- GET /:id --------------------------------------------------------
transactions.get("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);

  const id = c.req.param("id");
  const row = await selectTxJoined(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!(await ownsTx(c, row.cardholder_id))) return c.json({ error: "Forbidden" }, 403);

  const splitRows = await c.env.DB.prepare(
    "SELECT * FROM cc_entity_splits WHERE transaction_id = ? ORDER BY created_at ASC",
  )
    .bind(id)
    .all<EntitySplitRow>();
  const receiptRows = await c.env.DB.prepare(
    "SELECT * FROM cc_receipts WHERE transaction_id = ? ORDER BY created_at DESC",
  )
    .bind(id)
    .all<ReceiptRow>();

  return c.json({
    transaction: hydrateTx(row),
    splits: (splitRows.results ?? []).map(hydrateSplit),
    receipts: (receiptRows.results ?? []).map(hydrateReceipt),
  });
});

// ----- PATCH /:id ------------------------------------------------------
transactions.patch("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);

  const id = c.req.param("id");
  const existing = await selectTxJoined(c.env, id);
  if (!existing) return c.json({ error: "Not found" }, 404);

  const isManager = hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT);
  const owns = await ownsTx(c, existing.cardholder_id);
  if (!owns) return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    receipt_status?: unknown;
    in_qb?: unknown;
    exp_acct?: unknown;
    notes?: unknown;
    gl_category?: unknown;
    cardholder_id?: unknown;
    vendor?: unknown;
    amount?: unknown;
    transaction_date?: unknown;
    category?: unknown;
  };

  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  // A scoped (non-manager) user may patch ONLY `notes` on their own rows.
  if (!isManager) {
    const onlyNotes = Object.keys(body).every((k) => k === "notes");
    if (!onlyNotes)
      return c.json({ error: "You may only edit notes on your own transactions" }, 403);
  }

  if ("receipt_status" in body && body.receipt_status !== undefined) {
    const rs = body.receipt_status;
    if (typeof rs !== "string" || !(CC_RECEIPT_STATUSES as readonly string[]).includes(rs))
      return c.json({ error: `Invalid receipt_status "${String(rs)}"` }, 400);
    sets.push("receipt_status = ?");
    params.push(rs);
  }
  if ("in_qb" in body && body.in_qb !== undefined) {
    sets.push("in_qb = ?");
    params.push(body.in_qb ? 1 : 0);
  }
  if ("exp_acct" in body && body.exp_acct !== undefined) {
    const v = body.exp_acct;
    if (v !== null && typeof v !== "string")
      return c.json({ error: "exp_acct must be a string or null" }, 400);
    sets.push("exp_acct = ?");
    params.push((v as string | null) ?? null);
  }
  if ("notes" in body && body.notes !== undefined) {
    const v = body.notes;
    if (v !== null && typeof v !== "string")
      return c.json({ error: "notes must be a string or null" }, 400);
    sets.push("notes = ?");
    params.push((v as string | null) ?? null);
  }
  // v1.9.0 overall GL category (COA name). Manager-only via the onlyNotes guard.
  // Gated on ccGlReady so a pre-migration isolate (no column) can't throw on the
  // UPDATE — it simply skips the field until the additive migration has run.
  if ("gl_category" in body && body.gl_category !== undefined) {
    const v = body.gl_category;
    if (v !== null && typeof v !== "string")
      return c.json({ error: "gl_category must be a string or null" }, 400);
    if (await ccGlReady(c.env)) {
      sets.push("gl_category = ?");
      params.push(v && (v as string).trim() !== "" ? (v as string) : null);
    }
  }
  // The fields below are manager-only via the onlyNotes guard above (re-parse corrections).
  if ("vendor" in body && body.vendor !== undefined) {
    const v = body.vendor;
    if (typeof v !== "string" || v.trim() === "")
      return c.json({ error: "vendor must be a non-empty string" }, 400);
    sets.push("vendor = ?");
    params.push(v.trim());
  }
  if ("amount" in body && body.amount !== undefined) {
    const v = body.amount;
    if (typeof v !== "number" || !Number.isFinite(v))
      return c.json({ error: "amount must be a finite number" }, 400);
    sets.push("amount = ?");
    params.push(v);
  }
  if ("transaction_date" in body && body.transaction_date !== undefined) {
    const v = body.transaction_date;
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))
      return c.json({ error: "transaction_date must be YYYY-MM-DD" }, 400);
    sets.push("transaction_date = ?");
    params.push(v);
  }
  if ("category" in body && body.category !== undefined) {
    const v = body.category;
    if (v !== null && typeof v !== "string")
      return c.json({ error: "category must be a string or null" }, 400);
    sets.push("category = ?");
    params.push(v && v !== "" ? v : null);
  }
  if ("cardholder_id" in body && body.cardholder_id !== undefined) {
    // cardholder_id reassignment is manager-only (used to resolve UNMATCHED).
    if (!isManager)
      return c.json({ error: "Only a manager may reassign the cardholder" }, 403);
    const ch = body.cardholder_id;
    if (ch !== null && typeof ch !== "string")
      return c.json({ error: "cardholder_id must be a string or null" }, 400);
    if (ch) {
      const found = await c.env.DB.prepare(
        "SELECT id FROM cc_cardholders WHERE id = ? AND is_active = 1",
      )
        .bind(ch)
        .first();
      if (!found)
        return c.json({ error: `Unknown or inactive cardholder "${ch}"` }, 400);
    }
    sets.push("cardholder_id = ?");
    params.push((ch as string | null) ?? null);
  }

  if (sets.length === 0) return c.json({ error: "No updatable fields" }, 400);

  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);

  await c.env.DB.prepare(
    `UPDATE cc_transactions SET ${sets.join(", ")} WHERE id = ?`,
  )
    .bind(...params)
    .run();

  const updated = await selectTxJoined(c.env, id);
  return c.json({ transaction: updated ? hydrateTx(updated) : null });
});
