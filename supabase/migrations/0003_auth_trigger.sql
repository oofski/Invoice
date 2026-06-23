-- =====================================================================
-- InvoiceIQ — Auth linkage trigger
--
-- When a Supabase Auth user is created (e.g. on first magic-link login), link
-- it to a pre-seeded public.users profile by email so role + entity_access are
-- preserved and users.id == auth.uid() (required by RLS). If no seeded profile
-- exists, create a default 'staff' profile so login still works.
--
-- NOTE: keep FKs referencing users(id) ON UPDATE CASCADE so adopting the auth
-- id on an already-referenced profile stays consistent.
-- =====================================================================

-- Make user-id references survive the id adoption below.
alter table invoices       drop constraint if exists invoices_submitted_by_fkey;
alter table invoices       add  constraint invoices_submitted_by_fkey
  foreign key (submitted_by) references users(id) on update cascade;
alter table approvals      drop constraint if exists approvals_assigned_to_fkey;
alter table approvals      add  constraint approvals_assigned_to_fkey
  foreign key (assigned_to) references users(id) on update cascade;
alter table audit_log      drop constraint if exists audit_log_user_id_fkey;
alter table audit_log      add  constraint audit_log_user_id_fkey
  foreign key (user_id) references users(id) on update cascade;
alter table exports        drop constraint if exists exports_exported_by_fkey;
alter table exports        add  constraint exports_exported_by_fkey
  foreign key (exported_by) references users(id) on update cascade;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  -- Adopt the auth id onto a matching pre-seeded profile.
  update public.users
     set id = new.id
   where email = new.email
     and id <> new.id;

  -- No seeded profile? Create a default staff profile.
  if not found then
    insert into public.users (id, name, email, role)
    values (
      new.id,
      coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
      new.email,
      'staff'
    )
    on conflict (email) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
