# Changelog

All notable changes to InvoiceIQ are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match the desktop app
version in `desktop/package.json`. Each release is published as a Windows
installer on the GitHub Releases page.

## [Unreleased]

### Added
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

[1.0.1]: https://github.com/oofski/Invoice/releases/tag/v1.0.1
[1.0.0]: https://github.com/oofski/Invoice/releases/tag/v1.0.0
