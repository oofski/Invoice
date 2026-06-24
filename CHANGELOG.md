# Changelog

All notable changes to InvoiceIQ are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match the desktop app
version in `desktop/package.json`. Each release is published as a Windows
installer on the GitHub Releases page.

## [1.2.0] — 2026-06-24

### Fixed
- **Products now code to Retail / Product Costs by default.** The product
  detector was too narrow, so real product names ("HA5 HydraCollagen Hydrator",
  "OPI Black Onyx", "Super Gloss Top Coat") fell through to a salon's generic
  account (Service Costs or Repairs & Maintenance). Now, for the salons (Neroli
  & SKNBar), any line that isn't clearly a service / rent / freight / fee is
  treated as a product and coded by how it's taxed: **untaxed → Retail / Product
  Costs** (tagged Retail), **taxed → Service Costs** (tagged Backbar). These stay
  low-confidence so they're easy to review, and any explicit Type or manual edit
  still wins.
- **Invoices for the Institute of Beauty & Wellness route to IBW, not Neroli.**
  IBW-Milwaukee and Neroli-Downtown share the building at 327 E St Paul, and the
  matcher was picking the less-specific match. It now prefers the **most-specific
  location** and recognizes the school by name ("Institute of Beauty & Wellness"
  / "IBW"), so those invoices land on **IBW / Milwaukee** correctly.
- **Non-school discounts are no longer booked as a separate line.** The discount
  comes off the relevant account and the invoice books to its subtotal + tax —
  which also removes the false "off by $X" review line some invoices showed. The
  schools (IBW, Chicago) still track discounts to their Discounts account.

### Changed
- **The app no longer flags when line items + tax don't equal the invoice
  total.** It focuses on reading the invoice at the highest fidelity instead; if
  a line is genuinely missing, an accountant can still add it. (Per-line "needs
  review" flags for low-confidence or un-coded lines remain.)
- **Known product vendors seeded** — Wella, AbbVie, OPI, and Olive Garden now
  code to Retail / Product Costs with high confidence.

## [1.1.9] — 2026-06-24

### Changed
- **Manually-added lines now survive reprocessing.** When an accountant or admin
  has added a line the scanner missed and the invoice is later **reprocessed**,
  the added line is **kept** instead of being wiped — unless the fresh scan now
  picks it up on its own (matched by description and amount), in which case the
  duplicate is dropped. The completeness check also counts the kept line, so a
  manual line that already fills the gap no longer triggers a redundant
  "Extraction incomplete" review line.

## [1.1.8] — 2026-06-24

### Added
- **Tax-based coding by default.** When a product-like line has no stronger
  match, it's now coded by how it's taxed: an **untaxed** good defaults to
  **Retail / Product Costs** and is tagged **Type: Retail**; a good that's
  **charged sales tax** defaults to **Service Costs** and is tagged **Type:
  Backbar**. These are flagged low-confidence for a quick review, and any
  explicit Type or manual edit still wins. The Type tag also pre-fills the
  executive line split and drives the per-line purchase-tax recompute.
- **Discounts & credits are captured as their own lines.** Negative amounts
  (parentheses, trailing CR, or a leading minus) are no longer dropped or merged.
  For the **schools (IBW, Chicago)** a discount is tracked on its own
  **Discounts** account. For **every other entity** the discount is **netted off
  the relevant GL** — e.g. a $100 line with a $25 discount records **$75** to
  that account, with no separate discount line. Discounts and credits are never
  taxed.
- **Completeness check (reconciliation).** After extraction, the app compares the
  line items + tax against the invoice total. If they don't add up, it adds a
  clear **"⚠ Extraction incomplete"** review line for the difference and holds the
  invoice in **needs-review** (export stays blocked) until a person verifies it
  against the PDF.
- **Accountants/admins can add a missing line.** A new **"+ Add line item"**
  control on the invoice detail lets an accountant or admin add a line the
  scanner missed (amount required; GL is suggested automatically if left blank).
  Executives never see or get this control. A reconciliation banner points it out
  when the lines don't match the total.

### Changed
- **Higher-fidelity OCR/extraction.** The extractor now requests Reducto's
  deeper-accuracy mode with per-field citations, and the prompt is hardened to
  return **one line per visible row on every page** (including multi-page tables)
  and never to merge or skip lines. If a tuning option isn't supported on the
  account, extraction automatically falls back so it can never break. Lines the
  scanner reports **low confidence** on are flagged for review. The raw scanner
  output is now retained (admin-only) so extraction issues can be diagnosed.

### Fixed
- A manually-added line no longer disrupts the QuickBooks export. Added lines on a
  normal invoice keep the invoice's header coding, so the export still includes
  every original line.

## [1.1.7] — 2026-06-24

### Added
- **Edit & re-route invoices (accountant/admin).** On an invoice's detail, an
  **Edit routing** control lets accountants/admins fix the **business, class
  (location), and approver** when the OCR routed something wrong. Changing the
  business/class **auto-suggests the correct approver** from the routing rules
  (you can override it), and saving **re-queues the invoice to that approver and
  emails them** — so a mis-read invoice can be corrected and re-sent in seconds.
- **"Send for manual review" (executives).** When an approver is unsure about an
  invoice, a new button returns it to the **accountant** with a required note.
  It leaves the exec's queue and shows up under a new **"Routing Review"** status
  for the accountant, who can read the note, fix the routing, and re-send it for
  approval.
- **Olive Garden** is now mapped to **Retail / Product Costs** (beauty brushes,
  treated as retail/inventory) so it stops getting miscategorized.

### Fixed
- **Reminder emails are now honest.** The "Remind approvers" tool no longer
  reports a false "sent" when email isn't set up — it clearly says **"Email
  isn't configured"** (or shows real sent/failed counts and surfaces send
  errors). To actually send mail, an admin must set `RESEND_API_KEY` and a
  verified `RESEND_FROM_EMAIL` domain in the backend.

## [1.1.6] — 2026-06-24

### Added
- **Remind approvers (executives & admins).** A new **Remind** button on the
  Pending Approvals screen and the Dashboard opens a recipient picker listing
  each approver with their count of pending invoices — the ones who currently
  have invoices waiting are pre-selected. Add an optional note and send; each
  selected approver gets an email reminding them how many invoices await their
  approval. (Anyone without an app account/email is shown but can't be emailed.)
- **Backbar-vs-retail sales tax on per-line splits.** When an invoice is split
  line-by-line and items are tagged by Type, the QuickBooks export now
  **recalculates the purchase sales tax to cover only the taxable (non-retail)
  items**, at each line's **location-specific rate**. Backbar, Equipment, and
  Other are taxed at purchase; **Retail is excluded** (it's taxed when sold).
  Example — a Neroli · Downtown bill of $50 backbar + $50 retail now exports a
  Sales/Use Tax line of **$3.95** (50 × 7.90%) with the retail half untaxed.
  Rates are built in per location (e.g. Brookfield 5.0%, Madison 5.5%, Chicago
  10.25%).

### Changed
- For **per-line-split** invoices, the recomputed tax **replaces** the vendor's
  originally-charged tax, so the exported bill total may differ from the vendor
  invoice (this is intended). Quick/percentage splits and unsplit invoices are
  unchanged. Note: on a per-line split, lines left **untyped** are treated as
  non-taxable for this calculation.

## [1.1.5] — 2026-06-24

### Changed
- **New Neroli-branded look.** The whole app has been restyled to the Neroli
  Salon & Spa brand standards — a warm, refined, spa-luxury aesthetic in place
  of the previous generic blue/grey theme. Highlights:
  - **Colors:** warm porcelain canvas with white tone-on-tone cards and soft
    hairline borders; **Slate Grey** primary buttons and a restrained **Copper
    Rose** accent for links, focus, and selected rows (the old blue is gone).
  - **Typography:** elegant **Cormorant Garamond** headings and a **Marcellus**
    wordmark paired with a clean **Hanken Grotesk** body; all amounts use
    aligned tabular figures for easier scanning.
  - Status colors (approved / rejected / pending / exported / needs-review) stay
    clearly distinct, and the manual-review pulse is preserved.
- This is a **visual refresh only** — every screen, workflow, and feature behaves
  exactly as before. Fonts are bundled with the app (no internet required).

## [1.1.4] — 2026-06-24

### Added
- **Entity-aware GL categories.** When coding a line, the GL dropdown now shows
  **only the accounts that belong to that entity's chart** — Neroli shows
  Neroli's accounts, IBW the school accounts, Nala the corporate/admin
  accounts — each with its real number. Historical entries coded to a different
  account still appear (marked "historical") so nothing breaks.
- **New accounts** matching the spec: schools get **Bank Fees (6040)** and
  **Credit Card Processing (6100)** split out, **Professional Services (6224)**
  and **Outside Services (6240)**, **Guest Amenities (6053)**, **Student
  Education Fund (6130)**; salons/spas get **Service Payroll (5010)** and
  **Retail Payroll (5500)**; and Nala gets its full corporate/admin set
  (Lodging, Transportation, Meals & Entertainment, Automobile, Advertising &
  Promotion, Printing/Collateral, Direct Client Marketing, Meeting & Events,
  Parking/Mileage, Office Supplies, Employee Education, Credit Card Fees, …).
- **Smarter auto-categorization (5-level engine).** Known vendors auto-code
  instantly (ADP → Payroll - Wages, AT&T → Telephone, Facebook Ads → Marketing,
  Fromm International → Kit Costs, State Farm → Insurance - Business). **Retail
  vs. backbar is auto-detected conservatively** — a clear Aveda retail order
  with no tax charged to us codes to Retail/Product Costs (5100); products
  taxed to us (used in-house) code to Service Costs / backbar (5000); anything
  unclear is left for you to confirm. Every auto-coded category is guaranteed to
  exist in that entity's chart, otherwise it's flagged **Requires manual
  review** — no account is ever coded to a chart it doesn't belong to.

### Changed
- **Approval routing follows the new hierarchy.** Large (>$10k) or construction
  invoices still go to **Susan** first. Building/renovation, company-wide,
  administrative (Nala/Admin), or anything uncertain routes to **Bonnie** as the
  safety net — including major building expenses at the salons. School
  inventory/supplies → **Lisa**; recurring subscriptions, one-offs, and
  odd/admin school items → **Kari**; salon & spa product/service goods →
  **Lori**. Anything we can't match with high confidence is flagged for manual
  review and routed to Bonnie.

### Notes
- No database migration — categories and numbers are derived from the
  (entity, category) pair at display/export time.

## [1.1.3] — 2026-06-24

### Added
- **Entity-specific GL account numbers.** Each GL category now shows its
  **4-digit Chart-of-Accounts number next to the name**, and the number is
  **specific to the business entity** — the same category can map to a different
  account per entity (e.g. *Marketing* is **6235** for IBW/Chicago but **6239**
  for Neroli/SKNBarRx; *Corp Management Fee* is **6005** for the salons but
  **7000** for Nala). The number appears next to the category in the line-item
  GL view and the GL dropdown (accountants/admins only — executives still never
  see GL), and flows into the **QuickBooks bill-import export** as
  `"6239 Marketing"` in the Category/Account column, rendered per entity. Chicago
  uses IBW's school chart; Admin uses Nala's. Categories with no account on a
  given entity (or special values like *Payroll – Wages = "Varies"*) fall back to
  the plain category name.
- Implemented from the new **Accounting Categorization & Routing Engine** spec.
  This release covers the entity-specific Chart of Accounts; the spec's approver-
  routing and auto-categorization rules are tracked separately.

### Notes
- No database migration or schema change — account numbers are derived from the
  (entity, category) pair at display/export time, so existing invoices show the
  correct numbers immediately.

## [1.1.2] — 2026-06-24

### Fixed
- **Per-line split now actually fills the screen.** The split dialog was capped
  at a narrow width (~512px) no matter the screen size, so the Business/Class
  and Type columns were cut off and you had to scroll sideways. Root cause: the
  modal's width classes were being silently ignored. Fixed the modal so the
  per-line view expands to ~95% of the window width (up to 1600px) and the table
  fits with **no horizontal scroll** — the whole invoice (all columns) is
  visible at once. Maximize the window for the most room. This fix also lets the
  other dialogs (line-item split, quick split) use their intended widths.

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

[1.2.0]: https://github.com/oofski/Invoice/releases/tag/v1.2.0
[1.1.9]: https://github.com/oofski/Invoice/releases/tag/v1.1.9
[1.1.8]: https://github.com/oofski/Invoice/releases/tag/v1.1.8
[1.1.7]: https://github.com/oofski/Invoice/releases/tag/v1.1.7
[1.1.6]: https://github.com/oofski/Invoice/releases/tag/v1.1.6
[1.1.5]: https://github.com/oofski/Invoice/releases/tag/v1.1.5
[1.1.4]: https://github.com/oofski/Invoice/releases/tag/v1.1.4
[1.1.3]: https://github.com/oofski/Invoice/releases/tag/v1.1.3
[1.1.2]: https://github.com/oofski/Invoice/releases/tag/v1.1.2
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
