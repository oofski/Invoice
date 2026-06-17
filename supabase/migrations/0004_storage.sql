-- =====================================================================
-- InvoiceIQ — Storage (Brief §12 Session 1: private bucket for PDFs)
--
-- PDFs are uploaded server-side with the service-role key and served to the
-- PDF viewer via short-lived signed URLs, so no public access is granted.
-- =====================================================================

insert into storage.buckets (id, name, public)
values
  ('invoices', 'invoices', false),
  ('exports',  'exports',  false)
on conflict (id) do nothing;

-- Authenticated users may read objects in these private buckets (defense in
-- depth; the app primarily uses signed URLs / server downloads which bypass
-- this anyway).
drop policy if exists "invoices_read_authenticated" on storage.objects;
create policy "invoices_read_authenticated"
  on storage.objects for select to authenticated
  using (bucket_id in ('invoices', 'exports'));
