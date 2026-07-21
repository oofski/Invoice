/**
 * CCRMS notifications routes (NEW — Agent A3).
 *
 *   - POST /notifications/send  — manager fans receipt reminders to cardholders;
 *                                 the PENDING list is recomputed SERVER-SIDE per
 *                                 cardholder, split into Cap One / Amex sections,
 *                                 sent via `sendCcReminder`, and logged as ONE
 *                                 `cc_notifications` row per attempt (delivery ∈
 *                                 SENT|NOT_CONFIGURED|FAILED, is_followup flag).
 *                                 Never throws — always returns the tally.
 *   - GET  /notifications       — manager: all; scoped cardholder: own only.
 *                                 List view truncates/omits `body_html`.
 *   - GET  /notifications/:id    — full `body_html`; 403 if scoped non-recipient.
 *
 * Every handler runs the §2 preamble: flag gate (404), migration gate (503),
 * role gate (403), validation (400). The mounter (A2) imports this file by the
 * fixed name `notifications`.
 */
import { Hono } from "hono";
import type { AppEnv } from "../helpers";
import { user, hasRole } from "../helpers";
import { ROLES } from "../../lib/constants";
import { uuid, chunk } from "../../lib/util";
import {
  isCcEnabled,
  ccReady,
  ownsCardholder,
  cardholderScopeSubquery,
} from "../../cc/flag";
import { sendCcReminder, renderCcReminder } from "../../cc/ccEmail";
import type {
  Tx,
  TxRow,
  CardholderRow,
  Notification,
  NotificationRow,
  CcReceiptStatus,
  CcSource,
} from "../../cc/ccTypes";

export const notifications = new Hono<AppEnv>();

const MIGRATION_MSG =
  "Credit Cards needs a one-time database setup — run the migration.";

/** Max chars of `body_html` returned in list views (full body via GET /:id). */
const BODY_PREVIEW_LEN = 280;

/** Hydrate a notification row → API DTO (0/1 → bool, transaction_ids JSON → []). */
function hydrateNotification(r: NotificationRow, truncateBody: boolean): Notification {
  let txIds: string[] = [];
  try {
    const parsed = JSON.parse(r.transaction_ids);
    if (Array.isArray(parsed)) txIds = parsed.filter((x): x is string => typeof x === "string");
  } catch {
    txIds = [];
  }
  const body =
    truncateBody && r.body_html.length > BODY_PREVIEW_LEN
      ? r.body_html.slice(0, BODY_PREVIEW_LEN)
      : r.body_html;
  return {
    id: r.id,
    batch_id: r.batch_id,
    cardholder_id: r.cardholder_id,
    sent_by: r.sent_by,
    email_to: r.email_to,
    subject: r.subject,
    body_html: body,
    transaction_ids: txIds,
    delivery: r.delivery as Notification["delivery"],
    is_followup: !!r.is_followup,
    sent_at: r.sent_at,
    opened_at: r.opened_at,
    created_at: r.created_at,
  };
}

/** Minimal hydration of a `cc_transactions` row → the `Tx` shape the email needs. */
function hydrateTxForEmail(r: TxRow): Tx {
  return {
    id: r.id,
    source: r.source as CcSource,
    upload_batch_id: r.upload_batch_id,
    cardholder_id: r.cardholder_id,
    cardholder_name: "",
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

/**
 * The server-side PENDING set for a cardholder: non-payment, non-credit
 * transactions whose receipt is still outstanding (`receipt_status='PENDING'`).
 * Optionally narrowed to a caller-supplied id list (still re-filtered server-side
 * so the client can never widen the set). Never trusts the client's notion of
 * "pending".
 */
async function pendingForCardholder(
  env: AppEnv["Bindings"],
  cardholderId: string,
  restrictIds: string[] | null,
): Promise<TxRow[]> {
  const baseSql =
    `SELECT * FROM cc_transactions
      WHERE cardholder_id = ?
        AND is_payment = 0
        AND is_credit = 0
        AND receipt_status = 'PENDING'`;

  // No id restriction → a single query with the original ordering.
  if (!restrictIds || restrictIds.length === 0) {
    const rows = await env.DB
      .prepare(`${baseSql} ORDER BY transaction_date DESC`)
      .bind(cardholderId)
      .all<TxRow>();
    return rows.results ?? [];
  }

  // Restricted: D1 caps bound params at 100, so batch the id list (one `?` per id
  // + the cardholder_id param) and merge, then re-apply the DESC ordering across
  // batches so the contract holds.
  const out: TxRow[] = [];
  for (const batch of chunk(restrictIds)) {
    const ph = batch.map(() => "?").join(",");
    const rows = await env.DB
      .prepare(`${baseSql} AND id IN (${ph})`)
      .bind(cardholderId, ...batch)
      .all<TxRow>();
    out.push(...(rows.results ?? []));
  }
  out.sort((a, b) => (b.transaction_date ?? "").localeCompare(a.transaction_date ?? ""));
  return out;
}

/**
 * Whether a prior notification exists for this cardholder that overlaps any of
 * `txIds` (→ this send is a follow-up). Checks the JSON `transaction_ids` of
 * earlier rows for any shared id.
 */
async function isFollowup(
  env: AppEnv["Bindings"],
  cardholderId: string,
  txIds: string[],
): Promise<boolean> {
  if (txIds.length === 0) {
    // No specific tx overlap to test — treat any prior notification as a follow-up.
    const prior = await env.DB.prepare(
      "SELECT 1 FROM cc_notifications WHERE cardholder_id = ? LIMIT 1",
    )
      .bind(cardholderId)
      .first();
    return !!prior;
  }
  const prior = await env.DB.prepare(
    "SELECT transaction_ids FROM cc_notifications WHERE cardholder_id = ?",
  )
    .bind(cardholderId)
    .all<{ transaction_ids: string }>();
  const target = new Set(txIds);
  for (const row of prior.results ?? []) {
    try {
      const ids = JSON.parse(row.transaction_ids);
      if (Array.isArray(ids) && ids.some((x) => typeof x === "string" && target.has(x)))
        return true;
    } catch {
      /* ignore malformed prior rows */
    }
  }
  return false;
}

// ----- POST /send (manager only) --------------------------------------
notifications.post("/send", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);
  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT))
    return c.json({ error: "Forbidden" }, 403);

  const body = (await c.req.json().catch(() => ({}))) as {
    cardholder_ids?: unknown;
    transaction_ids?: unknown;
  };

  const restrictIds = Array.isArray(body.transaction_ids)
    ? body.transaction_ids.filter((x): x is string => typeof x === "string" && !!x)
    : null;

  // Resolve the target cardholder id list.
  let cardholderIds: string[];
  if (body.cardholder_ids === "ALL_PENDING") {
    // Every active cardholder carrying ≥1 PENDING (non-payment, non-credit) tx.
    const rows = await c.env.DB.prepare(
      `SELECT DISTINCT t.cardholder_id AS id
         FROM cc_transactions t
         JOIN cc_cardholders ch ON ch.id = t.cardholder_id AND ch.is_active = 1
        WHERE t.cardholder_id IS NOT NULL
          AND t.is_payment = 0 AND t.is_credit = 0
          AND t.receipt_status = 'PENDING'`,
    ).all<{ id: string }>();
    cardholderIds = (rows.results ?? []).map((r) => r.id);
  } else if (Array.isArray(body.cardholder_ids)) {
    cardholderIds = body.cardholder_ids.filter(
      (x): x is string => typeof x === "string" && !!x,
    );
  } else {
    cardholderIds = [];
  }

  if (cardholderIds.length === 0)
    return c.json(
      { error: "cardholder_ids (non-empty array or \"ALL_PENDING\") is required" },
      400,
    );

  const sender = user(c);
  // The "manager email" shown in the reminder footer ("contact Hunter at …").
  // The sender (Lori/manager) is the contact in v1.2.9; fall back to the Resend
  // from-address when the sender has no email.
  const managerEmail = sender.email || c.env.RESEND_FROM_EMAIL || "";

  let sentCount = 0;
  let notConfiguredCount = 0;
  let failedCount = 0;
  const out: Notification[] = [];

  for (const chId of cardholderIds) {
    const ch = await c.env.DB.prepare(
      "SELECT * FROM cc_cardholders WHERE id = ?",
    )
      .bind(chId)
      .first<CardholderRow>();
    if (!ch) continue; // skip unknown cardholder ids silently

    const pending = await pendingForCardholder(c.env, chId, restrictIds);
    if (pending.length === 0) continue; // nothing to remind about

    const capOneTx = pending.filter((t) => t.source === "CAPITAL_ONE").map(hydrateTxForEmail);
    const amexTx = pending.filter((t) => t.source === "AMEX").map(hydrateTxForEmail);
    const txIds = pending.map((t) => t.id);
    const recipient = (ch.email || "").trim();
    const firstName = ch.first_name || "there";

    // Render the email up front so we always have subject/body to log, even when
    // the send fails or there is no recipient. sendCcReminder never throws
    // (mirrors email.ts); a missing recipient email maps to NOT_CONFIGURED.
    const { subject, html: bodyHtml } = renderCcReminder({
      firstName,
      capOneTx,
      amexTx,
      managerEmail,
    });

    let delivery: NotificationRow["delivery"];
    if (!recipient) {
      delivery = "NOT_CONFIGURED";
      notConfiguredCount++;
    } else {
      const result = await sendCcReminder(c.env, recipient, {
        firstName,
        capOneTx,
        amexTx,
        managerEmail,
      });
      if (result.ok) {
        delivery = "SENT";
        sentCount++;
      } else if (result.reason === "not_configured") {
        delivery = "NOT_CONFIGURED";
        notConfiguredCount++;
      } else {
        delivery = "FAILED";
        failedCount++;
      }
    }

    const followup = await isFollowup(c.env, chId, txIds);
    const nowIso = new Date().toISOString();
    const notifId = uuid();
    const txIdsJson = JSON.stringify(txIds);

    await c.env.DB.prepare(
      `INSERT INTO cc_notifications
         (id, batch_id, cardholder_id, sent_by, email_to, subject, body_html,
          transaction_ids, delivery, is_followup, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        notifId,
        null,
        chId,
        sender.id,
        recipient || managerEmail || "",
        subject,
        bodyHtml,
        txIdsJson,
        delivery,
        followup ? 1 : 0,
        delivery === "SENT" ? nowIso : null,
      )
      .run();

    const row = await c.env.DB.prepare(
      "SELECT * FROM cc_notifications WHERE id = ?",
    )
      .bind(notifId)
      .first<NotificationRow>();
    if (row) out.push(hydrateNotification(row, false));
  }

  return c.json({
    sent_count: sentCount,
    not_configured_count: notConfiguredCount,
    failed_count: failedCount,
    notifications: out,
  });
});

// ----- GET / (list) ----------------------------------------------------
notifications.get("/", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);

  const isManager = hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT);

  let sql = "SELECT * FROM cc_notifications WHERE 1=1";
  const params: string[] = [];

  if (!isManager) {
    // Scoped cardholder: own notifications only — by cardholder_id linkage OR by
    // the recipient email matching their login email.
    const u = user(c);
    const scope = cardholderScopeSubquery(u); // v1.9.10 (H3): unique-name guarded
    sql += ` AND (cardholder_id IN (${scope.sql}) OR lower(email_to) = lower(?))`;
    params.push(...scope.params, (u.email || "").toLowerCase());
  }

  const cardholderId = c.req.query("cardholder_id");
  if (cardholderId) { sql += " AND cardholder_id = ?"; params.push(cardholderId); }
  const dateFrom = c.req.query("date_from");
  if (dateFrom) { sql += " AND created_at >= ?"; params.push(dateFrom); }
  const dateTo = c.req.query("date_to");
  if (dateTo) { sql += " AND created_at <= ?"; params.push(dateTo); }

  sql += " ORDER BY created_at DESC";

  const rows = await c.env.DB.prepare(sql).bind(...params).all<NotificationRow>();
  const out = (rows.results ?? []).map((r) => hydrateNotification(r, true));
  return c.json({ notifications: out });
});

// ----- GET /:id --------------------------------------------------------
notifications.get("/:id", async (c) => {
  if (!isCcEnabled(user(c))) return c.json({ error: "Not found" }, 404);
  if (!(await ccReady(c.env))) return c.json({ error: MIGRATION_MSG }, 503);

  const id = c.req.param("id");
  const row = await c.env.DB.prepare(
    "SELECT * FROM cc_notifications WHERE id = ?",
  )
    .bind(id)
    .first<NotificationRow>();
  if (!row) return c.json({ error: "Not found" }, 404);

  if (!hasRole(c, ROLES.CREDIT_CARD_ACCOUNTANT, ROLES.ADMIN, ROLES.ACCOUNTANT)) {
    // Scoped user may only read a notification they are the recipient of.
    const u = user(c);
    const owns = await ownsCardholder(c, row.cardholder_id); // v1.9.10 (H3)
    const emailMatch = (row.email_to || "").toLowerCase() === (u.email || "").toLowerCase();
    if (!owns && !emailMatch) return c.json({ error: "Forbidden" }, 403);
  }

  return c.json({ notification: hydrateNotification(row, false) });
});
