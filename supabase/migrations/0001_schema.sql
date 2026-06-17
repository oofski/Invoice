-- =====================================================================
-- InvoiceIQ — Database schema (Brief §06 + §02 location_mappings)
-- Supabase / PostgreSQL
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- USERS  (created first: referenced by invoices/approvals/audit/exports)
-- The id matches the Supabase Auth user id so auth.uid() = users.id.
-- ---------------------------------------------------------------------
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null,
  role text not null,                       -- accountant | executive | staff | admin
  entity_access text[],                     -- e.g. {Neroli,SKNBar} ; null/empty = all
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- INVOICES
-- ---------------------------------------------------------------------
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  vendor text not null,
  invoice_number text not null,
  subtotal numeric(10,2),
  sales_tax numeric(10,2) default 0.00,
  total_amount numeric(10,2) not null,
  inv_date date,
  due_date date,
  business text,
  class text,
  approved_by text,
  status text default 'PROCESSING',          -- PROCESSING|PENDING_APPROVAL|APPROVED|REJECTED|EXPORTED
  pdf_url text,
  submitted_by uuid references users(id),
  submission_type text default 'ACCOUNTANT', -- ACCOUNTANT|STAFF
  textract_raw jsonb,
  ai_processed_at timestamptz,
  exported_at timestamptz,
  export_id uuid,
  created_at timestamptz default now(),
  unique(vendor, invoice_number, total_amount)
);

create index if not exists idx_invoices_status on invoices(status);
create index if not exists idx_invoices_approved_by on invoices(approved_by);
create index if not exists idx_invoices_business on invoices(business);
create index if not exists idx_invoices_created_at on invoices(created_at desc);

-- ---------------------------------------------------------------------
-- LINE ITEMS
-- ---------------------------------------------------------------------
create table if not exists line_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  description text,
  amount numeric(10,2),
  gl_category text,
  confidence_level text,
  logic_path text,
  requires_review boolean default false,
  manually_overridden boolean default false,
  overridden_by uuid,
  split_parent_id uuid,
  split_percentage numeric(5,2),
  sort_order integer,
  created_at timestamptz default now()
);

create index if not exists idx_line_items_invoice on line_items(invoice_id);
create index if not exists idx_line_items_review on line_items(requires_review);

-- ---------------------------------------------------------------------
-- APPROVALS
-- ---------------------------------------------------------------------
create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id) on delete cascade,
  assigned_to uuid references users(id),
  assigned_to_name text,
  status text default 'PENDING',             -- PENDING|APPROVED|REJECTED
  decision_note text,
  decided_at timestamptz,
  reminder_sent_at timestamptz,
  reminder_count integer default 0,
  created_at timestamptz default now()
);

create index if not exists idx_approvals_invoice on approvals(invoice_id);
create index if not exists idx_approvals_assigned on approvals(assigned_to);
create index if not exists idx_approvals_status on approvals(status);

-- ---------------------------------------------------------------------
-- VENDOR MAPPINGS
-- ---------------------------------------------------------------------
create table if not exists vendor_mappings (
  id uuid primary key default gen_random_uuid(),
  vendor_name text unique not null,
  business_entity text,
  class text,
  default_approver text,
  is_inventory boolean default false,
  gl_override text,
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- AUDIT LOG
-- ---------------------------------------------------------------------
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references invoices(id),
  user_id uuid references users(id),
  action text,
  prev_value jsonb,
  new_value jsonb,
  note text,
  created_at timestamptz default now()
);

create index if not exists idx_audit_invoice on audit_log(invoice_id);
create index if not exists idx_audit_user on audit_log(user_id);
create index if not exists idx_audit_created on audit_log(created_at desc);

-- ---------------------------------------------------------------------
-- EXPORTS
-- ---------------------------------------------------------------------
create table if not exists exports (
  id uuid primary key default gen_random_uuid(),
  exported_by uuid references users(id),
  exported_at timestamptz default now(),
  invoice_ids uuid[],
  file_name text,
  row_count integer,
  file_url text
);

-- invoices.export_id references exports(id) (added after exports exists)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invoices_export_id_fkey'
  ) then
    alter table invoices
      add constraint invoices_export_id_fkey
      foreign key (export_id) references exports(id);
  end if;
end$$;

-- ---------------------------------------------------------------------
-- LOCATION MAPPINGS (Brief §02 — source of truth for AI routing, editable)
-- ---------------------------------------------------------------------
create table if not exists location_mappings (
  id uuid primary key default gen_random_uuid(),
  address text not null,
  keywords text[] not null default '{}',
  business text not null,
  class text not null,
  default_approver text not null,
  updated_at timestamptz default now()
);
