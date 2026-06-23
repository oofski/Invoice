# InvoiceIQ — AP Automation Platform

AI-powered invoice processing, approval routing, GL coding, and QuickBooks
export for a multi-entity salon & wellness business (brands: **Neroli**,
**SKNBar**, **IBW**, **Chicago**, **Admin/Corporate**).

Built per the _InvoiceIQ Full-Stack Developer Brief v1.0_. PDFs are uploaded,
run through **AWS Textract**, then three **Claude (claude-sonnet-4-6)** prompts
in parallel (extraction + routing, approver tie-breaker, GL line-item coding),
routed for executive approval, GL-coded/split, and exported as a **QuickBooks
Online Bills import CSV** — no QBO API/OAuth required.

## Tech stack

| Layer    | Tech                                            |
| -------- | ----------------------------------------------- |
| Frontend | Next.js 14 (App Router) · React · TypeScript    |
| Styling  | Tailwind CSS                                    |
| PDF      | react-pdf (PDF.js)                              |
| Data     | Supabase (PostgreSQL · Auth · Storage · Realtime) |
| OCR      | AWS Textract — Analyze Expense API              |
| AI       | Anthropic Claude `claude-sonnet-4-6` (3 prompts) |
| Email    | Resend                                          |
| PWA      | next-pwa (installable on Windows via Edge/Chrome) |
| Hosting  | Vercel                                          |

## Quick start

```bash
npm install
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:3000
```

`npm run dev`/`npm run build` automatically copy the PDF.js worker into
`/public` (see `scripts/copy-pdf-worker.mjs`).

## Environment variables

See `.env.example` for the complete list (Brief §11): Supabase URL/anon/service
keys, AWS Textract keys + region, `ANTHROPIC_API_KEY`, Resend key + from-address,
`NEXT_PUBLIC_APP_URL`, and an optional `PROCESS_SECRET` for the internal
reprocess endpoint. **Never expose `SUPABASE_SERVICE_ROLE_KEY` to the client.**

## Database setup (Supabase)

Run the SQL in order in the Supabase SQL editor (or `supabase db push`):

1. `supabase/migrations/0001_schema.sql` — all tables (Brief §06) + `location_mappings`
2. `supabase/migrations/0002_rls.sql` — row-level security
3. `supabase/migrations/0003_auth_trigger.sql` — link magic-link logins to profiles
4. `supabase/migrations/0004_storage.sql` — private `invoices` + `exports` buckets
5. `supabase/seed.sql` — users, location dictionary, vendor routing lists
   **→ edit the placeholder emails first.**

Auth is **email magic-link**. Seeded users (1 accountant, 6 execs, 1 admin) are
linked to their Supabase Auth account by email on first login. Update the
placeholder `@example.com` addresses in `seed.sql` before inviting users.

## AWS Textract setup

1. Create an AWS account, enable Textract in `us-east-1`.
2. Create an IAM user with **AmazonTextractFullAccess** only; generate keys.
3. Put the keys in `.env.local` / Vercel env (never commit).
4. `@aws-sdk/client-textract` is already installed.

## How the pipeline works (Brief §04/§05)

1. **Upload** (`POST /api/invoices/upload`) stores the PDF in Supabase Storage.
2. **Textract** `analyzeExpense()` extracts structured fields.
3. **Duplicate detection** (vendor + invoice# + total) runs _before_ the
   expensive Claude calls (Brief §13).
4. **Three Claude prompts** run via `Promise.all()`:
   - **Prompt 1** — extraction + business routing (location dictionary).
   - **Prompt 2** — approver tie-breaker (vendor lists, $10k+→Susan, ship-to).
     **Always overrides Prompt 1's `ApprovedBy`.**
   - **Prompt 3** — GL line-item categorization (47 categories, 5-level logic,
     `<90%` → `REQUIRES_MANUAL_REVIEW`).
5. Results saved, status → `PENDING_APPROVAL`, audit logged, approval email sent
   to the routed exec via Resend.
6. Exec approves/rejects; accountant resolves manual-review items and exports.

## Project structure

```
src/
  app/
    (app)/            authenticated screens (dashboard, upload, invoices,
                      approvals, export, vendors, audit, admin/users)
    api/              all REST route handlers (Brief §07)
    login/, auth/     magic-link auth
  components/         UI kit + feature components
  lib/
    ai/               anthropic client + prompt1/2/3 + pipeline
    supabase/         browser / server / admin / middleware clients
    textract.ts       Textract call + clean labeled-text formatting
    export/qbo.ts     QBO Bills CSV generator
    process.ts        upload→Textract→dedupe→AI→save→email orchestration
    constants.ts      location dictionary, 47 GL cats, vendor routing, roles
supabase/             migrations + seed
docs/SPEC_COVERAGE.md traceability matrix (brief → code)
```

## Critical implementation rules (Brief §13)

- Prompt 2 `ApprovedBy` **always** overrides Prompt 1 (`lib/ai/pipeline.ts`).
- `REQUIRES_MANUAL_REVIEW` **blocks export** (`/api/export` guardrails).
- Exported invoices are **locked** against re-export.
- Duplicate detection runs **before** the AI pipeline.
- Split amounts **must equal** the parent (validated client- and server-side).
- Raw Textract output is stored in `invoices.textract_raw` (reprocess without
  re-billing Textract).
- Every state change writes to `audit_log` with `prev`/`new` values.

## Verifying the build

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm run build       # production build (also runs lint + typecheck)
```

## Deploy (Vercel)

Connect the GitHub repo, add all env vars, deploy. `next-pwa` builds the
service worker on production builds so the app is installable on Windows.
