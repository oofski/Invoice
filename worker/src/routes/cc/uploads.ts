/**
 * CCRMS upload routes (NEW; owned by A2). §6.1.
 *
 *   POST /uploads/preview          — parse-preview (no commit). Multipart:
 *                                    { source, rows (JSON string), file }.
 *   POST /uploads/:batch_id/confirm — commit the staged rows (guarded INSERT;
 *                                    force_overwrite → REPLACE). No 409 — dupes
 *                                    are reported in the body.
 *   GET  /uploads                  — upload history (created_at DESC).
 *
 * Manager-gated. Implements the §2 preamble (404→503→403→400→success).
 * Rows are staged on the batch as `staged_rows` JSON at /preview and re-read at
 * /confirm (the ratified seam), so the client cannot alter rows between the two.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { uuid, nowIso, parseJson, chunk } from "../../lib/util";
import { roundCents } from "../../cc/ccRules";
import { ccRawUploadKey, ccPut, ccDelete, ccMaybeDeleteObject } from "../../cc/ccStorage";
import {
  loadCapOneRegistry,
  normalizeCapOneRow,
  type CapOneParsedRow,
} from "../../cc/ingestCapitalOne";
import {
  loadAmexRegistry,
  normalizeAmexRow,
  type AmexParsedRow,
} from "../../cc/ingestAmex";
import type {
  CcSource,
  StagedTxRow,
  PreviewResult,
  CardholderBreakdownEntry,
  UploadBatchRow,
  UploadBatch,
} from "../../cc/ccTypes";

export const uploads = new Hono<AppEnv>();

/** Manager-role gate (mirrors §2.3). */
function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT);
}

const BLANK_TEMPLATE_MESSAGE =
  "This appears to be a blank template — 0 transactions found. Upload the completed version when available.";

/** Hydrates a batch row (no booleans on this table; just narrows enum types). */
function hydrateBatch(r: UploadBatchRow): UploadBatch {
  return {
    id: r.id,
    uploaded_by: r.uploaded_by,
    source: r.source as CcSource,
    original_filename: r.original_filename,
    r2_key: r.r2_key,
    period_start: r.period_start,
    period_end: r.period_end,
    transaction_count: r.transaction_count,
    duplicate_count: r.duplicate_count,
    skipped_count: r.skipped_count,
    status: r.status as UploadBatch["status"],
    error_message: r.error_message,
    created_at: r.created_at,
  };
}

/** Min/max ISO date over staged rows → inferred period. */
function inferPeriod(rows: StagedTxRow[]): { start: string | null; end: string | null } {
  const dates = rows.map((r) => r.transaction_date).filter((d): d is string => !!d).sort();
  return { start: dates[0] ?? null, end: dates[dates.length - 1] ?? null };
}

/**
 * Marks staged rows whose `dedup_key` already exists in `cc_transactions`. Runs a
 * single IN-query per chunk (D1 caps bound params). Mutates `is_duplicate`.
 */
async function flagExistingDuplicates(
  env: AppEnv["Bindings"],
  rows: StagedTxRow[],
): Promise<void> {
  const keys = rows.map((r) => r.dedup_key).filter((k): k is string => !!k);
  if (keys.length === 0) return;
  const existing = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    try {
      const res = await env.DB.prepare(
        `SELECT dedup_key FROM cc_transactions WHERE dedup_key IN (${placeholders})`,
      )
        .bind(...slice)
        .all<{ dedup_key: string }>();
      for (const row of res.results ?? []) existing.add(row.dedup_key);
    } catch (e) {
      console.error("[cc] flagExistingDuplicates failed:", e);
    }
  }
  for (const r of rows) {
    if (r.dedup_key && existing.has(r.dedup_key)) r.is_duplicate = true;
  }
}

/** Builds the per-cardholder breakdown + unmatched-card list for the preview. */
async function buildBreakdown(
  env: AppEnv["Bindings"],
  rows: StagedTxRow[],
): Promise<{ breakdown: CardholderBreakdownEntry[]; unmatched: string[] }> {
  const counts = new Map<string | null, number>();
  const unmatchedCards = new Set<string>();
  for (const r of rows) {
    counts.set(r.cardholder_id, (counts.get(r.cardholder_id) ?? 0) + 1);
    if (!r.cardholder_id && r.card_digits) unmatchedCards.add(r.card_digits);
  }

  // Resolve cardholder display names for matched ids.
  const ids = [...counts.keys()].filter((k): k is string => !!k);
  const names = new Map<string, string>();
  if (ids.length) {
    try {
      // Batch the id list (D1 caps bound params) — merge names across chunks.
      for (const batch of chunk(ids)) {
        const placeholders = batch.map(() => "?").join(",");
        const res = await env.DB.prepare(
          `SELECT id, first_name, last_name FROM cc_cardholders WHERE id IN (${placeholders})`,
        )
          .bind(...batch)
          .all<{ id: string; first_name: string; last_name: string | null }>();
        for (const ch of res.results ?? [])
          names.set(ch.id, `${ch.first_name}${ch.last_name ? ` ${ch.last_name}` : ""}`);
      }
    } catch (e) {
      console.error("[cc] buildBreakdown name lookup failed:", e);
    }
  }

  const breakdown: CardholderBreakdownEntry[] = [...counts.entries()].map(([id, count]) => ({
    cardholder_id: id,
    name: id ? names.get(id) ?? "UNMATCHED" : "UNMATCHED",
    count,
  }));
  return { breakdown, unmatched: [...unmatchedCards] };
}

// ----- POST /uploads/preview ------------------------------------------------
uploads.post("/preview", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const form = await c.req.formData();
  const source = String(form.get("source") ?? "").trim() as CcSource;
  if (source !== "CAPITAL_ONE" && source !== "AMEX")
    return c.json({ error: "source must be CAPITAL_ONE or AMEX" }, 400);

  const rowsRaw = form.get("rows");
  if (typeof rowsRaw !== "string")
    return c.json({ error: "rows (JSON string) is required" }, 400);
  const parsedRows = parseJson<unknown[]>(rowsRaw, []);
  if (!Array.isArray(parsedRows))
    return c.json({ error: "rows must be a JSON array" }, 400);

  const file = form.get("file") as unknown as
    | { arrayBuffer(): Promise<ArrayBuffer>; name?: string }
    | string
    | null;
  const fileName =
    file && typeof file !== "string" ? file.name ?? "upload" : "upload";

  // Normalize each parsed row → StagedTxRow (server recomputes amounts + match).
  const staged: StagedTxRow[] = [];
  if (source === "CAPITAL_ONE") {
    const registry = await loadCapOneRegistry(c.env);
    for (const r of parsedRows) {
      const norm = normalizeCapOneRow(r as CapOneParsedRow, registry);
      if (norm) staged.push(norm);
    }
  } else {
    const amexRegistry = await loadAmexRegistry(c.env);
    for (const r of parsedRows) {
      const norm = normalizeAmexRow(r as AmexParsedRow, amexRegistry);
      if (norm) staged.push(norm);
    }
  }

  await flagExistingDuplicates(c.env, staged);

  const batchId = uuid();
  const u = user(c);

  // Archive the raw upload file to R2 (best-effort — never blocks the preview).
  let r2Key: string | null = null;
  if (file && typeof file !== "string") {
    try {
      const buf = await file.arrayBuffer();
      r2Key = ccRawUploadKey(batchId, fileName);
      await ccPut(c.env, r2Key, buf, source === "AMEX" ? "application/octet-stream" : "text/csv");
    } catch (e) {
      console.error("[cc] raw upload archive failed:", e);
      r2Key = null;
    }
  }

  // Blank template (Amex, 0 data rows) → record a BLANK_TEMPLATE batch, no error.
  if (source === "AMEX" && staged.length === 0) {
    await c.env.DB.prepare(
      `INSERT INTO cc_upload_batches
         (id, uploaded_by, source, original_filename, r2_key, status, staged_rows, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
      .bind(batchId, u.id, source, fileName, r2Key, "BLANK_TEMPLATE", "[]", nowIso())
      .run();
    return c.json({ status: "BLANK_TEMPLATE", message: BLANK_TEMPLATE_MESSAGE, batch_id: batchId });
  }

  const period = inferPeriod(staged);
  const newCount = staged.filter((r) => !r.is_duplicate).length;
  const duplicateCount = staged.filter((r) => r.is_duplicate).length;
  const { breakdown, unmatched } = await buildBreakdown(c.env, staged);

  await c.env.DB.prepare(
    `INSERT INTO cc_upload_batches
       (id, uploaded_by, source, original_filename, r2_key, period_start, period_end,
        transaction_count, duplicate_count, skipped_count, status, staged_rows, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      batchId,
      u.id,
      source,
      fileName,
      r2Key,
      period.start,
      period.end,
      staged.length,
      duplicateCount,
      0,
      "PREVIEW",
      JSON.stringify(staged),
      nowIso(),
    )
    .run();

  const preview: PreviewResult = {
    row_count: staged.length,
    new_count: newCount,
    duplicate_count: duplicateCount,
    skipped_count: 0,
    period_start: period.start,
    period_end: period.end,
    unmatched_cards: unmatched,
    cardholder_breakdown: breakdown,
  };

  return c.json({ batch_id: batchId, source, status: "PREVIEW", preview });
});

// ----- POST /uploads/:batch_id/confirm --------------------------------------
uploads.post("/:batch_id/confirm", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const batchId = c.req.param("batch_id");
  const batch = await c.env.DB.prepare("SELECT * FROM cc_upload_batches WHERE id = ?")
    .bind(batchId)
    .first<UploadBatchRow>();
  if (!batch) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { force_overwrite?: boolean };
  const forceOverwrite = body.force_overwrite === true;

  const staged = parseJson<StagedTxRow[]>(batch.staged_rows, []);

  let transactionCount = 0;
  let duplicateCount = 0;
  let skippedCount = 0;
  const at = nowIso();

  for (const row of staged) {
    if (!row.dedup_key || !row.transaction_date) {
      skippedCount++;
      continue;
    }

    // Does a transaction with this dedup_key already exist?
    let existingId: string | null = null;
    try {
      const found = await c.env.DB.prepare(
        "SELECT id FROM cc_transactions WHERE dedup_key = ?",
      )
        .bind(row.dedup_key)
        .first<{ id: string }>();
      existingId = found?.id ?? null;
    } catch {
      existingId = null;
    }

    if (existingId && !forceOverwrite) {
      duplicateCount++;
      continue;
    }

    let txId: string;
    // v1.9.11 (M13): true when overwriting a tx that has ALREADY collected a
    // receipt/coding — we then preserve its receipt_status and skip the splits
    // replace-all so a re-imported overlapping statement can't silently revert a
    // collected charge to PENDING and wipe manual entity splits.
    let preserveCollected = false;
    if (existingId && forceOverwrite) {
      txId = existingId;
      const existingState = await c.env.DB.prepare(
        "SELECT t.receipt_status, (SELECT COUNT(*) FROM cc_receipts r WHERE r.transaction_id = t.id) AS receipts FROM cc_transactions t WHERE t.id = ?",
      )
        .bind(existingId)
        .first<{ receipt_status: string; receipts: number }>();
      preserveCollected =
        (existingState?.receipts ?? 0) > 0 ||
        (!!existingState?.receipt_status && existingState.receipt_status !== "PENDING");
      const receiptStatusToStore = preserveCollected
        ? existingState!.receipt_status
        : row.receipt_status;
      await c.env.DB.prepare(
        `UPDATE cc_transactions SET
           source = ?, upload_batch_id = ?, cardholder_id = ?, transaction_date = ?,
           posted_date = ?, vendor = ?, description = ?, category = ?, amount = ?,
           is_credit = ?, is_payment = ?, receipt_status = ?, in_qb = ?, exp_acct = ?,
           updated_at = ?
         WHERE id = ?`,
      )
        .bind(
          row.source,
          batchId,
          row.cardholder_id,
          row.transaction_date,
          row.posted_date,
          row.vendor,
          row.description,
          row.category,
          roundCents(row.amount),
          row.is_credit ? 1 : 0,
          row.is_payment ? 1 : 0,
          receiptStatusToStore,
          row.in_qb ? 1 : 0,
          row.exp_acct,
          at,
          txId,
        )
        .run();
      duplicateCount++;
    } else {
      txId = uuid();
      try {
        await c.env.DB.prepare(
          `INSERT INTO cc_transactions
             (id, source, upload_batch_id, cardholder_id, transaction_date, posted_date,
              vendor, description, category, amount, is_credit, is_payment, receipt_status,
              in_qb, exp_acct, dedup_key, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            txId,
            row.source,
            batchId,
            row.cardholder_id,
            row.transaction_date,
            row.posted_date,
            row.vendor,
            row.description,
            row.category,
            roundCents(row.amount),
            row.is_credit ? 1 : 0,
            row.is_payment ? 1 : 0,
            row.receipt_status,
            row.in_qb ? 1 : 0,
            row.exp_acct,
            row.dedup_key,
            at,
            at,
          )
          .run();
        transactionCount++;
      } catch (e) {
        // UNIQUE(dedup_key) violation → a concurrent insert beat us; count as dupe.
        const msg = String((e as { message?: string })?.message ?? e);
        if (/unique|constraint/i.test(msg)) {
          duplicateCount++;
          continue;
        }
        console.error("[cc] confirm insert failed:", e);
        skippedCount++;
        continue;
      }
    }

    // Replace-all entity splits for Amex rows with non-zero entity columns.
    // v1.9.11 (M13): skip when overwriting an already-collected tx so a re-import
    // doesn't overwrite manual coding.
    if (row.source === "AMEX" && row.splits.length && !preserveCollected) {
      await c.env.DB.prepare("DELETE FROM cc_entity_splits WHERE transaction_id = ?")
        .bind(txId)
        .run();
      for (const s of row.splits) {
        await c.env.DB.prepare(
          "INSERT INTO cc_entity_splits (id, transaction_id, entity_name, amount, created_at) VALUES (?,?,?,?,?)",
        )
          .bind(uuid(), txId, s.entity_name, roundCents(s.amount), at)
          .run();
      }
    }
  }

  await c.env.DB.prepare(
    "UPDATE cc_upload_batches SET status = ?, transaction_count = ?, duplicate_count = ?, skipped_count = ? WHERE id = ?",
  )
    .bind("COMPLETE", transactionCount, duplicateCount, skippedCount, batchId)
    .run();

  return c.json({
    status: "COMPLETE",
    transaction_count: transactionCount,
    duplicate_count: duplicateCount,
    skipped_count: skippedCount,
  });
});

// ----- GET /uploads (history) -----------------------------------------------
uploads.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const rows = await c.env.DB.prepare(
    "SELECT * FROM cc_upload_batches ORDER BY created_at DESC",
  ).all<UploadBatchRow>();
  return c.json({ batches: (rows.results ?? []).map(hydrateBatch) });
});

// ----- DELETE /uploads/:id (manager only — cascade with safety override) ----
// Removes an upload batch and all of its transactions + child rows. D1 does NOT
// cascade FKs here, so children are deleted explicitly (children-first to stay
// FK-safe). A safety block (option C) refuses to silently destroy work: if any
// batch tx already has receipts / coding / is in QB, we 409 unless ?force=1.
// R2 deletes are always best-effort — a missing object must never abort the DB
// cascade, which is the source of truth.
uploads.delete("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env)))
    return c.json(
      { error: "Credit Cards needs a one-time database setup — run the migration." },
      503,
    );
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const batchId = c.req.param("id");
  const batch = await c.env.DB.prepare("SELECT * FROM cc_upload_batches WHERE id = ?")
    .bind(batchId)
    .first<UploadBatchRow>();
  if (!batch) return c.json({ error: "Not found" }, 404);

  const force = !!c.req.query("force");

  // All transactions belonging to this batch.
  const txRows = await c.env.DB.prepare(
    "SELECT id, in_qb FROM cc_transactions WHERE upload_batch_id = ?",
  )
    .bind(batchId)
    .all<{ id: string; in_qb: number }>();
  const txIds = (txRows.results ?? []).map((r) => r.id);
  const txCount = txIds.length;

  // --- Safety block (option C): count DISTINCT batch tx that are "protected" ---
  // A tx is protected if it has ANY child receipt / entity split / receipt line,
  // OR it is already in QB. We union the protected tx-id sets so the reported
  // count is an accurate distinct-tx count (not a sum of independent rows).
  // The tx-id list is batched (D1 caps bound params) — the DISTINCT union is
  // unaffected since each chunk contributes to the same set.
  let protectedCount = 0;
  if (txCount > 0) {
    const protectedIds = new Set<string>();
    for (const r of txRows.results ?? []) {
      if (r.in_qb === 1) protectedIds.add(r.id);
    }
    for (const table of ["cc_receipts", "cc_entity_splits", "cc_receipt_lines"]) {
      for (const batch of chunk(txIds)) {
        const ph = batch.map(() => "?").join(",");
        const res = await c.env.DB.prepare(
          `SELECT DISTINCT transaction_id FROM ${table} WHERE transaction_id IN (${ph})`,
        )
          .bind(...batch)
          .all<{ transaction_id: string }>();
        for (const row of res.results ?? []) protectedIds.add(row.transaction_id);
      }
    }
    protectedCount = protectedIds.size;
  }

  if (protectedCount > 0 && !force) {
    return c.json(
      {
        error: `${protectedCount} transaction(s) in this batch already have receipts or coding. Delete anyway to remove them and their receipts/coding.`,
        blocked: true,
        protected_count: protectedCount,
        transaction_count: txCount,
      },
      409,
    );
  }

  // --- Cascade delete (children first; allowed when not blocked or when force) ---
  let receiptsRemoved = 0;
  if (txCount > 0) {
    // Every tx-keyed step batches its id list (D1 caps bound params). Each stage
    // completes across all chunks before the next begins, preserving the
    // children-first (FK-safe) ordering of the single-statement version.

    // 1. Receipts: drop the ROWS first, then refcount-guard each object delete
    // (v1.9.10 H5) — a legacy key shared with a re-queued inbox row (step 5) is
    // still referenced, so ccMaybeDeleteObject skips it and its bytes survive;
    // a receipt's own copied key has no other reference and is removed.
    const receiptRows: { id: string; r2_key: string }[] = [];
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      const receipts = await c.env.DB.prepare(
        `SELECT id, r2_key FROM cc_receipts WHERE transaction_id IN (${ph})`,
      )
        .bind(...batch)
        .all<{ id: string; r2_key: string }>();
      receiptRows.push(...(receipts.results ?? []));
    }
    receiptsRemoved = receiptRows.length;
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      await c.env.DB.prepare(`DELETE FROM cc_receipts WHERE transaction_id IN (${ph})`)
        .bind(...batch)
        .run();
    }
    for (const rcpt of receiptRows) {
      await ccMaybeDeleteObject(c.env, rcpt.r2_key);
    }

    // 2-4. Remaining tx-keyed coding children (allocations → lines → splits).
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      await c.env.DB.prepare(`DELETE FROM cc_line_allocations WHERE transaction_id IN (${ph})`)
        .bind(...batch)
        .run();
    }
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      await c.env.DB.prepare(`DELETE FROM cc_receipt_lines WHERE transaction_id IN (${ph})`)
        .bind(...batch)
        .run();
    }
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      await c.env.DB.prepare(`DELETE FROM cc_entity_splits WHERE transaction_id IN (${ph})`)
        .bind(...batch)
        .run();
    }

    // 5. Re-queue matched inbox items: detach the tx/receipt link and set the
    // queue's awaiting-match status (PENDING_MATCH). We do NOT delete the
    // cardholder's dropped file (its own r2_key stays) — it returns to triage.
    for (const batch of chunk(txIds)) {
      const ph = batch.map(() => "?").join(",");
      await c.env.DB.prepare(
        `UPDATE cc_receipt_inbox
            SET matched_transaction_id = NULL, matched_receipt_id = NULL, status = 'PENDING_MATCH'
          WHERE matched_transaction_id IN (${ph})`,
      )
        .bind(...batch)
        .run();
    }

    // 6. The transactions themselves.
    await c.env.DB.prepare("DELETE FROM cc_transactions WHERE upload_batch_id = ?")
      .bind(batchId)
      .run();
  }

  // 7. Batch raw upload file (best-effort R2 delete).
  if (batch.r2_key) {
    try {
      await ccDelete(c.env, batch.r2_key);
    } catch (e) {
      console.error("[cc] batch-delete raw-file R2 delete failed:", e);
    }
  }

  // 8. The batch row.
  await c.env.DB.prepare("DELETE FROM cc_upload_batches WHERE id = ?")
    .bind(batchId)
    .run();

  return c.json({ ok: true, deleted: { transactions: txCount, receipts: receiptsRemoved } });
});
