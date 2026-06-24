# Changelog

All notable changes to InvoiceIQ are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match the desktop app
version in `desktop/package.json`. Each release is published as a Windows
installer on the GitHub Releases page.

## [1.1.1] — 2026-06-24

### Changed
- **Per-line split now fills the screen.** Opening Per-line split shows a
  near-fullscreen, wider dialog (`max-w-6xl`, ~90% of screen height) so the
  whole line-item sheet is visible. The table fills the available height and is
  the only thing that scrolls — the Cancel / Save footer and the bulk-apply bar
  stay pinned at all times (no more scrolling past the buttons, and no nested
  double scrollbars). The wider layout also keeps long descriptions on one line
  so more rows fit at once. Quick split is unchanged.

## [1.1.0] — 2026-06-24

### Changed
- **Collapsible invoice inbox.** The "Pending Approvals" sidebar now has a
  collapse button (`‹`) that shrinks it to a thin strip, giving the PDF and
  detail view more room. Click the expand arrow to restore it.
- **Collapsible decision panel.** A new toggle in the top-right of the approval
  detail view collapses the Approve / Split / Reject panel entirely, letting
  the PDF take the full width for easier reading. Click the panel icon to
  bring it back.
- **PDF zoom and scroll now work correctly.** The approval layout was switched
  from CSS grid to flex so the PDF container gets a proper constrained height —
  zoom in/out and scroll/pan now work as expected.
- **Bulk-select in per-line split.** Each line in the Per-line split tab now
  has a checkbox on the left. Check any combination (or "Select all") and a
  blue bulk-apply bar appears letting you set the Business / Class / Type for
  all selected lines at once — no need to go row by row.
- **Larger split modal.** The Split invoice modal is now wider (`max-w-5xl`)
  and the per-line table scrolls within the modal (max ~52% of screen height)
  so the whole content is easy to see.

## [1.0.9] — 2026-06-23

### Added
- **Easier PDF viewing for approvers.** When an executive (or anyone) opens an
  invoice, the PDF pane now has **zoom in / zoom out** (50%–400%), **rotate 90°**,
  and **Fit / Reset** buttons, and you can **scroll/pan** a zoomed page. This
  makes line-by-line splitting on dense invoices much easier to read.
- **Cross-entity quick split.** The Split screen's quick split is now a
  **flexible % builder**: it pre-fills the invoice's business classes split
  evenly, but you can change any percentage and **"Add target"** to send part of
  the split to a *different entity* — e.g. an IBW invoice where part of the
  thirds goes to **Chicago** (a separate EIN). Save is enabled only when the
  percentages total 100 and every row has a business + class. On export these
  fan out to the correct entity tab(s) with unique bill numbers.
- **Per-line "Type" in line-by-line split.** Each line can be tagged
  **Backbar**, **Retail**, **Equipment**, or **Other** (type-in). The GL account
  is derived automatically from the Type — Backbar → *Service Costs*,
  Retail → *Retail / Product Costs*, Equipment → *Equipment & Fixtures*; **Other**
  flags the line for manual GL review. Executives set the Type but still never
  see the GL account.

### Changed
- Extends the **D1 migration** with `line_items.item_type` (the prior
  `invoice_allocations` table + `line_items.business/class` + `invoices.split_type`
  are still required). Basic per-line split and existing flows stay safe before
  the migration is run; cross-entity and typed splits need it.

## [1.0.8] — 2026-06-23

### Added
- **"Factor invoices for bill import"** (Export screen, accountant/admin). One
  click turns the selected approved invoices into a **QuickBooks "Import Bills"
  workbook (.xlsx) with one tab per business entity** (Neroli, SKNBarRx, IBW,
  Chicago, Nala, Admin — only entities that have bills get a tab). Each tab is
  in QBO's exact bill-import format: multi-line bills share one Bill Number with
  the header fields blank on follow-on rows, `Category Details` rows carry the
  GL account + amount, and the **Class** column is `business:class`. Split
  invoices fan out to the correct entity tab(s) with unique bill numbers
  (e.g. `1001-IBW`); sales tax is added as a reconciling line. Factoring marks
  the invoices Exported and logs to export history, like the CSV export. The
  workbook is generated client-side (SheetJS); the existing CSV export remains.

## [1.0.7] — 2026-06-23

### Added
- **Invoice splitting for approvers.** When an executive opens an invoice they
  get a simple view — **Approve**, **Split**, **Reject**, and an optional
  **Comments** box — with line items hidden behind a "Show line-by-line detail"
  toggle. Two split modes: **Quick even split** (splits evenly across the
  business's classes — e.g. Neroli → 20% ×5) and **Per-line split** (assign each
  line a Business + Class, with the Class list constrained to that Business).
  The GL account on split rows comes from the vendor mapping. New endpoints:
  `POST /api/invoices/:id/split-even`, `/split-lines`, `DELETE /:id/split`;
  `approve` now accepts an optional comment.
- **New `Nala` business entity** (business = class), alongside the existing
  entities/classes.

### Changed
- **GL coding is now accountant/admin/staff only** — executives can no longer
  see or edit the 47-category GL view (enforced server-side and in the UI).
- Requires a one-time **D1 migration** (new `invoice_allocations` table +
  `line_items.business/class` + `invoices.split_type`).

## [1.0.6] — 2026-06-23

### Added
- **Refresh on the Approvals screen.** A manual **Refresh** button plus
  **auto-refresh every 15 seconds**, so an approver sees newly-routed invoices
  without leaving and reopening the page. The list now also shows a load error
  if the backend can't be reached (instead of looking like an empty queue).
- **"Check for invoices" button** in the bottom-left of the sidebar (every
  screen) that force-refreshes the app to re-scan the server for new invoices
  and updates.
- **"Remember me" on the login screen.** Optionally saves your email and
  password on that device so the sign-in form is pre-filled next time.

## [1.0.5] — 2026-06-23

### Added
- **Edit users (admin).** User Management now has an **Edit** action per user to
  change their **name, email, and role** in one place (executives still pick
  their name from the approver dropdown so routing stays connected). The Worker
  `PATCH /api/users/:id` now also accepts `email`, with a friendly "Email already
  exists" error on a collision.

## [1.0.4] — 2026-06-23

### Added
- **Settings page for every role** (admin/accountant/executive/staff) with
  in-app update controls: shows the current version, a **Check for updates**
  button, live status (checking/downloading/up-to-date), and a **Restart &
  install** button when an update is ready — wired to the Electron auto-updater
  over IPC. Also surfaces account info, a Change-password shortcut, sign out,
  and the connected Server URL.
- **Admin delete actions.** Admins can now delete an invoice (Invoice detail →
  Delete; removes the PDF from R2 and cascades line items/approvals, with an
  audit entry) and delete a user (User Management → Delete; nulls out their
  invoice/approval/export references and removes sessions). Guards prevent
  deleting your own account or the last active admin.
- **Admin password reset.** User Management → Reset issues a new temporary
  password for any user (shown to the admin to share; the user must change it on
  next login). Secure by design — only admins can reset, so no name-based
  self-service takeover risk.

## [1.0.2] — 2026-06-23

### Fixed
- **Executives could miss invoices routed to them due to name matching.** The
  link between an invoice's approver and an executive account is the person's
  name; it was an exact, case-sensitive match, so an account named "lisa" or
  "Lisa " (or otherwise not exactly the approver name) saw an empty queue. Name
  matching is now case-insensitive and whitespace-tolerant everywhere (queue
  filter, view/approve/reject checks, approver→user resolution).

### Added
- **Guardrail in the admin "Create user" form:** when the role is *executive*,
  the Name field is now a dropdown of the approver names (Lori/Lisa/Kari/Bonnie/
  Susan) so routing always connects.
- **Worker returns real error messages** (Hono `onError`) instead of a bare
  500, so failures (e.g. a missing `REDUCTO_API_KEY`) are diagnosable from the
  app and the Worker logs.
- **SharePoint auto-ingest.** New token-authed Worker endpoint
  `POST /ingest/upload` lets an external automation (a SharePoint document
  library wired to a Power Automate flow) drop PDFs straight into InvoiceIQ —
  they run the identical pipeline (Reducto → 3 Claude prompts → approval
  routing) as an in-app upload. New optional secret: `INGEST_TOKEN`. Setup guide
  in `docs/SHAREPOINT.md`. The shared ingestion logic is factored into
  `ingestInvoicePdf()` so the in-app upload and SharePoint path never diverge.
- **Dashboard deployment guide** (`docs/CLOUDFLARE.md`) — stand up D1, R2, the
  Worker, and secrets entirely from the Cloudflare dashboard + GitHub web UI,
  with no local `wrangler` install.

### Changed
- **AI pipeline replaced with Reducto `/extract` + a deterministic rules engine
  — Anthropic/Claude is no longer used.** Reducto now does structured extraction
  (header fields + line-by-line items, with a best-effort `suggested_category`
  per line). Business/Class and the approver are decided by deterministic rules
  (`vendor_mappings` / `location_mappings` + the brief's priority routing).
  GL coding follows the 5-level hierarchy in code — tax → vendor map → keywords
  → Reducto's suggestion → entity fallback → `REQUIRES_MANUAL_REVIEW` — so most
  recurring invoices code with zero AI cost. `ANTHROPIC_API_KEY` is now optional
  and unused; the only required AI secret is `REDUCTO_API_KEY`. The legacy Claude
  prompt modules were removed (kept in git history).
- **OCR/document parsing switched from AWS Textract to Reducto.** AWS is no
  longer required; removed all AWS env/keys. D1/R2 and the desktop UI are
  unchanged.

## [1.0.1] — 2026-06-23

### Added
- **Auto-update** for the Windows desktop app (`electron-updater`). Installed
  copies check the GitHub Release feed on launch and every 6 hours, download new
  versions in the background, and prompt to restart and install.
- Release workflow now publishes auto-update metadata (`latest.yml`, blockmaps)
  alongside the installer, and can be run manually ("Run workflow") in addition
  to tag pushes.

### Changed
- **Invoice PDF storage moved from D1 BLOBs to Cloudflare R2** (object storage),
  for safe handling of large scans and high volume. D1 now stores only the R2
  object key + metadata.

## [1.0.0] — 2026-06-23

### Added
- Initial InvoiceIQ release — AP automation for the multi-entity salon/wellness
  business (Neroli, SKNBar, IBW, Chicago, Admin).
- **Downloadable Windows desktop app** (Electron) backed by a **Cloudflare
  Worker + D1** database; secrets stay server-side in the Worker.
- AI pipeline: AWS Textract OCR → three Claude (`claude-sonnet-4-6`) prompts in
  parallel (extraction + business routing, approver tie-breaker, 47-category GL
  line-item coding with the 5-level logic hierarchy).
- Email + password auth (PBKDF2 + session tokens); first-admin bootstrap;
  admin-managed users.
- Screens: accountant dashboard, invoice upload (drag-drop, duplicate
  detection), two-panel invoice detail with PDF viewer + GL coding editor +
  line-item splitting, executive approval flow, batch QuickBooks Bills CSV
  export with export-lock + history, vendor mapping manager, and audit trail.
- Critical rules enforced: Prompt 2 overrides Prompt 1, manual-review blocks
  export, export lock, duplicate detection before the AI pipeline, split-sum
  validation, stored raw Textract, and audit-log on every state change.
- Optional Resend email notifications (approval routing + 72h reminders);
  the app is fully usable without email.
- An alternate **Next.js + Supabase web build** of the same product remains in
  the repository root (`src/`, `supabase/`) for teams that prefer a web/PWA
  deployment.

[1.1.1]: https://github.com/oofski/Invoice/releases/tag/v1.1.1
[1.1.0]: https://github.com/oofski/Invoice/releases/tag/v1.1.0
[1.0.9]: https://github.com/oofski/Invoice/releases/tag/v1.0.9
[1.0.8]: https://github.com/oofski/Invoice/releases/tag/v1.0.8
[1.0.7]: https://github.com/oofski/Invoice/releases/tag/v1.0.7
[1.0.6]: https://github.com/oofski/Invoice/releases/tag/v1.0.6
[1.0.5]: https://github.com/oofski/Invoice/releases/tag/v1.0.5
[1.0.4]: https://github.com/oofski/Invoice/releases/tag/v1.0.4
[1.0.2]: https://github.com/oofski/Invoice/releases/tag/v1.0.2
[1.0.1]: https://github.com/oofski/Invoice/releases/tag/v1.0.1
[1.0.0]: https://github.com/oofski/Invoice/releases/tag/v1.0.0
