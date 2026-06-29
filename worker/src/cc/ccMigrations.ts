/**
 * CCRMS runtime schema migration + cardholder seed (NEW).
 *
 * MIRRORS `lib/migrations.ts` exactly:
 *   - a per-isolate `ccSchemaEnsured` latch (runs once per Worker isolate);
 *   - `env.DB.batch([...])` of `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX
 *     IF NOT EXISTS` (the dedup index is UNIQUE);
 *   - additive `ALTER TABLE ADD COLUMN` guarded in try/catch tolerating the
 *     expected `/duplicate column|already exists/i` so re-runs are no-ops;
 *   - NEVER throws — a transient D1 failure logs and is retried next request;
 *   - then idempotent `INSERT OR IGNORE` of the 15 seed cardholders (deterministic
 *     ids, `email` NULL) so re-seed is a no-op.
 *
 * Called from `index.ts`'s first-request hook after `ensureSeedData`.
 */
import type { Env } from "../lib/types";

let ccSchemaEnsured = false;

/** The 9 CC tables + their indexes (all IF NOT EXISTS — naturally idempotent). */
const CC_DDL: string[] = [
  // --- cc_cardholders ---
  `CREATE TABLE IF NOT EXISTS cc_cardholders (
     id              TEXT PRIMARY KEY,
     first_name      TEXT NOT NULL,
     last_name       TEXT,
     email           TEXT,
     card_source     TEXT NOT NULL,
     cap_one_last4   TEXT,
     amex_last5      TEXT,
     amex_sheet_name TEXT,
     user_id         TEXT,
     is_active       INTEGER NOT NULL DEFAULT 1,
     created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_ch_capone ON cc_cardholders(cap_one_last4)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_ch_amex ON cc_cardholders(amex_last5)`,

  // --- cc_upload_batches (incl. ratified staged_rows JSON staging column) ---
  `CREATE TABLE IF NOT EXISTS cc_upload_batches (
     id                TEXT PRIMARY KEY,
     uploaded_by       TEXT NOT NULL,
     source            TEXT NOT NULL,
     original_filename TEXT NOT NULL,
     r2_key            TEXT,
     period_start      TEXT,
     period_end        TEXT,
     transaction_count INTEGER NOT NULL DEFAULT 0,
     duplicate_count   INTEGER NOT NULL DEFAULT 0,
     skipped_count     INTEGER NOT NULL DEFAULT 0,
     status            TEXT NOT NULL DEFAULT 'PREVIEW',
     error_message     TEXT,
     staged_rows       TEXT,
     created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,

  // --- cc_transactions ---
  `CREATE TABLE IF NOT EXISTS cc_transactions (
     id               TEXT PRIMARY KEY,
     source           TEXT NOT NULL,
     upload_batch_id  TEXT,
     cardholder_id    TEXT,
     transaction_date TEXT NOT NULL,
     posted_date      TEXT,
     vendor           TEXT NOT NULL,
     description      TEXT,
     category         TEXT,
     amount           REAL NOT NULL,
     is_credit        INTEGER NOT NULL DEFAULT 0,
     is_payment       INTEGER NOT NULL DEFAULT 0,
     receipt_status   TEXT NOT NULL DEFAULT 'PENDING',
     in_qb            INTEGER NOT NULL DEFAULT 0,
     exp_acct         TEXT,
     notes            TEXT,
     dedup_key        TEXT,
     archived_at      TEXT,
     created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_tx_cardholder ON cc_transactions(cardholder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_tx_status ON cc_transactions(receipt_status)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_tx_source ON cc_transactions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_tx_date ON cc_transactions(transaction_date)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_cc_tx_dedup ON cc_transactions(dedup_key)`,

  // --- cc_entity_splits ---
  `CREATE TABLE IF NOT EXISTS cc_entity_splits (
     id             TEXT PRIMARY KEY,
     transaction_id TEXT NOT NULL,
     entity_name    TEXT NOT NULL,
     amount         REAL NOT NULL,
     created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_splits_tx ON cc_entity_splits(transaction_id)`,

  // --- cc_receipts ---
  `CREATE TABLE IF NOT EXISTS cc_receipts (
     id                 TEXT PRIMARY KEY,
     transaction_id     TEXT NOT NULL,
     uploaded_by        TEXT NOT NULL,
     upload_method      TEXT NOT NULL,
     r2_key             TEXT NOT NULL,
     file_name          TEXT NOT NULL,
     file_type          TEXT,
     file_size_bytes    INTEGER,
     ocr_extracted_data TEXT,
     verified_by        TEXT,
     verified_at        TEXT,
     created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_receipts_tx ON cc_receipts(transaction_id)`,

  // --- cc_notifications ---
  `CREATE TABLE IF NOT EXISTS cc_notifications (
     id              TEXT PRIMARY KEY,
     batch_id        TEXT,
     cardholder_id   TEXT NOT NULL,
     sent_by         TEXT NOT NULL,
     email_to        TEXT NOT NULL,
     subject         TEXT NOT NULL,
     body_html       TEXT NOT NULL,
     transaction_ids TEXT NOT NULL,
     delivery        TEXT NOT NULL DEFAULT 'SENT',
     is_followup     INTEGER NOT NULL DEFAULT 0,
     sent_at         TEXT,
     opened_at       TEXT,
     created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_notif_cardholder ON cc_notifications(cardholder_id)`,

  // --- cc_receipt_lines (one row per OCR/manual line of a tx; one kind='TAX' row holds the receipt sales tax) ---
  `CREATE TABLE IF NOT EXISTS cc_receipt_lines (
     id              TEXT PRIMARY KEY,
     transaction_id  TEXT NOT NULL,
     receipt_id      TEXT,
     line_index      INTEGER NOT NULL,
     kind            TEXT NOT NULL DEFAULT 'ITEM',
     description     TEXT,
     quantity        REAL,
     unit_price      REAL,
     amount          REAL NOT NULL,
     is_coded        INTEGER NOT NULL DEFAULT 0,
     created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_lines_tx ON cc_receipt_lines(transaction_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_lines_receipt ON cc_receipt_lines(receipt_id)`,

  // --- cc_line_allocations (per-line split across entity × location × GL category) ---
  `CREATE TABLE IF NOT EXISTS cc_line_allocations (
     id              TEXT PRIMARY KEY,
     line_id         TEXT NOT NULL,
     transaction_id  TEXT NOT NULL,
     entity_name     TEXT NOT NULL,
     location        TEXT NOT NULL,
     gl_category     TEXT NOT NULL,
     amount          REAL NOT NULL,
     is_tax          INTEGER NOT NULL DEFAULT 0,
     created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_alloc_tx ON cc_line_allocations(transaction_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_alloc_line ON cc_line_allocations(line_id)`,

  // --- cc_receipt_inbox (un-attached receipt drops awaiting auto-match / manager triage — Feature A) ---
  `CREATE TABLE IF NOT EXISTS cc_receipt_inbox (
     id                        TEXT PRIMARY KEY,
     uploaded_by               TEXT NOT NULL,
     cardholder_id             TEXT,
     source_guess              TEXT,
     r2_key                    TEXT NOT NULL,
     file_name                 TEXT NOT NULL,
     file_type                 TEXT,
     file_size_bytes           INTEGER,
     ocr_extracted_data        TEXT,
     status                    TEXT NOT NULL DEFAULT 'PENDING_MATCH',
     matched_transaction_id    TEXT,
     matched_receipt_id        TEXT,
     candidate_transaction_ids TEXT,
     return_note               TEXT,
     returned_by               TEXT,
     resolved_by               TEXT,
     created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cc_inbox_status ON cc_receipt_inbox(status)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_inbox_cardholder ON cc_receipt_inbox(cardholder_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cc_inbox_uploaded_by ON cc_receipt_inbox(uploaded_by)`,
];

/**
 * Additive `ALTER TABLE ADD COLUMN` migrations for tables that may already exist
 * from an earlier CC schema version. Each is guarded: a "duplicate column" error
 * is expected and tolerated. (`staged_rows`/`status`/`updated_at`/`is_followup`
 * are in the CREATE above; these ALTERs upgrade a pre-existing table in place.)
 */
const CC_ADD_COLUMNS: { table: string; column: string; ddl: string }[] = [
  {
    table: "cc_upload_batches",
    column: "staged_rows",
    ddl: "ALTER TABLE cc_upload_batches ADD COLUMN staged_rows TEXT",
  },
  {
    table: "cc_cardholders",
    column: "updated_at",
    ddl: "ALTER TABLE cc_cardholders ADD COLUMN updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  },
  {
    table: "cc_notifications",
    column: "is_followup",
    ddl: "ALTER TABLE cc_notifications ADD COLUMN is_followup INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "cc_transactions",
    column: "archived_at",
    ddl: "ALTER TABLE cc_transactions ADD COLUMN archived_at TEXT",
  },
];

/** Seed cardholder registry (15 rows; §1b). Deterministic ids; email seeded NULL. */
interface SeedCardholder {
  id: string;
  first_name: string;
  last_name: string | null;
  card_source: "CAPITAL_ONE" | "AMEX" | "BOTH";
  cap_one_last4: string | null;
  amex_last5: string | null;
  amex_sheet_name: string | null;
}

const SEED_CARDHOLDERS: SeedCardholder[] = [
  { id: "ch-susan", first_name: "Susan", last_name: null, card_source: "BOTH", cap_one_last4: "5113", amex_last5: "34005", amex_sheet_name: "Susan 34005" },
  { id: "ch-bonnie", first_name: "Bonnie", last_name: null, card_source: "BOTH", cap_one_last4: "5100", amex_last5: "31217", amex_sheet_name: "Bonnie 31217" },
  { id: "ch-lori", first_name: "Lori", last_name: null, card_source: "BOTH", cap_one_last4: "2277", amex_last5: "36158", amex_sheet_name: "Lori 36158" },
  { id: "ch-kari", first_name: "Kari", last_name: null, card_source: "BOTH", cap_one_last4: "5383", amex_last5: "31223", amex_sheet_name: "Kari 31223" },
  { id: "ch-jaff", first_name: "Jaff", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "1985", amex_last5: null, amex_sheet_name: null },
  { id: "ch-lindsay-s", first_name: "Lindsay", last_name: "S", card_source: "CAPITAL_ONE", cap_one_last4: "7622", amex_last5: null, amex_sheet_name: null },
  { id: "ch-kali", first_name: "Kali", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "1586", amex_last5: null, amex_sheet_name: null },
  { id: "ch-lindsay-c", first_name: "Lindsay", last_name: "C", card_source: "CAPITAL_ONE", cap_one_last4: "1658", amex_last5: null, amex_sheet_name: null },
  { id: "ch-denise", first_name: "Denise", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "2196", amex_last5: null, amex_sheet_name: null },
  { id: "ch-stephanie", first_name: "Stephanie", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "8315", amex_last5: null, amex_sheet_name: null },
  { id: "ch-lisa", first_name: "Lisa", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "2475", amex_last5: null, amex_sheet_name: null },
  { id: "ch-jazmine", first_name: "Jazmine", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "5005", amex_last5: null, amex_sheet_name: null },
  { id: "ch-hayley", first_name: "Hayley", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "9383", amex_last5: null, amex_sheet_name: null },
  { id: "ch-debra", first_name: "Debra", last_name: null, card_source: "CAPITAL_ONE", cap_one_last4: "0844", amex_last5: null, amex_sheet_name: null },
  { id: "ch-lindsay-d", first_name: "Lindsay", last_name: "D", card_source: "AMEX", cap_one_last4: null, amex_last5: "32348", amex_sheet_name: "Lindsay D 32348" },
];

/**
 * Self-applies the CC schema (tables + indexes + guarded additive columns) and
 * idempotently seeds the cardholder registry. Runs once per isolate, NEVER
 * throws (a transient failure logs and is retried next request).
 */
export async function ensureCcSchema(env: Env): Promise<void> {
  if (ccSchemaEnsured) return;

  // 1) Tables + indexes. All IF NOT EXISTS — naturally idempotent.
  try {
    await env.DB.batch(CC_DDL.map((sql) => env.DB.prepare(sql)));
  } catch (e) {
    console.error("[cc-migrations] ensureCcSchema DDL failed (will retry):", e);
    return;
  }

  // 2) Additive ALTERs to upgrade a pre-existing table. Tolerate the expected
  //    "duplicate column" error; bail (without latching) on anything else.
  for (const { ddl } of CC_ADD_COLUMNS) {
    try {
      await env.DB.prepare(ddl).run();
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      if (!/duplicate column|already exists/i.test(msg)) {
        console.error("[cc-migrations] add column failed (will retry):", ddl, e);
        return;
      }
    }
  }

  // 2b) Index on archived_at (v1.3.8 archive). Created AFTER the ALTER above so
  //     the column is guaranteed to exist on an upgraded table (a pre-existing
  //     cc_transactions won't have it during the CREATE TABLE batch). IF NOT
  //     EXISTS — idempotent.
  try {
    await env.DB.prepare(
      "CREATE INDEX IF NOT EXISTS idx_cc_tx_archived ON cc_transactions(archived_at)",
    ).run();
  } catch (e) {
    console.error("[cc-migrations] create archived index failed (will retry):", e);
    return;
  }

  // 3) Idempotent cardholder seed (INSERT OR IGNORE; email NULL, is_active 1).
  try {
    const stmts = SEED_CARDHOLDERS.map((ch) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO cc_cardholders (id, first_name, last_name, email, card_source, cap_one_last4, amex_last5, amex_sheet_name, user_id, is_active) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        ch.id,
        ch.first_name,
        ch.last_name,
        null,
        ch.card_source,
        ch.cap_one_last4,
        ch.amex_last5,
        ch.amex_sheet_name,
        null,
        1,
      ),
    );
    await env.DB.batch(stmts);
    ccSchemaEnsured = true;
  } catch (e) {
    console.error("[cc-migrations] cardholder seed failed (will retry):", e);
  }
}
