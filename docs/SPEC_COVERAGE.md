# InvoiceIQ — Spec Coverage Matrix

Traces every section of the _InvoiceIQ Full-Stack Developer Brief v1.0_ to its
implementation. ✅ = implemented.

## §01 What we are building

| Requirement | Status | Where |
| --- | --- | --- |
| Web-based AP automation for 4 brands | ✅ | whole app |
| PDF upload → Textract → 3 Claude prompts → approval → GL → QBO export | ✅ | `lib/process.ts`, `lib/ai/*`, `app/api/*` |
| No QBO API; output QBO Bills import file | ✅ | `lib/export/qbo.ts`, `app/api/export` |
| Installable PWA (Windows via Edge/Chrome), next-pwa | ✅ | `next.config.mjs`, `public/manifest.json`, `public/icons` |

## §02 Business entities & location dictionary

| Requirement | Status | Where |
| --- | --- | --- |
| 11-row location dictionary (entity/class/approver) | ✅ | `lib/constants.ts` `LOCATION_DICTIONARY`, `supabase/seed.sql` |
| Stored in `location_mappings` table (editable, no code change) | ✅ | `migrations/0001_schema.sql`, seeded in `seed.sql` |

## §03 User roles & permissions

| Role | Status | Where |
| --- | --- | --- |
| Accountant (upload, view all, edit GL, resolve review, reminders, export, vendors, audit) | ✅ | `lib/auth.ts`, route `requireRole`, `AppShell` nav |
| Executive (view assigned only, approve/reject w/ note, override GL; no upload/export) | ✅ | `ApprovalView`, RLS `invoices_select`, approve/reject routes |
| Staff (upload pre-approved, code own, cannot approve own) | ✅ | upload route, visibility scope, `submission_type=STAFF` |
| Admin (manage users/roles, mappings, audit) | ✅ | `app/(app)/admin/users`, `/api/users*` |

## §04 Two submission flows

| Step | Status | Where |
| --- | --- | --- |
| Flow A accountant intake; Flow B staff self-submit | ✅ | `/upload`, upload route `submissionType` |
| Duplicate check before processing | ✅ | `lib/process.ts findDuplicate`, upload route (pre-Claude) |
| Textract analyzeExpense | ✅ | `lib/textract.ts` |
| 3 Claude prompts via Promise.all | ✅ | `lib/ai/pipeline.ts` |
| Prompt 2 ApprovedBy overrides Prompt 1; save line items; PENDING_APPROVAL; audit | ✅ | `lib/process.ts processInvoiceAI` |
| Approval email auto-sent to correct exec (vendor/amount/entity/due/login link) | ✅ | `lib/email/resend.ts sendApprovalEmail` |
| Exec approve/reject (note req); expand line items to override GL; timestamps | ✅ | `ApprovalView`, approve/reject routes |
| Accountant GL review, 47-cat dropdown, split by %/$, manual-review blocks export | ✅ | `LineItemsTable`, `SplitModal`, export guardrails |
| Batch export; export lock on download | ✅ | `/export`, `/api/export` |

## §05 AI processing pipeline — full prompt specs

| Requirement | Status | Where |
| --- | --- | --- |
| Prompts receive formatted Textract output, not raw PDF | ✅ | `lib/textract.ts formatForClaude` |
| Model `claude-sonnet-4-6` | ✅ | `lib/ai/anthropic.ts CLAUDE_MODEL` |
| Prompt 1 JSON schema (extraction + routing) | ✅ | `lib/ai/prompt1.ts` |
| Prompt 2 routing rules (5 rules + catch-all) + schema | ✅ | `lib/ai/prompt2.ts`, vendor lists in `constants.ts` |
| Prompt 3 5-level hierarchy + confidence + schema | ✅ | `lib/ai/prompt3.ts` |
| 47 allowed GL categories | ✅ | `lib/constants.ts GL_CATEGORIES` (validated 7+4+36=47) |

## §06 Database schema

| Table | Status | Where |
| --- | --- | --- |
| invoices, line_items, approvals, users, vendor_mappings, audit_log, exports | ✅ | `migrations/0001_schema.sql` (exact columns) |
| + location_mappings (from §02) | ✅ | same |
| RLS | ✅ | `migrations/0002_rls.sql` |

## §07 API routes (App Router)

All routes implemented under `src/app/api/`:

`POST /invoices/upload`, `POST /invoices/process`, `GET /invoices`,
`GET/PATCH /invoices/[id]`, `GET /invoices/pending`, `GET /invoices/overdue`,
`POST /invoices/[id]/approve`, `POST /invoices/[id]/reject`,
`POST /invoices/[id]/remind`, `POST /invoices/remind-bulk`,
`POST /line-items/[id]/split`, `PATCH /line-items/[id]`,
`POST /export`, `GET /export/[id]` (+ `GET /export` history),
`GET/POST /vendors`, `PATCH /vendors/[id]`, `GET /audit/[invoiceId]`
(+ `GET /audit` global), `GET /dashboard/stats`, `GET/POST /users`,
`PATCH /users/[id]`. ✅ Auth enforced per the brief's auth column.

## §08 UI screens & components

| Screen | Status | Where |
| --- | --- | --- |
| Accountant Dashboard (6 stat cards, queue, filters, 72h overdue + bulk remind, manual-review queue, realtime) | ✅ | `app/(app)/dashboard` |
| Invoice Upload (drag-drop, multi-file, step progress, duplicate warning) | ✅ | `app/(app)/upload` |
| Invoice Detail (two-panel PDF + data + line items + actions) | ✅ | `app/(app)/invoices/[id]` |
| Exec Approval View (sidebar list, focused approve/reject, GL override) | ✅ | `ApprovalView`, `app/(app)/approvals[/[id]]` |
| GL Coding Editor (47-cat dropdown, confidence badges, split modal) | ✅ | `LineItemsTable`, `SplitModal`, badges |
| Batch Export Screen (select, export, history re-download) | ✅ | `app/(app)/export` |
| Vendor Mapping Manager (search, inline edit, add) | ✅ | `app/(app)/vendors` |
| Audit Trail View (timeline per invoice, global filterable log, CSV export) | ✅ | `AuditTimeline`, `app/(app)/audit` |
| Confidence badge colors HIGH/MEDIUM/LOW/MANUAL_REVIEW (red pulse) | ✅ | `components/ui/Badges.tsx`, `globals.css` |

## §09–§11 Tech stack / Textract setup / env vars

| Requirement | Status | Where |
| --- | --- | --- |
| All listed packages installed | ✅ | `package.json` |
| Textract SDK + integration | ✅ | `lib/textract.ts` |
| Complete env var list | ✅ | `.env.example` |

## §12 Build sessions 1–7

All seven sessions delivered: foundation (auth/RLS/storage/seed/PWA), upload +
AI pipeline, accountant dashboard, exec approval flow, GL editor + splitting,
QBO export, and Flow B + admin + audit + polish. See §07/§08 mappings.

## §13 Critical implementation rules

| Rule | Status | Where |
| --- | --- | --- |
| Prompt 2 always overrides Prompt 1 | ✅ | `lib/ai/pipeline.ts` |
| REQUIRES_MANUAL_REVIEW blocks export (show count) | ✅ | `/api/export`, `/export`, detail banner |
| Exported invoices locked | ✅ | `/api/export` 409 + status guards |
| Duplicate detection before the AI pipeline | ✅ | `upload` route |
| Split amounts must equal parent (client + server) | ✅ | `SplitModal`, `/api/line-items/[id]/split` |
| Store raw Textract output | ✅ | `invoices.textract_raw`, reused on reprocess |
| Audit log on every state change | ✅ | `lib/audit.ts` called across all mutating routes |

## §14 Future features

Documented as out-of-scope roadmap (Teams, inbox monitor, mobile app, direct
QBO API, recurring detection, spend analytics). Not implemented (post-launch).

## Notes / decisions

- **Duplicate-before-Textract:** the brief asks for dedupe "before Textract,"
  but vendor/invoice#/total only exist post-OCR. We run the cheap Textract
  ($0.01/page) to obtain them, then gate the **expensive Claude pipeline** on
  the duplicate check — honoring the intent (don't waste AI processing) while
  remaining technically possible. The DB unique constraint is the backstop.
- **QBO format:** standard QuickBooks Online multi-line Bills import CSV
  (per chosen option). Header in `lib/export/qbo.ts`.
- **6th executive:** seeded as an editable placeholder ("Exec Six"); routing
  only ever targets the 5 named approvers (Lori/Lisa/Kari/Bonnie/Susan).
