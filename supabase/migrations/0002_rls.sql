-- =====================================================================
-- InvoiceIQ — Row Level Security (Brief §03 permissions, §08 realtime)
--
-- Reads (SELECT) are scoped per role so the browser client can safely run
-- Supabase realtime subscriptions. All WRITES go through server route handlers
-- using the service-role key, which bypasses RLS after requireRole() checks.
-- =====================================================================

-- Helper functions (SECURITY DEFINER bypass RLS to avoid recursion) ----
create or replace function public.auth_user_role()
returns text language sql stable security definer
set search_path = public as $$
  select role from public.users where id = auth.uid();
$$;

create or replace function public.auth_user_name()
returns text language sql stable security definer
set search_path = public as $$
  select name from public.users where id = auth.uid();
$$;

create or replace function public.is_staff_or_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select public.auth_user_role() in ('accountant', 'admin');
$$;

-- Enable RLS -----------------------------------------------------------
alter table users            enable row level security;
alter table invoices         enable row level security;
alter table line_items       enable row level security;
alter table approvals        enable row level security;
alter table vendor_mappings  enable row level security;
alter table audit_log        enable row level security;
alter table exports          enable row level security;
alter table location_mappings enable row level security;

-- USERS ----------------------------------------------------------------
drop policy if exists users_select on users;
create policy users_select on users for select to authenticated
  using (id = auth.uid() or public.is_staff_or_admin());

-- INVOICES -------------------------------------------------------------
drop policy if exists invoices_select on invoices;
create policy invoices_select on invoices for select to authenticated
  using (
    public.is_staff_or_admin()
    or (public.auth_user_role() = 'executive' and approved_by = public.auth_user_name())
    or (public.auth_user_role() = 'staff' and submitted_by = auth.uid())
  );

-- LINE ITEMS -----------------------------------------------------------
drop policy if exists line_items_select on line_items;
create policy line_items_select on line_items for select to authenticated
  using (
    exists (
      select 1 from invoices i
      where i.id = line_items.invoice_id
        and (
          public.is_staff_or_admin()
          or (public.auth_user_role() = 'executive' and i.approved_by = public.auth_user_name())
          or (public.auth_user_role() = 'staff' and i.submitted_by = auth.uid())
        )
    )
  );

-- APPROVALS ------------------------------------------------------------
drop policy if exists approvals_select on approvals;
create policy approvals_select on approvals for select to authenticated
  using (assigned_to = auth.uid() or public.is_staff_or_admin());

-- VENDOR MAPPINGS (any authenticated user may read) --------------------
drop policy if exists vendor_mappings_select on vendor_mappings;
create policy vendor_mappings_select on vendor_mappings for select to authenticated
  using (true);

-- LOCATION MAPPINGS ----------------------------------------------------
drop policy if exists location_mappings_select on location_mappings;
create policy location_mappings_select on location_mappings for select to authenticated
  using (true);

-- AUDIT LOG (accountant/admin only) ------------------------------------
drop policy if exists audit_log_select on audit_log;
create policy audit_log_select on audit_log for select to authenticated
  using (public.is_staff_or_admin());

-- EXPORTS (accountant/admin only) --------------------------------------
drop policy if exists exports_select on exports;
create policy exports_select on exports for select to authenticated
  using (public.is_staff_or_admin());
