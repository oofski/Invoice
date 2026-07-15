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
  split_type      TEXT,                         -- NULL | 'QUICK_EVEN' | 'PER_LINE'
  textract_raw    TEXT,                         -- JSON string
  ai_processed_at TEXT,
  exported_at     TEXT,
  export_id       TEXT,
  shipping             REAL,                       -- v1.6.0: header shipping/freight, NULL when absent
  location_ambiguous   INTEGER NOT NULL DEFAULT 0, -- v1.6.0: 1 = location decided on shared evidence
  reconciliation_delta REAL,                       -- v1.6.0: NULL = reconciled; else signed gap total-(lines+tax), 2dp
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
  business            TEXT,
  class               TEXT,
  gl_category         TEXT,
  item_type           TEXT,
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

-- ------------------------------------------------- INVOICE ALLOCATIONS
-- Quick-even invoice splits: one row per (business:class) the invoice total is
-- divided across. Per-line splits are stored on line_items.business/class.
CREATE TABLE IF NOT EXISTS invoice_allocations (
  id          TEXT PRIMARY KEY,
  invoice_id  TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  business    TEXT NOT NULL,
  class       TEXT NOT NULL,
  percentage  REAL,
  amount      REAL NOT NULL,
  gl_account  TEXT,
  source      TEXT NOT NULL,                    -- e.g. 'QUICK_EVEN'
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_allocations_invoice ON invoice_allocations(invoice_id);

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

-- ------------------------------------------------------- VENDOR ALIASES
-- Canonicalizes OCR spelling variants of a vendor onto a single
-- vendor_mappings row so the variant inherits its GL coding + routing. The
-- lookup is deterministic exact-normalized-equality (alias_norm = the same
-- normalizeVendor() the matcher computes). Many aliases -> one canonical (1:N);
-- alias_norm UNIQUE prevents one variant from pointing at two canonicals. Fully
-- additive + reversible: delete an alias row and behavior reverts exactly.
CREATE TABLE IF NOT EXISTS vendor_aliases (
  id           TEXT PRIMARY KEY,
  alias_text   TEXT NOT NULL,              -- raw admin/seed string, e.g. 'Olivia Garden'
  alias_norm   TEXT NOT NULL UNIQUE,       -- normalizeVendor(alias_text), the lookup key
  canonical_id TEXT NOT NULL REFERENCES vendor_mappings(id) ON DELETE CASCADE,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_norm ON vendor_aliases(alias_norm);

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
 ('loc-milwaukee','327 E St Paul 5th Floor','["327 E St Paul 5th Floor","IBW-Milwaukee","IBW Milwaukee","Institute of Beauty & Wellness","Institute of Beauty and Wellness","Institute of Beauty","IBW"]','IBW','Milwaukee','Kari'),
 ('loc-madison','7021 Tree Ln','["7021 Tree Ln","IBW-Madison","IBW Madison","Madison","Institute of Beauty & Wellness","Institute of Beauty and Wellness","Institute of Beauty","IBW"]','IBW','Madison','Kari'),
 ('loc-chicago','2828 N Clark St','["2828 N Clark St","Chicago"]','Chicago','Chicago','Bonnie'),
 ('loc-nala','Nala','["Nala"]','Nala','Nala','Bonnie'),
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
 ('ven-adelman','Adelman','Admin',NULL,'Bonnie',0,NULL),
 ('ven-olivegarden','Olive Garden',NULL,NULL,NULL,1,'Retail / Product Costs');

-- =====================================================================
-- LIVE D1 MIGRATION — run once against an existing (pre-split) database.
-- Each statement is standalone and idempotent-friendly; ADD COLUMN will
-- error if the column already exists — ignore that specific error.
-- =====================================================================
ALTER TABLE line_items ADD COLUMN business TEXT;
ALTER TABLE line_items ADD COLUMN class TEXT;
ALTER TABLE line_items ADD COLUMN item_type TEXT;
ALTER TABLE invoices ADD COLUMN split_type TEXT;
CREATE TABLE IF NOT EXISTS invoice_allocations (id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, business TEXT NOT NULL, class TEXT NOT NULL, percentage REAL, amount REAL NOT NULL, gl_account TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX IF NOT EXISTS idx_allocations_invoice ON invoice_allocations(invoice_id);
INSERT OR IGNORE INTO location_mappings (id, address, keywords, business, class, default_approver) VALUES ('loc-nala','Nala','["Nala"]','Nala','Nala','Bonnie');
-- v1.1.7: Olive Garden (beauty brushes) → Retail / Product Costs (inventory/retail).
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-olivegarden','Olive Garden',NULL,NULL,NULL,1,'Retail / Product Costs');
-- v1.2.0 FIX 5: refresh IBW Milwaukee + Madison keywords with the school NAME
-- ("Institute of Beauty & Wellness" / "IBW") so the longest-match router routes a
-- shared-address (327 E St Paul) IBW invoice to IBW, not Neroli/Downtown.
INSERT OR REPLACE INTO location_mappings (id, address, keywords, business, class, default_approver) VALUES ('loc-milwaukee','327 E St Paul 5th Floor','["327 E St Paul 5th Floor","IBW-Milwaukee","IBW Milwaukee","Institute of Beauty & Wellness","Institute of Beauty and Wellness","Institute of Beauty","IBW"]','IBW','Milwaukee','Kari');
INSERT OR REPLACE INTO location_mappings (id, address, keywords, business, class, default_approver) VALUES ('loc-madison','7021 Tree Ln','["7021 Tree Ln","IBW-Madison","IBW Madison","Madison","Institute of Beauty & Wellness","Institute of Beauty and Wellness","Institute of Beauty","IBW"]','IBW','Madison','Kari');
-- v1.2.0 FIX 4: cosmetic-distributor inventory mappings → HIGH-confidence Retail /
-- Product Costs regardless of tax (business_entity NULL = applies to any entity).
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-wella','Wella',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-abbvie','AbbVie',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-opi','OPI',NULL,NULL,NULL,1,'Retail / Product Costs');
-- v1.2.x: safe-archive for invoices (reversible; default list filters archived rows).
-- archived_at is nullable; ADD COLUMN errors if it already exists — ignore that error.
ALTER TABLE invoices ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_invoices_archived ON invoices(archived_at);
-- v1.9.8: register the manual review check ("these are fine" acceptance).
ALTER TABLE invoices ADD COLUMN manually_reviewed_at TEXT;
ALTER TABLE invoices ADD COLUMN manually_reviewed_by TEXT;
-- v1.2.x: per-user audit-view cutoff (a read bookmark — audit_log rows are NEVER mutated).
CREATE TABLE IF NOT EXISTS audit_clear_cutoffs (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cutoff_at  TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- vendor canonicalization: alias table maps OCR spelling variants -> a canonical
-- vendor_mappings row (deterministic exact-normalized-equality lookup). Additive +
-- reversible; mirrors the CREATE near vendor_mappings above. Seeded by ensureSeedData.
CREATE TABLE IF NOT EXISTS vendor_aliases (
  id           TEXT PRIMARY KEY,
  alias_text   TEXT NOT NULL,
  alias_norm   TEXT NOT NULL UNIQUE,
  canonical_id TEXT NOT NULL REFERENCES vendor_mappings(id) ON DELETE CASCADE,
  created_by   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_aliases_norm ON vendor_aliases(alias_norm);
-- Seed the reported OCR variant: 'Olivia Garden' -> 'Olive Garden' (ven-olivegarden).
INSERT OR REPLACE INTO vendor_aliases (id, alias_text, alias_norm, canonical_id) VALUES ('alias-oliviagarden','Olivia Garden','olivia garden','ven-olivegarden');
-- v1.6.0: additive invoice columns — header shipping capture (FIX-9), the
-- location-ambiguity flag (FIX-1/8b), and the reconciliation guard (FIX-8).
-- ADD COLUMN errors if the column already exists — ignore that specific error.
ALTER TABLE invoices ADD COLUMN shipping REAL;
ALTER TABLE invoices ADD COLUMN location_ambiguous INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN reconciliation_delta REAL;
-- v1.7.0: system-managed vendor → GL-category mappings (SEED_MANAGED_VENDORS in
-- migrations.ts; keep the two in sync). CATEGORY-ONLY — every row leaves
-- business_entity / class / default_approver NULL so the invoice's ship-to +
-- routing rules decide entity / class / approver per invoice (never the vendor).
-- Fixed-id INSERT OR REPLACE (idempotent; admin-created rows use other ids and are
-- untouched). Supersedes the v1.1.7/v1.2.0 inventory seeds above (AbbVie/OPI/Wella
-- re-stated; Olive Garden REPURPOSED below). gl_override values are real account
-- NAMES from constants.ts (GL_CATEGORIES_FLAT / ENTITY_COA).
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-abbvie','AbbVie',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-opi','OPI',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-wella','Wella',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-marlo','Marlo Beauty Supply',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-ultraceuticals','Ultraceuticals',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-concordance','Concordance',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-cohere','Cohere Beauty',NULL,NULL,NULL,1,'Retail / Product Costs');
-- FROMM inventory row — does NOT override VENDOR_CATEGORY["Fromm International"]=Kit
-- Costs (that L2 VENDOR rule runs first; Kit Costs wins on IBW/Chicago).
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-fromm','Fromm International',NULL,NULL,NULL,1,'Retail / Product Costs');
-- §D: Olivia Garden = professional beauty-tools brand → its OWN inventory row.
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-oliviagarden','Olivia Garden',NULL,NULL,NULL,1,'Retail / Product Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-adelman','Adelman',NULL,NULL,NULL,0,'Repairs & Maintenance');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-avellas','Avellas',NULL,NULL,NULL,0,'Repairs & Maintenance');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-beautifulclean','Beautiful Clean',NULL,NULL,NULL,0,'Repairs & Maintenance');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-guthriefrey','Guthrie & Frey',NULL,NULL,NULL,0,'Repairs & Maintenance');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-fish','Fish Window Cleaning',NULL,NULL,NULL,0,'Repairs & Maintenance');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-culligan','Culligan',NULL,NULL,NULL,0,'Utilities');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-totalwater','Total Water Treatment Systems',NULL,NULL,NULL,0,'Utilities');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-brixmor','Brixmor',NULL,NULL,NULL,0,'Occupancy - Rent');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-westplace','West Place',NULL,NULL,NULL,0,'Occupancy - Rent');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-imaginal','Imaginal',NULL,NULL,NULL,0,'Marketing');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-salescomm','Salescomm',NULL,NULL,NULL,0,'Telephone');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-stamm','Stamm Technologies',NULL,NULL,NULL,0,'Computer & IT');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-globalsight','Global Sight',NULL,NULL,NULL,0,'Computer & IT');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-gordonflesch','Gordon Flesch',NULL,NULL,NULL,0,'Computer & IT');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-togo','TOGO',NULL,NULL,NULL,0,'Computer & IT');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-ukg','UKG',NULL,NULL,NULL,0,'Computer & IT');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-deltadental','Delta Dental',NULL,NULL,NULL,0,'Insurance - Health');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-ctcsupplies','CTC Supplies',NULL,NULL,NULL,0,'Supplies');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-cintas','Cintas',NULL,NULL,NULL,0,'Supplies');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-csc','CSC',NULL,NULL,NULL,0,'Professional / Outside Services');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-colectivo','Colectivo',NULL,NULL,NULL,0,'Guest Relations');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-pivotpoint','Pivot Point',NULL,NULL,NULL,1,'Kit Costs');
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-wash','WASH Multifamily Laundry',NULL,NULL,NULL,0,'Equipment Lease');
-- §D: Olive Garden = the RESTAURANT (staff refreshments) → Guest Relations, NOT
-- inventory. Repurposes the v1.1.7 inventory seed above.
INSERT OR REPLACE INTO vendor_mappings (id, vendor_name, business_entity, class, default_approver, is_inventory, gl_override) VALUES ('ven-olivegarden','Olive Garden',NULL,NULL,NULL,0,'Guest Relations');
-- §D: remove the stale v1.3.6 'Olivia Garden' -> ven-olivegarden alias (Olivia
-- Garden is now its own vendor, not an OCR variant of the restaurant).
DELETE FROM vendor_aliases WHERE id = 'alias-oliviagarden';
