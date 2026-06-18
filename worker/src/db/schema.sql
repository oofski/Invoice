-- =====================================================================
-- InvoiceIQ — Cloudflare D1 (SQLite) schema + seed
-- Mirrors the Developer Brief §06 schema, adapted from Postgres to SQLite:
--   UUIDs generated in app code (TEXT);  numeric -> REAL;  jsonb/arrays -> TEXT
--   (JSON strings);  booleans -> INTEGER (0/1);  timestamps -> TEXT (ISO 8601).
-- Auth is email + password (sessions table). PDFs are stored in D1 (pdf_files).
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- USERS
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL,                 -- accountant|executive|staff|admin
  entity_access TEXT,                          -- JSON array string or NULL (= all)
  password_hash TEXT,                          -- PBKDF2 hash (set on first password)
  password_salt TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------------- SESSIONS
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ------------------------------------------------------------- INVOICES
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  vendor          TEXT NOT NULL,
  invoice_number  TEXT NOT NULL,
  subtotal        REAL,
  sales_tax       REAL DEFAULT 0,
  total_amount    REAL NOT NULL,
  inv_date        TEXT,
  due_date        TEXT,
  business        TEXT,
  class           TEXT,
  approved_by     TEXT,
  status          TEXT NOT NULL DEFAULT 'PROCESSING',
  has_pdf         INTEGER NOT NULL DEFAULT 0,
  submitted_by    TEXT REFERENCES users(id),
  submission_type TEXT NOT NULL DEFAULT 'ACCOUNTANT',
  textract_raw    TEXT,                         -- JSON string
  ai_processed_at TEXT,
  exported_at     TEXT,
  export_id       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(vendor, invoice_number, total_amount)
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_approver ON invoices(approved_by);
CREATE INDEX IF NOT EXISTS idx_invoices_business ON invoices(business);

-- ------------------------------------------------------ PDF FILES (R2 refs)
-- PDF bytes live in Cloudflare R2 (object storage) — scalable for large scans
-- and high volume. This table only holds the R2 object key + metadata.
CREATE TABLE IF NOT EXISTS pdf_files (
  invoice_id  TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  file_name   TEXT,
  mime        TEXT NOT NULL DEFAULT 'application/pdf',
  r2_key      TEXT NOT NULL,
  size        INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ----------------------------------------------------------- LINE ITEMS
CREATE TABLE IF NOT EXISTS line_items (
  id                  TEXT PRIMARY KEY,
  invoice_id          TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description         TEXT,
  amount              REAL,
  gl_category         TEXT,
  confidence_level    TEXT,
  logic_path          TEXT,
  requires_review     INTEGER NOT NULL DEFAULT 0,
  manually_overridden INTEGER NOT NULL DEFAULT 0,
  overridden_by       TEXT,
  split_parent_id     TEXT,
  split_percentage    REAL,
  sort_order          REAL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_line_items_invoice ON line_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_line_items_review ON line_items(requires_review);

-- ----------------------------------------------------------- APPROVALS
CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  assigned_to      TEXT REFERENCES users(id),
  assigned_to_name TEXT,
  status           TEXT NOT NULL DEFAULT 'PENDING',
  decision_note    TEXT,
  decided_at       TEXT,
  reminder_sent_at TEXT,
  reminder_count   INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_invoice ON approvals(invoice_id);
CREATE INDEX IF NOT EXISTS idx_approvals_assigned ON approvals(assigned_to);

-- ------------------------------------------------------- VENDOR MAPPINGS
CREATE TABLE IF NOT EXISTS vendor_mappings (
  id               TEXT PRIMARY KEY,
  vendor_name      TEXT UNIQUE NOT NULL,
  business_entity  TEXT,
  class            TEXT,
  default_approver TEXT,
  is_inventory     INTEGER NOT NULL DEFAULT 0,
  gl_override      TEXT,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ------------------------------------------------------------- AUDIT LOG
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  invoice_id TEXT,
  user_id    TEXT,
  action     TEXT,
  prev_value TEXT,                              -- JSON string
  new_value  TEXT,                              -- JSON string
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_log(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- --------------------------------------------------------------- EXPORTS
CREATE TABLE IF NOT EXISTS exports (
  id          TEXT PRIMARY KEY,
  exported_by TEXT REFERENCES users(id),
  exported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invoice_ids TEXT,                             -- JSON array string
  file_name   TEXT,
  row_count   INTEGER,
  content     TEXT                              -- the generated CSV (for re-download)
);

-- ------------------------------------------------------ LOCATION MAPPINGS
CREATE TABLE IF NOT EXISTS location_mappings (
  id               TEXT PRIMARY KEY,
  address          TEXT NOT NULL,
  keywords         TEXT NOT NULL DEFAULT '[]',  -- JSON array string
  business         TEXT NOT NULL,
  class            TEXT NOT NULL,
  default_approver TEXT NOT NULL,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- =====================================================================
-- SEED — location dictionary (Brief §02) and vendor routing lists (§05).
-- Users are created via the /api/auth/bootstrap endpoint (first admin) and the
-- admin user-management screen — passwords are never seeded in plaintext.
-- =====================================================================

INSERT OR IGNORE INTO location_mappings (id, address, keywords, business, class, default_approver) VALUES
 ('loc-mequon','10902 N Port Washington','["10902 N Port Washington","Mequon"]','Neroli','Mequon','Lori'),
 ('loc-downtown','327 E St Paul','["327 E St Paul","Downtown"]','Neroli','Downtown','Lori'),
 ('loc-eastside','1919 E Kenilworth','["1919 E Kenilworth","Eastside"]','Neroli','Eastside','Lori'),
 ('loc-northshore','200 W Silver Spring','["200 W Silver Spring","North Shore"]','Neroli','North Shore','Lori'),
 ('loc-brookfield','3885 N Brookfield','["3885 N Brookfield","Brookfield"]','Neroli','Brookfield','Lori'),
 ('loc-shorewood','4005 N Downer','["4005 N Downer","Shorewood"]','SKNBar','Shorewood','Lisa'),
 ('loc-pewaukee','145 W Wisconsin','["145 W Wisconsin","Pewaukee"]','SKNBar','Pewaukee','Lisa'),
 ('loc-milwaukee','327 E St Paul 5th Floor','["327 E St Paul 5th Floor","IBW-Milwaukee","IBW Milwaukee"]','IBW','Milwaukee','Kari'),
 ('loc-madison','7021 Tree Ln','["7021 Tree Ln","IBW-Madison","IBW Madison","Madison"]','IBW','Madison','Kari'),
 ('loc-chicago','2828 N Clark St','["2828 N Clark St","Chicago"]','Chicago','Chicago','Bonnie'),
 ('loc-admin','Admin / Corporate','["Admin","Corporate","Nala"]','Admin','None','None');

INSERT OR IGNORE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES
 ('ven-pivotpoint','Pivot Point','IBW',NULL,'Lisa',1,NULL),
 ('ven-fromm','FROMM','IBW',NULL,'Lisa',1,NULL),
 ('ven-ultraceuticals','Ultraceuticals','IBW',NULL,'Lisa',1,NULL),
 ('ven-cohere','Cohere','IBW',NULL,'Lisa',0,NULL),
 ('ven-ctc','CTC Supplies',NULL,NULL,'Lisa',1,NULL),
 ('ven-marlo','Marlo',NULL,NULL,'Lisa',1,NULL),
 ('ven-concordance','Concordance',NULL,NULL,'Lisa',1,NULL),
 ('ven-cintas','Cintas',NULL,NULL,'Lisa',0,NULL),
 ('ven-avellas','Avellas','IBW',NULL,'Kari',0,NULL),
 ('ven-culligan','Culligan','IBW',NULL,'Kari',0,NULL),
 ('ven-imaginal','Imaginal Group','IBW',NULL,'Kari',0,NULL),
 ('ven-salescomm','Salescomm','IBW',NULL,'Kari',0,NULL),
 ('ven-westplace','West Place LLC','IBW',NULL,'Kari',0,NULL),
 ('ven-colectivo','Colectivo','Neroli',NULL,'Lori',0,NULL),
 ('ven-beautifulclean','Beautiful Clean','Admin',NULL,'Bonnie',0,NULL),
 ('ven-stamm','STAMM','Admin',NULL,'Bonnie',0,NULL),
 ('ven-wash','WASH','Admin',NULL,'Bonnie',0,NULL),
 ('ven-csc','CSC LLC','Admin',NULL,'Bonnie',0,NULL),
 ('ven-ukg','UKG','Admin',NULL,'Bonnie',0,NULL),
 ('ven-brixmor','Brixmor','Admin',NULL,'Bonnie',0,NULL),
 ('ven-deltadental','Delta Dental','Admin',NULL,'Bonnie',0,NULL),
 ('ven-fish','FISH','Admin',NULL,'Bonnie',0,NULL),
 ('ven-gordonflesch','Gordon Flesch','Admin',NULL,'Bonnie',0,NULL),
 ('ven-togo','TOGO','Admin',NULL,'Bonnie',0,NULL),
 ('ven-guthriefrey','Guthrie & Frey','Admin',NULL,'Bonnie',0,NULL),
 ('ven-globalsight','Global Sight','Admin',NULL,'Bonnie',0,NULL),
 ('ven-adelman','Adelman','Admin',NULL,'Bonnie',0,NULL);
