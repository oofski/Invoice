/**
 * CCRMS receipt inbox routes (NEW; backend agent — Feature A §3).
 *
 * The un-attached "drop receipts" queue: a cardholder drops one or more receipts
 * with no transaction pre-selected; each is OCR'd and auto-matched to one of that
 * cardholder's open transactions (auto-attach via the shared `attachReceiptToTx`),
 * else queued to the manager inbox for triage (assign / send-back).
 *
 *   POST   /receipts/inbox          — bulk multipart (N `file` parts) → per-file
 *                                      MATCHED | PENDING_MATCH | ERROR (cardholder/manager).
 *   GET    /receipts/inbox          — manager queue (PENDING_MATCH) + joined candidates.
 *   GET    /receipts/inbox/mine     — caller's own drops (queued + returned).
 *   GET    /receipts/inbox/:id/file — stream the bytes inline (manager OR owner-dropper).
 *   POST   /receipts/inbox/:id/assign — manager assigns a queued item to a tx → attach.
 *   POST   /receipts/inbox/:id/return — manager sends an item back with a note.
 *   DELETE /receipts/inbox/:id      — manager, or owner-dropper while PENDING_MATCH.
 *
 * Mounted at `/receipts/inbox` (declares RELATIVE sub-paths here) BEFORE the
 * `receipts` sub-app, so `/receipts/inbox` does not collide with `/receipts/:id`.
 * Every handler runs the §2 preamble: 404 (flag) → 503 (ccReady) → 403 (role/owner)
 * → 400 (validation) → success. Error body is always `{ error }`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { isCcEnabled, ccReady } from "../../cc/flag";
import { uuid, nowIso } from "../../lib/util";
import {
  ccReceiptKey,
  ccExtForType,
  ccPut,
  ccPutReductoRaw,
  ccGet,
  ccMaybeDeleteObject,
} from "../../cc/ccStorage";
import { extractReceiptBytes, normalizeReceipt } from "../../cc/receiptExtract";
import { matchReceiptToTransaction } from "../../cc/receiptMatch";
import {
  attachReceiptToTx,
  applyPendingSplits,
  applyPendingLines,
} from "../../cc/receiptAttach";
import { isCcEntity } from "../../cc/ccConstants";
import type {
  CandidateTx,
  CcReceiptStatus,
  CcSource,
  CcUploadMethod,
  EntitySplitInput,
  InboxItem,
  InboxRow,
  InboxStatus,
  LineAllocation,
  MatchResult,
  NormalizedReceipt,
  PerFileResult,
  ReceiptLine,
  ReceiptOcrData,
  TxRow,
} from "../../cc/ccTypes";

/**
 * Additive local extensions (keeps `ccTypes.ts` untouched — both fields are
 * optional/additive). `pending_splits` is the new nullable inbox column; a queued
 * drop stashes an exec's entity split there until the receipt matches a tx.
 */
type PerFileResultOut = PerFileResult & { split_applied?: boolean };
type InboxRowWithSplits = InboxRow & { pending_splits: string | null };

/**
 * Defensively parses the optional `pending_splits` drop field — a JSON string of
 * `[{entity_name, amount}]` (the exec's entity split from the mobile submit).
 * Returns validated rows (every `entity_name ∈ CC_ENTITIES`, every `amount`
 * finite) or null when absent/empty/malformed. A bad payload is ignored, never
 * throws — it must NOT break the drop. (Sum-vs-amount is checked later by
 * `validateSplits` inside `applyPendingSplits`, once a tx amount is known.)
 */
function parsePendingSplits(raw: unknown): EntitySplitInput[] | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const rows: EntitySplitInput[] = [];
    for (const r of parsed) {
      const nameRaw = (r as { entity_name?: unknown })?.entity_name;
      const name = typeof nameRaw === "string" ? nameRaw : "";
      const amtRaw = (r as { amount?: unknown })?.amount;
      const amount = typeof amtRaw === "number" ? amtRaw : Number(amtRaw);
      if (!isCcEntity(name) || !Number.isFinite(amount)) {
        return null; // malformed row → ignore the whole payload (no partial split)
      }
      rows.push({ entity_name: name, amount });
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Defensively parses the NEW rich lines payload — the `lines` array of a
 * `{ lines: ReceiptLine[] }` stash/submit (per-line entity × location ×
 * gl_category coding). Returns the lines when every line is well-formed enough to
 * hand to `validateLineCoding` at apply time (each line an object with a finite
 * `amount` and an `allocations` array whose rows carry a CC entity, a non-empty
 * location string, a non-empty gl_category string, and a finite amount), or null
 * when absent/empty/malformed. Deliberately LOOSE: the authoritative
 * reconcile/location/gl check is `validateLineCoding(tx.amount, …)` inside
 * `applyPendingLines` (the tx amount isn't known here). Never throws — a bad
 * payload is ignored, it must NOT break the drop.
 */
function parsePendingLines(raw: unknown): ReceiptLine[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ReceiptLine[] = [];
  for (const l of raw) {
    if (!l || typeof l !== "object") return null;
    const line = l as {
      kind?: unknown;
      description?: unknown;
      amount?: unknown;
      line_index?: unknown;
      quantity?: unknown;
      unit_price?: unknown;
      receipt_id?: unknown;
      is_coded?: unknown;
      allocations?: unknown;
    };
    const amount = typeof line.amount === "number" ? line.amount : Number(line.amount);
    if (!Number.isFinite(amount)) return null;

    const allocsRaw = Array.isArray(line.allocations) ? line.allocations : [];
    const allocations: LineAllocation[] = [];
    for (const a of allocsRaw) {
      const alloc = (a ?? {}) as {
        entity_name?: unknown;
        location?: unknown;
        gl_category?: unknown;
        amount?: unknown;
        is_tax?: unknown;
      };
      const name = typeof alloc.entity_name === "string" ? alloc.entity_name : "";
      if (!isCcEntity(name)) return null; // malformed row → ignore the whole payload
      if (typeof alloc.location !== "string" || alloc.location.trim() === "") return null;
      if (typeof alloc.gl_category !== "string" || alloc.gl_category.trim() === "") return null;
      const amt = typeof alloc.amount === "number" ? alloc.amount : Number(alloc.amount);
      if (!Number.isFinite(amt)) return null;
      allocations.push({
        entity_name: name,
        location: alloc.location,
        gl_category: alloc.gl_category,
        amount: amt,
        is_tax: alloc.is_tax === true,
      });
    }

    out.push({
      kind: line.kind === "TAX" ? "TAX" : "ITEM",
      description: typeof line.description === "string" ? line.description : "",
      amount,
      line_index: typeof line.line_index === "number" ? line.line_index : undefined,
      quantity: typeof line.quantity === "number" ? line.quantity : null,
      unit_price: typeof line.unit_price === "number" ? line.unit_price : null,
      receipt_id: typeof line.receipt_id === "string" ? line.receipt_id : null,
      is_coded: line.is_coded === true,
      allocations,
    });
  }
  return out.length ? out : null;
}

/** A shape-detected carried split: the NEW rich lines shape, or the legacy one. */
type PendingPayload =
  | { kind: "lines"; lines: ReceiptLine[] }
  | { kind: "splits"; rows: EntitySplitInput[] };

/**
 * Shape-detecting parse for the carried exec split — the multipart drop field,
 * the stashed `pending_splits` TEXT column, or a PATCH body slice. Two shapes:
 *   - NEW rich lines `{ lines: ReceiptLine[] }` (entity × location × gl_category)
 *     → applied via `applyPendingLines` (replaceLines + deriveEntitySplits).
 *   - LEGACY entity-only `[{entity_name, amount}]` (a bare array) → applied via
 *     `applyPendingSplits` (cc_entity_splits only), the pre-v2 behavior.
 * `raw` may be a JSON string (the field / the column) or an already-parsed value
 * (a PATCH body value). Absent/malformed → null; never throws — a bad payload
 * must NOT break the drop. Entity/location/gl are checked loosely here; the
 * authoritative reconcile is `validateLineCoding` at apply time.
 */
function parsePendingPayload(raw: unknown): PendingPayload | null {
  // Normalize a JSON string to a parsed value; keep an already-parsed value as-is.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed == null) return null;

  // NEW shape: an object carrying a `lines` array.
  if (!Array.isArray(parsed) && typeof parsed === "object") {
    const lines = parsePendingLines((parsed as { lines?: unknown }).lines);
    return lines ? { kind: "lines", lines } : null;
  }

  // LEGACY shape: a bare entity-split array. Re-serialize so parsePendingSplits
  // (which takes the JSON string) can validate it unchanged.
  const rows = parsePendingSplits(JSON.stringify(parsed));
  return rows ? { kind: "splits", rows } : null;
}

/**
 * Serializes a shape-detected payload back to a canonical JSON string for the
 * `pending_splits` TEXT column: `{ lines: [...] }` for the rich shape, a bare
 * `[{entity_name, amount}]` array for the legacy shape — so a later
 * `parsePendingPayload` round-trips it to the same shape.
 */
function serializePendingPayload(p: PendingPayload): string {
  return JSON.stringify(p.kind === "lines" ? { lines: p.lines } : p.rows);
}

export const inbox = new Hono<AppEnv>();

const MAX_RECEIPT_BYTES = 20 * 1024 * 1024; // 20MB (mirrors receipts.ts)
const ALLOWED_RECEIPT_TYPES = /pdf|jpe?g|png/i;
const UPLOAD_METHODS: CcUploadMethod[] = [
  "CAPITAL_ONE_APP",
  "INVOICE_IQ_APP",
  "MANUAL_UPLOAD",
  "MANAGER_UPLOAD",
];
const NOT_READY = {
  error: "Credit Cards needs a one-time database setup — run the migration.",
} as const;

function isManager(c: import("hono").Context<AppEnv>): boolean {
  return hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT);
}

/** An empty normalized receipt (OCR-failure / no-file degradation). */
function emptyReceipt(): NormalizedReceipt {
  return {
    merchant_name: "",
    transaction_date: "",
    total: null,
    card_last_4: "",
    cardholder_name: "",
    line_items: [],
    sales_tax: null,
  };
}

/** Builds the `ReceiptOcrData` JSON persisted in `cc_receipt_inbox.ocr_extracted_data`. */
function ocrJson(normalized: NormalizedReceipt, match: MatchResult): ReceiptOcrData {
  return {
    merchant_name: normalized.merchant_name,
    transaction_date: normalized.transaction_date,
    total: normalized.total,
    card_last_4: normalized.card_last_4,
    cardholder_name: normalized.cardholder_name,
    line_items: normalized.line_items,
    sales_tax: normalized.sales_tax,
    match: match.match,
    confidence: match.confidence,
    resolved_cardholder_id: match.cardholder_id,
  };
}

/** Joins a cardholder display name (or "UNMATCHED"). */
async function cardholderName(
  env: AppEnv["Bindings"],
  cardholderId: string | null,
): Promise<string> {
  if (!cardholderId) return "UNMATCHED";
  try {
    const ch = await env.DB.prepare(
      "SELECT first_name, last_name FROM cc_cardholders WHERE id = ?",
    )
      .bind(cardholderId)
      .first<{ first_name: string; last_name: string | null }>();
    if (ch) return `${ch.first_name}${ch.last_name ? ` ${ch.last_name}` : ""}`;
  } catch {
    /* keep UNMATCHED on lookup failure */
  }
  return "UNMATCHED";
}

/** Hydrates an inbox row (parses JSON, joins the cardholder name). */
async function hydrateInbox(
  env: AppEnv["Bindings"],
  r: InboxRow,
  opts: { withCandidates?: boolean } = {},
): Promise<InboxItem> {
  let ocr: ReceiptOcrData | null = null;
  if (r.ocr_extracted_data) {
    try {
      ocr = JSON.parse(r.ocr_extracted_data) as ReceiptOcrData;
    } catch {
      ocr = null;
    }
  }
  let candidateIds: string[] = [];
  if (r.candidate_transaction_ids) {
    try {
      const arr = JSON.parse(r.candidate_transaction_ids);
      if (Array.isArray(arr)) candidateIds = arr.filter((x): x is string => typeof x === "string");
    } catch {
      candidateIds = [];
    }
  }

  // v1.9.2: surface the executive's carried split (if any) so the accountant can
  // review/edit it before assigning. Never throws — a bad payload just omits it.
  let pendingSplit: InboxItem["pending_split"] = null;
  const carried = parsePendingPayload((r as InboxRowWithSplits).pending_splits);
  if (carried) {
    pendingSplit =
      carried.kind === "lines"
        ? { lines: carried.lines }
        : { entity_splits: carried.rows };
  }

  const item: InboxItem = {
    id: r.id,
    uploaded_by: r.uploaded_by,
    cardholder_id: r.cardholder_id,
    cardholder_name: await cardholderName(env, r.cardholder_id),
    source_guess: (r.source_guess as CcSource | null) ?? null,
    r2_key: r.r2_key,
    file_name: r.file_name,
    file_type: r.file_type,
    file_size_bytes: r.file_size_bytes,
    ocr_extracted_data: ocr,
    status: r.status as InboxStatus,
    matched_transaction_id: r.matched_transaction_id,
    matched_receipt_id: r.matched_receipt_id,
    candidate_transaction_ids: candidateIds,
    return_note: r.return_note,
    returned_by: r.returned_by,
    resolved_by: r.resolved_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    pending_split: pendingSplit,
  };

  if (opts.withCandidates && candidateIds.length > 0) {
    item.candidates = await loadCandidates(env, candidateIds);
  }
  return item;
}

/** Loads the joined candidate transactions for a queued inbox item. */
async function loadCandidates(
  env: AppEnv["Bindings"],
  ids: string[],
): Promise<CandidateTx[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT id, vendor, amount, transaction_date, receipt_status, cardholder_id
       FROM cc_transactions WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .all<{
      id: string;
      vendor: string;
      amount: number;
      transaction_date: string;
      receipt_status: string;
      cardholder_id: string | null;
    }>();
  const byId = new Map(
    (res.results ?? []).map((r) => [r.id, r] as const),
  );
  // Preserve the stored candidate order.
  const out: CandidateTx[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      id: r.id,
      vendor: r.vendor,
      amount: r.amount,
      transaction_date: r.transaction_date,
      receipt_status: r.receipt_status as CcReceiptStatus,
      cardholder_id: r.cardholder_id,
      cardholder_name: await cardholderName(env, r.cardholder_id),
    });
  }
  return out;
}

function fetchInbox(env: AppEnv["Bindings"], id: string): Promise<InboxRow | null> {
  return env.DB.prepare("SELECT * FROM cc_receipt_inbox WHERE id = ?")
    .bind(id)
    .first<InboxRow>();
}

function fetchTx(env: AppEnv["Bindings"], id: string): Promise<TxRow | null> {
  return env.DB.prepare("SELECT * FROM cc_transactions WHERE id = ?")
    .bind(id)
    .first<TxRow>();
}

/** True if `u` is the dropper who owns this inbox row (keyed on uploaded_by). */
function ownsInbox(c: import("hono").Context<AppEnv>, r: InboxRow): boolean {
  return r.uploaded_by === user(c).id;
}

// ---------------------------------------------------------------------------
// POST /receipts/inbox — bulk drop (cardholder OR manager)
// ---------------------------------------------------------------------------
inbox.post("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);
  // Any CC-enabled user (cardholder or manager) may drop.

  const form = await c.req.formData();
  const files = form.getAll("file");
  let uploadMethod = String(form.get("upload_method") ?? "").trim() as CcUploadMethod;
  if (!UPLOAD_METHODS.includes(uploadMethod)) uploadMethod = "MANUAL_UPLOAD";

  if (files.length === 0) return c.json({ error: "No file provided" }, 400);

  // NEW (additive): the exec's carried split, sent by the mobile submit. May be the
  // rich `{ lines }` shape (entity × location × gl) OR the legacy `[{entity_name,
  // amount}]` array; shape-detected here. Absent for every desktop/manager drop →
  // null → the branches below behave exactly as today.
  const pendingPayload = parsePendingPayload(form.get("pending_splits"));

  const u = user(c);
  const managerActing = isManager(c);
  const results: PerFileResultOut[] = [];

  // Sequential loop: keeps Reducto / D1 load bounded; one bad file → ERROR result,
  // the rest proceed.
  for (const entry of files) {
    const file = entry as unknown as {
      arrayBuffer(): Promise<ArrayBuffer>;
      name?: string;
      type?: string;
    } | string | null;

    if (!file || typeof file === "string") {
      results.push({ file_name: "receipt", status: "ERROR", inbox_id: "", error: "No file provided" });
      continue;
    }

    const fileName = file.name ?? "receipt";
    const fileType = file.type ?? "";

    // Per-file validation (type + size) — a bad file is its own ERROR result.
    if (!ALLOWED_RECEIPT_TYPES.test(fileType) && !ALLOWED_RECEIPT_TYPES.test(fileName)) {
      results.push({ file_name: fileName, status: "ERROR", inbox_id: "", error: "Unsupported file type" });
      continue;
    }

    let buf: ArrayBuffer;
    try {
      buf = await file.arrayBuffer();
    } catch {
      results.push({ file_name: fileName, status: "ERROR", inbox_id: "", error: "Could not read file" });
      continue;
    }
    if (buf.byteLength > MAX_RECEIPT_BYTES) {
      results.push({ file_name: fileName, status: "ERROR", inbox_id: "", error: "File too large (max 20MB)" });
      continue;
    }

    try {
      // Store bytes under the inbox id (same receipts/cc/... prefix as cc_receipts).
      const inboxId = uuid();
      const ext = ccExtForType(fileType);
      const r2Key = ccReceiptKey(inboxId, ext);
      await ccPut(c.env, r2Key, buf, fileType || "application/pdf");

      // Best-effort OCR: a Reducto failure degrades to an empty receipt and queues.
      let normalized = emptyReceipt();
      try {
        const { raw, data } = await extractReceiptBytes(c.env, buf, fileName);
        normalized = normalizeReceipt(data);
        try {
          await ccPutReductoRaw(c.env, r2Key, raw);
        } catch (e) {
          console.error("[cc] inbox reducto sidecar write failed:", e);
        }
      } catch (e) {
        console.error("[cc] inbox receipt OCR failed (queuing without OCR):", e);
      }

      // Resolve cardholder + candidate → outcome (never throws; degrades to queued).
      const outcome = await matchReceiptToTransaction(c.env, normalized);
      const at = nowIso();
      const ocr = ocrJson(normalized, outcome.match);

      if (outcome.kind === "matched") {
        // Auto-attach via the shared helper, then record the MATCHED inbox row.
        const attached = await attachReceiptToTx(c.env, {
          txId: outcome.transactionId,
          r2Key,
          fileName,
          fileType,
          sizeBytes: buf.byteLength,
          normalized,
          match: outcome.match,
          uploadMethod,
          uploadedBy: u.id,
          fireAlert: !managerActing,
          uploaderName: u.name,
          sourceIsShared: true, // shared inbox-drop key (H5)
        });
        await c.env.DB.prepare(
          `INSERT INTO cc_receipt_inbox
             (id, uploaded_by, cardholder_id, source_guess, r2_key, file_name, file_type,
              file_size_bytes, ocr_extracted_data, status, matched_transaction_id,
              matched_receipt_id, candidate_transaction_ids, resolved_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            inboxId,
            u.id,
            outcome.cardholderId,
            outcome.sourceGuess,
            r2Key,
            fileName,
            fileType || null,
            buf.byteLength,
            JSON.stringify(ocr),
            "MATCHED",
            outcome.transactionId,
            attached.receiptId,
            JSON.stringify([outcome.transactionId]),
            u.id,
            at,
            at,
          )
          .run();

        const matchedResult: PerFileResultOut = {
          file_name: fileName,
          status: "MATCHED",
          inbox_id: inboxId,
          matched_transaction_id: outcome.transactionId,
          ocr: { ...normalized, match: outcome.match.match, confidence: outcome.match.confidence },
        };
        // Apply-at-match (C.6b): the drop auto-matched, so apply the carried split
        // immediately via the shared helper (never stashed — it's applied here).
        // Rich lines → applyPendingLines (replaceLines + deriveEntitySplits); legacy
        // → applyPendingSplits. Both validate vs tx.amount and never throw.
        if (pendingPayload) {
          matchedResult.split_applied =
            pendingPayload.kind === "lines"
              ? await applyPendingLines(c.env, outcome.transactionId, pendingPayload.lines)
              : await applyPendingSplits(c.env, outcome.transactionId, pendingPayload.rows);
        }
        results.push(matchedResult);
      } else {
        // Queue: PENDING_MATCH with candidates. No cc_receipts row; tx untouched.
        // NEW (additive): stash the carried exec split (if any) on `pending_splits`
        // to apply on later match; null for every drop that didn't send it. The
        // stash is canonical JSON (either shape) — a later match re-detects it.
        await c.env.DB.prepare(
          `INSERT INTO cc_receipt_inbox
             (id, uploaded_by, cardholder_id, source_guess, r2_key, file_name, file_type,
              file_size_bytes, ocr_extracted_data, status, candidate_transaction_ids,
              pending_splits, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
          .bind(
            inboxId,
            u.id,
            outcome.cardholderId,
            outcome.sourceGuess,
            r2Key,
            fileName,
            fileType || null,
            buf.byteLength,
            JSON.stringify(ocr),
            "PENDING_MATCH",
            JSON.stringify(outcome.candidateIds),
            pendingPayload ? serializePendingPayload(pendingPayload) : null,
            at,
            at,
          )
          .run();

        results.push({
          file_name: fileName,
          status: "PENDING_MATCH",
          inbox_id: inboxId,
          candidate_transaction_ids: outcome.candidateIds,
          ocr: { ...normalized, match: outcome.match.match, confidence: outcome.match.confidence },
        });
      }
    } catch (e) {
      console.error("[cc] inbox drop failed for", fileName, e);
      results.push({ file_name: fileName, status: "ERROR", inbox_id: "", error: "Processing failed" });
    }
  }

  return c.json({ results }, 201);
});

// ---------------------------------------------------------------------------
// GET /receipts/inbox — manager queue (+ joined candidates)
// ---------------------------------------------------------------------------
inbox.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const statusParam = (c.req.query("status") ?? "PENDING_MATCH").toUpperCase();
  const cardholderId = c.req.query("cardholder_id") ?? "";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (statusParam && statusParam !== "ALL") {
    where.push("status = ?");
    binds.push(statusParam);
  }
  if (cardholderId) {
    where.push("cardholder_id = ?");
    binds.push(cardholderId);
  }
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const res = await c.env.DB.prepare(
    `SELECT * FROM cc_receipt_inbox${clause} ORDER BY created_at DESC`,
  )
    .bind(...binds)
    .all<InboxRow>();

  const items: InboxItem[] = [];
  for (const r of res.results ?? []) {
    items.push(await hydrateInbox(c.env, r, { withCandidates: true }));
  }
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// GET /receipts/inbox/mine — caller's own drops (queued + returned)
// ---------------------------------------------------------------------------
inbox.get("/mine", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);

  const u = user(c);
  const statusParam = (c.req.query("status") ?? "").toUpperCase();

  const where = ["uploaded_by = ?"];
  const binds: unknown[] = [u.id];
  if (statusParam && statusParam !== "ALL") {
    where.push("status = ?");
    binds.push(statusParam);
  }

  const res = await c.env.DB.prepare(
    `SELECT * FROM cc_receipt_inbox WHERE ${where.join(" AND ")} ORDER BY created_at DESC`,
  )
    .bind(...binds)
    .all<InboxRow>();

  const items: InboxItem[] = [];
  for (const r of res.results ?? []) {
    items.push(await hydrateInbox(c.env, r, { withCandidates: true }));
  }
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// GET /receipts/inbox/:id/file — stream bytes inline (manager OR owner-dropper)
// ---------------------------------------------------------------------------
inbox.get("/:id/file", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);

  const id = c.req.param("id");
  const row = await fetchInbox(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!isManager(c) && !ownsInbox(c, row)) return c.json({ error: "Forbidden" }, 403);

  const obj = await ccGet(c.env, row.r2_key);
  if (!obj) return c.json({ error: "Not found" }, 404);
  return new Response(obj.body, {
    headers: {
      "content-type": row.file_type || "application/pdf",
      "content-disposition": `inline; filename="${row.file_name}"`,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /receipts/inbox/:id/assign — manager assigns a queued item to a tx
// ---------------------------------------------------------------------------
inbox.post("/:id/assign", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const row = await fetchInbox(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { transaction_id?: string };
  const txId = (body.transaction_id ?? "").trim();
  if (!txId) return c.json({ error: "transaction_id is required" }, 400);

  const tx = await fetchTx(c.env, txId);
  if (!tx) return c.json({ error: "Transaction not found" }, 400);

  // Parse the persisted OCR JSON to rebuild the normalized receipt + match.
  let ocr: ReceiptOcrData | null = null;
  if (row.ocr_extracted_data) {
    try {
      ocr = JSON.parse(row.ocr_extracted_data) as ReceiptOcrData;
    } catch {
      ocr = null;
    }
  }
  const normalized: NormalizedReceipt = ocr
    ? {
        merchant_name: ocr.merchant_name,
        transaction_date: ocr.transaction_date,
        total: ocr.total,
        card_last_4: ocr.card_last_4,
        cardholder_name: ocr.cardholder_name,
        line_items: ocr.line_items ?? [],
        sales_tax: ocr.sales_tax ?? null,
      }
    : emptyReceipt();
  const match: MatchResult = ocr
    ? { cardholder_id: ocr.resolved_cardholder_id, match: ocr.match, confidence: ocr.confidence }
    : { cardholder_id: null, match: "UNMATCHED", confidence: "LOW" };

  // Manager-driven attach: do NOT re-alert (the manager is the one acting).
  const attached = await attachReceiptToTx(c.env, {
    txId,
    r2Key: row.r2_key,
    fileName: row.file_name,
    fileType: row.file_type ?? "",
    sizeBytes: row.file_size_bytes ?? 0,
    normalized,
    match,
    uploadMethod: "MANAGER_UPLOAD",
    uploadedBy: row.uploaded_by,
    fireAlert: false,
    sourceIsShared: true, // assigns from a surviving inbox row's key (H5)
  });

  // Apply-on-later-match (C.6c): if this queued row carried an exec split, apply it
  // to the just-attached tx now. Shape-detected: rich lines → applyPendingLines
  // (replaceLines + deriveEntitySplits); legacy → applyPendingSplits. No-op when
  // the column is null/absent. Both validate vs `tx.amount` and never throw, so a
  // mismatch/failure leaves the tx uncoded for the manager and never blocks attach.
  const carried = parsePendingPayload((row as InboxRowWithSplits).pending_splits);
  if (carried) {
    if (carried.kind === "lines") await applyPendingLines(c.env, txId, carried.lines);
    else await applyPendingSplits(c.env, txId, carried.rows);
  }

  const at = nowIso();
  const u = user(c);
  // `pending_splits = NULL` clears the carried split now that it's had its one shot
  // (no-op when the row never carried one).
  await c.env.DB.prepare(
    `UPDATE cc_receipt_inbox
        SET status = 'MATCHED', matched_transaction_id = ?, matched_receipt_id = ?,
            resolved_by = ?, pending_splits = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(txId, attached.receiptId, u.id, at, id)
    .run();

  const updated = await fetchInbox(c.env, id);
  return c.json(
    {
      item: updated ? await hydrateInbox(c.env, updated) : null,
      receipt: attached.receipt,
      transaction: attached.transaction,
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// POST /receipts/inbox/:id/return — manager sends an item back with a note
// ---------------------------------------------------------------------------
inbox.post("/:id/return", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);
  if (!isManager(c)) return c.json({ error: "Forbidden" }, 403);

  const id = c.req.param("id");
  const row = await fetchInbox(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { note?: string };
  const note = typeof body.note === "string" ? body.note.trim() : "";

  const at = nowIso();
  const u = user(c);
  await c.env.DB.prepare(
    `UPDATE cc_receipt_inbox
        SET status = 'RETURNED', return_note = ?, returned_by = ?, updated_at = ?
      WHERE id = ?`,
  )
    .bind(note || null, u.id, at, id)
    .run();

  const updated = await fetchInbox(c.env, id);
  return c.json({ item: updated ? await hydrateInbox(c.env, updated) : null });
});

// ---------------------------------------------------------------------------
// PATCH /receipts/inbox/:id/pending_splits — attach the exec's entity split to
// an EXISTING drop row (owner-dropper OR manager). This is the single-row path
// used by the mobile submit: the photo was already dropped once (at /review, to
// get OCR), so instead of re-dropping (which would create a duplicate inbox row)
// the split is attached to that same row here.
//   - Row already matched to a tx → apply the split now (validated) + clear it.
//   - Still PENDING_MATCH/RETURNED → stash on `pending_splits` to apply on match.
// ---------------------------------------------------------------------------
inbox.patch("/:id/pending_splits", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);

  const id = c.req.param("id");
  const row = await fetchInbox(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);
  // The dropper who owns this row, or any manager, may attach the split.
  if (!isManager(c) && !ownsInbox(c, row)) return c.json({ error: "Forbidden" }, 403);

  // Accept the NEW rich `{ lines: [...] }` shape, the legacy `{ splits: [...] }`
  // array (mirrors PUT /splits), or a raw `{ pending_splits: ... }` slice (either
  // shape). parsePendingPayload shape-detects and loosely validates; a JSON string
  // or an already-parsed value both round-trip.
  const body = (await c.req.json().catch(() => ({}))) as {
    lines?: unknown;
    splits?: unknown;
    pending_splits?: unknown;
  };
  const candidate =
    body.lines !== undefined ? { lines: body.lines } : (body.splits ?? body.pending_splits);
  const payload = parsePendingPayload(candidate);
  if (!payload) return c.json({ error: "Invalid or empty splits" }, 400);

  const at = nowIso();

  // Already attached to a tx (auto-matched at the preview drop, or manager-assigned
  // in between): apply immediately via the shared validated write path, then clear
  // the stash. Rich lines → applyPendingLines; legacy → applyPendingSplits. Both
  // validate vs tx.amount and never throw.
  if (row.matched_transaction_id) {
    const applied =
      payload.kind === "lines"
        ? await applyPendingLines(c.env, row.matched_transaction_id, payload.lines)
        : await applyPendingSplits(c.env, row.matched_transaction_id, payload.rows);
    await c.env.DB.prepare(
      "UPDATE cc_receipt_inbox SET pending_splits = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(at, id)
      .run();
    return c.json({ applied, pending: false });
  }

  // Not yet matched: stash the (canonical) split to apply automatically on a later
  // match (POST /:id/assign and the auto-match drop both consume `pending_splits`).
  await c.env.DB.prepare(
    "UPDATE cc_receipt_inbox SET pending_splits = ?, updated_at = ? WHERE id = ?",
  )
    .bind(serializePendingPayload(payload), at, id)
    .run();
  return c.json({ applied: false, pending: true });
});

// ---------------------------------------------------------------------------
// DELETE /receipts/inbox/:id — manager, or owner-dropper while PENDING_MATCH
// ---------------------------------------------------------------------------
inbox.delete("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json(NOT_READY, 503);

  const id = c.req.param("id");
  const row = await fetchInbox(c.env, id);
  if (!row) return c.json({ error: "Not found" }, 404);

  const owner = ownsInbox(c, row);
  // Manager may delete any; the dropper may delete their own only while queued.
  if (!isManager(c) && !(owner && row.status === "PENDING_MATCH"))
    return c.json({ error: "Forbidden" }, 403);

  // v1.9.10 (H5): delete the row FIRST, then refcount-guard the object delete so
  // a legacy shared key still referenced by a cc_receipts row isn't destroyed
  // out from under the live receipt.
  await c.env.DB.prepare("DELETE FROM cc_receipt_inbox WHERE id = ?").bind(id).run();
  await ccMaybeDeleteObject(c.env, row.r2_key);

  return c.body(null, 204);
});
