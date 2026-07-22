# Changelog

All notable changes to InvoiceIQ are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions match the desktop app
version in `desktop/package.json`. Each release is published as a Windows
installer on the GitHub Releases page.

## [1.9.11] — 2026-07-22

Clears out the Medium and Low findings from the end-to-end audit, and adds a
unit-test suite (vitest) to the worker.

### Fixed — reporting & money
- Invoice analytics (Total AP, trend, entity/vendor/GL spend) exclude REJECTED
  invoices, so payables aren't overstated.
- The dashboard "Spend by GL category" chart no longer double-counts split
  invoices (already fixed for the parent chart in 1.9.10; this covers the rest).
- Credit-card receipt-completion % now reaches 100% when nothing is outstanding
  (credits/refunds no longer hold it below).
- Top-vendors chart merges case/whitespace vendor variants into one bar.
- Split validation sums per-row rounded amounts, matching what's stored.
- Credits/refunds written as "(x)", "x-", or "x CR" now parse as negative.

### Fixed — export
- Factor (.xlsx) renders bills with a missing/legacy entity on an "Unassigned"
  sheet instead of silently dropping them.
- QuickBooks CSV cells that start with = + - @ are neutralized against
  spreadsheet formula-injection.
- Allocation-split invoices (quick/even/custom) are no longer stuck in the export
  "Blocked" list over a stale line flag.

### Fixed — credit cards & receipts
- Auto-match only considers transactions still awaiting a receipt (no more
  attaching a second receipt to the wrong, already-receipted charge).
- Re-importing an overlapping statement preserves a transaction's already-collected
  receipt status and manual entity splits.
- Assigning a queued receipt is atomic (no duplicate receipt rows on a double-click).
- The mobile split screen no longer re-submits the same photo on back-navigation
  (no duplicate receipt or manager alert), and a split that can't be applied is
  kept rather than silently dropped.
- HEIC/HEIF/WebP receipt photos are accepted.
- A reminder for a cardholder with no email on file no longer drafts to the manager.

### Fixed — invoices, vendors, admin, audit
- Invoice list filters (status/entity/search) run server-side, so "Clear",
  Excel export, and filtering work across the whole list, not just the newest page.
- The combined review banner names a reconciliation gap that "These are fine"
  will also clear.
- Reject case/whitespace-duplicate vendors and aliases that would shadow a real
  vendor's coding.
- /admin/users is admin-only; a pending first-login password change is enforced
  on reload; "Remember me" no longer stores your password on disk.
- Audit date filter respects your local day on both ends.
- Ingest rollback also cleans up its Reducto sidecar; PDFs with bytes before the
  header are recognized instead of stored as unknown files.

### Added
- A vitest unit-test suite for the worker's pure logic (money parsing, CSV
  escaping, PDF sniffing, split validation) — run with `npm test` in `worker/`.

## [1.9.10] — 2026-07-21

Fixes the eight High-severity issues found in the full end-to-end audit. Every
fix was put through two rounds of independent adversarial review before shipping.

### Fixed
- **Export could double-book a batch into QuickBooks.** Exporting the same
  selection twice (Export then Factor, or two windows at once) could book it
  twice. Export now atomically *claims* each invoice (guarded on APPROVED) and
  aborts with a "refresh and retry" message if anything was already exported — and
  rolls the claim back if writing the export file fails.
- **An admin could lock everyone out.** Deactivating or demoting your own account
  (or the last active admin) is now blocked on the server and disabled in the UI —
  matching how delete already worked. (Already-inactive admins can still be
  reclassified.)
- **Credit-card data could leak between executives who share a first name.**
  Ownership now matches on the linked user first; a first-name match is only used
  when that name is unique, so two people named the same can no longer see or edit
  each other's transactions and receipts.
- **A failed re-scan could corrupt a good invoice.** Reprocessing now replaces an
  invoice's line items and approval in single all-or-nothing steps, so an
  interrupted re-scan can no longer leave an invoice with missing lines.
- **Deleting a credit-card upload or receipt could destroy a still-attached
  receipt's file.** Each attached receipt now keeps its own copy of the image, and
  file deletes are reference-counted so one delete can't remove another's bytes.
- **Deleting the last receipt on a transaction left stale line coding.** It now
  cleans up that receipt's own line items so a re-upload can't double them —
  while preserving any entity split an accountant entered by hand.
- **The credit-card accountant ledger disagreed with the dashboard.** The ledger
  now excludes archived (cleared) transactions, so the two views reconcile and
  cleared charges stop reappearing.
- **The dashboard "Spend by GL category" chart double-counted split invoices.**
  Split parent lines are now excluded so each split amount is counted once.

## [1.9.9] — 2026-07-21

Fixes the "zip export gives me text, not the approved PDFs" bug. Root cause: the
SharePoint/email ingest stored **whatever bytes arrived** (a scanned JPEG/PNG, an
HTML email body) under an `application/pdf` label with **no validation**, so the
bulk-zip later downloaded them as unreadable `.pdf` files.

### Fixed / Added
- **Ingest now validates + normalizes every attachment (root cause).** Incoming
  bytes are sniffed by magic number: a real PDF is stored as-is, a **JPEG/PNG is
  converted into a true one-page PDF** (so the viewer, the "APPROVED" stamp, and
  the zip all keep working), and anything else is stored with its **real** mime
  instead of a forged `application/pdf`. The audit note records any conversion.
- **The PDF zip is now content-aware.** Each entry is named by its real type
  (`.pdf`/`.jpg`/…), and any attachment that isn't a viewable document is **listed
  in a `_UNREADABLE.txt` manifest inside the archive** instead of being written as
  a broken `.pdf`. The result toast tells you how many (if any) had no usable PDF.
- **New admin "Repair attachments" backfill** (Batch Export page). One click
  scans every existing invoice, converts mislabeled image attachments to real
  PDFs, relabels other non-PDFs with their true type, and refreshes the "APPROVED"
  stamp — so your *existing* approved invoices become clean without re-uploading.
  Runs in cursor-paged batches and is safe to re-run (idempotent).

## [1.9.8] — 2026-07-15

Makes "These are fine — proceed" a real, recorded **manual review check** and
lets it fully clear an invoice for export. Additive; one small migration
(two nullable columns).

### Added / Changed
- **A manual review is now registered.** When an admin/accountant clicks
  **"These are fine — proceed,"** the app records **who** accepted the flags and
  **when**, shows it on the invoice ("Manually reviewed by … · date") and on the
  Export page row, and logs it in the audit trail — an accountable record that a
  human checked it before it was cleared for export.
- **"These are fine" now clears a reconciliation gap too.** Previously it cleared
  flagged lines and the location warning but re-flagged a "line items ≠ total"
  gap; now, since a human explicitly accepted it, that flag is acknowledged and
  cleared (a later edit to the amounts re-checks it). So an approved invoice you've
  marked good is genuinely **Export Ready**, with no lingering warnings.
- **The banner (and the button) now surface for a reconciliation-only or
  location-only flag, and after approval** — so you can accept those from the
  invoice even once it's approved. (Reminder: an invoice still becomes
  **Export Ready** only after it's **Approved**; "These are fine" clears the flags,
  it doesn't approve.)

Note: a line with **no GL account** (an explicit "needs coding" line) still can't
be "these are fine"-d away — it must be given a category first, so nothing exports
to a blank account.

## [1.9.7] — 2026-07-15

A full-lifecycle bug sweep of the invoice pipeline (upload → OCR → code → split
→ review → approve → export). 37 confirmed defects fixed. **No schema change.**

### Fixed — splitting & location
- **A split now clears "location needs confirmation."** The #1 complaint (e.g.
  the SALESCOMM invoice that still said the location was unknown after a split):
  every split path — even split, custom %, and per-line — now resolves the
  location flag, so the amber warning and the export "Location?" prompt clear the
  moment you split. "These are fine — proceed" clears a location-only flag too.
- **Split modals no longer show stale or another invoice's numbers.** Re-opening
  a split (or switching invoices) re-seeds fresh, closing a path that could
  mis-allocate one invoice using another's split.
- **Per-line split can't silently drop lines.** If a line has no business/class
  it now blocks the save and tells you, instead of quietly leaving it uncoded.
- **The Split button works for single-class businesses** (Chicago/Admin/Nala) —
  it was greyed out even though cross-entity and per-line splits are supported.
- **Clearing a split, or rerouting to another entity, cleans up after itself** —
  no stale allocations or line coding pointing at the old entity, and per-line
  coding is re-derived so nothing gets stuck.

### Fixed — coding, totals & export
- **Auto-coding never invents a blank GL account** — a line the entity has no
  account for goes to manual review instead of exporting with an empty account.
- **QBO Bills export includes header sales tax** on ordinary invoices (the bill
  total was short by the tax); reconciliation no longer double-counts an
  itemized tax line; a whole-invoice split no longer trips a spurious export
  review flag; single-line split pieces keep their entity so they aren't dropped.

### Fixed — approvals, reprocessing & uploads
- **No accidental double-decisions:** approve/reject only act on a
  pending invoice, and a missing split-migration no longer freezes the approval
  queue. Editing/reprocessing a finalized invoice is blocked.
- **Reprocess/Re-scan no longer silently un-approves** an approved/exported
  invoice, and a rescan now actually corrects a mis-read total/tax/date.
- **Uploads:** "Upload anyway" can force through an intentional duplicate; a
  duplicate always offers "View existing"; re-uploads are caught despite
  vendor-name casing drift; and a failed AI run no longer leaves a stuck ghost
  invoice that blocks the retry.

### Fixed — live views & review scan
- **The detail and approval pages stop flashing/reloading the PDF** on every
  inline edit; the Export and detail pages now refresh live like the others.
- **The duplicate Review scan no longer flags legitimate recurring bills** (same
  vendor + amount, different months), scans the most recent invoices, and its
  delete completes the whole selection rather than stopping at 200.

## [1.9.6] — 2026-07-15

Live cross-view sync + a duplicate "Review scan." **Additive** — no schema
change; deletion keeps the same permissions and behavior it already had.

### Fixed
- **Every view now reflects the same live state.** A change made in one place —
  approving, routing, deleting, splitting, editing line items, "these are fine,"
  exporting — now updates the **Dashboard**, the **Invoices** list, and the
  **Approvals** list right away, instead of the Dashboard lagging behind until a
  slow poll or a manual reload. Under the hood: an invoice-refresh signal fires
  after any AP change and every live view re-pulls on it (also on window focus).
  API reads are also forced fresh (no stale desktop cache), so a re-opened tab
  never shows old numbers. Background refreshes no longer flash a spinner.

### Added
- **Review scan for duplicate invoices (admin / accountant).** A new
  **Review scan** button on the Invoices page finds look-alike invoices and
  groups them — same **vendor + invoice number**, or same **vendor + amount**
  when an invoice has no number. The oldest in each group is tagged as the one to
  keep; tick the extras and delete them in one step (with a one-click
  "select the extras, keep the oldest" per group). Genuine recurring bills (same
  amount but different real invoice numbers) are intentionally **not** flagged,
  and already-exported invoices are called out and never auto-selected, so you
  don't delete a filed record by accident.

## [1.9.5] — 2026-07-15

Credit-card split parity for accountants. **Additive** — nothing that works
today changes, and the schema is untouched.

### Added
- **Change the business entity _and_ the class when you split.** When an admin or
  an accountant opens a credit-card transaction and splits it, the split now
  gives them the same **entity + location/class** picker an executive gets — pick
  the business, pick the location(s), and Back bar / Retail / 50-50, over the
  whole charge (Quick split) or line by line. Previously the manager's split on a
  transaction with no itemized receipt lines only let them enter amounts per
  business; the location/class was hard to reach. The whole-charge
  **Amounts by business** grid is still there as a secondary option for a quick
  multi-business split.

## [1.9.4] — 2026-07-15

Workflow-control release for busy upload days. **Additive** — every change adds
a new action or a slower option; nothing that works today changes, and the
schema is untouched.

### Added
- **Delete a line item.** On an invoice's line-item table, accountants and admins
  now get a delete button on each line (non-exported invoices). Deleting a line
  updates the invoice total; deleting a line that was split removes its split
  pieces too. It's logged in the audit trail.
- **Handle a batch one at a time.** The upload screen no longer has to blast a
  whole batch through at once. Alongside **Process all**, there's now a **One at
  a time** button that processes just the next invoice and then pauses — so you
  can see where it routed (and open it to fix) before continuing. Process all is
  still there when you trust the batch.
- **"These are fine — proceed."** When an invoice is flagged with a review issue
  (line items flagged for review, or one sent back for routing review), an admin,
  accountant, or credit-card accountant can click one button to accept the
  current coding and move it forward — clearing the soft review flags and, if it
  was bounced back, re-sending it to its approver. Lines with no real GL account
  keep their flag (there's nothing to file them under), so export stays honest.

## [1.9.3] — 2026-07-14

A batch-review release aimed at large upload days. **Additive** — every change
widens what accountants can do or surfaces more of what already happened; no
existing flow (routing, approval, matching, export) changes behavior, and the
schema is untouched.

### Added
- **The general accountant now has full credit-card power.** Everything a
  credit-card accountant or admin could do — delete, split, code, match — is now
  available to the `accountant` role too, across the whole CC module (dashboard,
  transactions, inbox, ledger, receipts, splits, line coding).
- **Duplicate uploads collapse by invoice number.** When the same invoice lands
  several times in one batch, it's put out once even if the scan reads the total
  slightly differently each time — matching is now on vendor + invoice number
  with the amount within a small tolerance, so a vendor that reuses a reference
  number for a different bill (a recurring statement, a revised invoice) still
  comes through instead of being dropped, and invoices with no readable number
  are never merged. Duplicates are flagged with an "Upload anyway" override, and
  the upload screen shows a roll-up: how many processed, how many duplicates were
  skipped, how many failed.
- **See what an approval was for.** An invoice that was split now shows the split
  itself on both the invoice detail and the approval view — each business/class
  and its dollar amount (and percentage), plus who approved it and when, and any
  approval comment. The audit trail labels split-applied / split-cleared events.
- **Every GL category, per institution.** The GL-category picker for an invoice
  now offers the full universal category list for every entity (its own chart of
  accounts still supplies the account number where it has one), so a
  needs-processing invoice is never blocked by a short per-entity list.
- **Dollar reconcile while splitting.** The invoice split dialog now shows the
  dollar value of each slice next to its percentage and a running "$X of $Y"
  readout on the quick-split tab, plus an "N of M lines assigned · $X of $Y"
  coverage readout on the per-line tab.

### Fixed
- **Re-opening an already-coded receipt no longer wipes or corrupts its coding.**
  The line-by-line editor now seeds correctly from existing multi-entity coding
  and opens on the line view when coding is already present.
- **Split/coding writes are now atomic.** Replacing a receipt's lines, its entity
  splits, and an invoice's per-line split each run as a single transaction, so a
  mid-write failure can no longer leave coding half-applied or the line view and
  ledger/export disagreeing.
- **Client-side tax allocation matches the server exactly** — the by-spend tax
  split now floors each share and distributes the remaining cents by weight
  (the same algorithm the worker uses), so the live preview always reconciles.
- **Flagged / unbalanced items stay deletable.** Admins, accountants, and
  credit-card accountants can delete an invoice even when it's flagged as not
  balancing, so a bad upload never gets stuck.

## [1.9.2] — 2026-07-10

Two credit-card improvements. **Additive** — the only backend change is that the
inbox now returns the executive's carried split it already stored (a new nullable
`cc_receipt_inbox.pending_splits` column already existed); nothing about the
match → split → export flow changes.

### Fixed
- **The credit-card dashboard (and the Inbox tab count) now stay current.** They
  used to load once and go stale — deleting unmatched receipts still showed the
  old count until you navigated away. Now every KPI, chart, and the Inbox badge
  refresh live: right after an add / delete / match / status change, on window
  focus, and on a periodic check.

### Added
- **See (and fix) the executive's split before filing a receipt.** On the Inbox,
  each unmatched receipt now shows the split the executive submitted from the app
  — each business, its location, and the amount. When the split is for a single
  business you can **Edit** it (including the location) right there before
  filing; it's applied automatically when you assign the receipt. (A split that
  spans several businesses on one line stays view-only to avoid mis-binding a
  location — it's still fully editable on the transaction after you file it.)
- **Receipt origin at a glance.** A transaction's receipts now show where each
  came from — "via app" (the executive), "by manager", etc. — so it's clear the
  split was submitted by the approver.

Note: for a MATCHED transaction the accountant could already view and edit the
executive's split (including location) from the transaction detail; this release
brings that visibility to the Inbox (pre-filing) too.

## [1.9.1] — 2026-07-10

Three credit-card additions. **All additive** — the existing receipt match →
split → export flow is untouched, and there are **no worker/database changes**
(every endpoint these use already existed and already authorized the accountant).

### Added
- **Add receipts right from the Inbox — upload a PDF or take a photo.** The
  manager Inbox now has an "Add receipts" panel: drag-drop / choose PDF·JPG·PNG
  (as before) **plus a "Take photo" button** that opens the camera and snaps the
  receipt (via the device camera; it falls back to Choose files when no camera
  is available). Whatever you add lands in the inbox and is auto-matched, or is
  ready to file manually (below).
- **Look up and attach any transaction to an unmatched receipt.** When a dropped
  receipt can't be auto-matched, the "Assign to transaction" box now does a real
  server-side search of **any** transaction by vendor — with a **"All
  cardholders"** toggle for when the receipt resolved to the wrong person, and it
  can attach to a charge of any status (not just still-open ones). Previously it
  only filtered the resolved cardholder's most recent page.
- **Two-fold split: a business, then evenly across its locations.** In the split
  editor you can now put an amount on a business (e.g. $100 on Neroli) and click
  **"Split locations"** to divide it evenly across that business's locations
  ($20 to each of Neroli's five) — a "split across everything" plus a per-business
  even split. This works on the **computer** (the entity-split editor, which
  saves by location via line coding when you use it) and on the **phone** (a new
  "Even locations" button on each multi-location business). Businesses left as a
  single lump still save exactly as before.

The receipt-upload/camera, inbox search, and desktop split ship in the desktop
app; the phone even-split ships in the mobile receipt web app.

## [1.9.0] — 2026-07-09

Credit-card tab overhaul. **Everything is additive** — the existing receipt
match → split → export flow, invoice routing, approvals, and coding are
untouched; new columns/fields default empty and the ledger falls back to its
old layout if the worker hasn't picked up the new data yet.

### Fixed
- **"Mark as received" now sticks.** On the Receipt Tracker the check-off (and
  the bulk "Mark received") now confirm the change against the server and
  refresh the row, instead of only flipping the badge optimistically — so the
  status is saved and visibly reflected, with a confirmation toast.
- **"In QB" now shows a visible result.** Transactions has a new **In QB**
  column (a green check when a charge is in QuickBooks) and the detail panel has
  an **In QB** toggle, so the bulk "Mark in QB" / "Mark not in QB" actions
  visibly change something.

### Added
- **Manually allocate from the Receipt Tracker — with or without a receipt.**
  Each row has an **Allocate** action that opens the same coding tools used on
  Transactions (line-by-line coding when a receipt already has OCR lines,
  otherwise the entity-split editor). Receiptless charges can be split freely.
- **Overall GL category, like invoicing.** After a charge is split, the CC
  accountant can pick an **overall GL category** from the entity's Chart of
  Accounts (the same picker invoices use). It resolves to a **real GL account
  number** (via the charge's largest-split entity) and is shown on the
  Transactions detail, on the Ledger (new **GL Acct** column), and in the
  Transactions/Ledger Excel exports.
- **Pivot ledger — one workbook per card, one sheet per cardholder.** Opening
  the Ledger now lets you pick a card (**Capital One** or **American Express**),
  see that card's cardholder summary, then open a cardholder's split sheet —
  mirroring the manual per-card workbook. Excel export follows suit: exporting
  from a card produces that card's workbook (a sheet per cardholder + a Summary
  sheet).

The GL-account resolution, the `gl_category` field, and the ledger's per-card
`source` are **server-side (worker)** additions (a new nullable
`cc_transactions.gl_category` column via the standard additive migration); the
tracker, transactions, and ledger UI ship in the desktop app.

## [1.8.9] — 2026-07-09

### Fixed / Changed
- **Sidebar footer stays visible on every page.** "Check for invoices" and
  "Sign out" (bottom-left) are now pinned to the screen, so they no longer
  scroll away on long lists (Invoices, Transactions, etc.).
- **Deleted invoices and finished reviews now update the list and dashboard
  right away.** The dashboard's KPI counters were still counting archived
  ("Cleared") invoices; they now exclude them (matching the charts and the
  list). The Invoices list also refreshes on its own (and when you return to
  the window), so a change made elsewhere shows up without leaving the page.
- **Split invoices export correctly across entities and locations.**
  - The invoice's **actual sales tax is split per location** (e.g. $15 tax
    across five Neroli locations → $3 on each), instead of a recomputed
    per-location estimate — so a split bill's total always **reconciles to the
    invoice total** (a $400 bill coded $200 IBW / $200 Nala exports as exactly
    $200 + $200).
  - **Uncoded lines can no longer vanish silently.** If a per-line split leaves
    some lines uncoded, the export now **warns** with the exact count and dollar
    amount that would be left out — and because it checks the actual dropped
    lines (not the OCR'd total), a line OCR simply missed can't trigger a false
    alarm.

### Added
- **Download by entity on the Export tab.** After "Factor invoices for bill
  import" (which still downloads the combined all-tabs workbook), one-click
  buttons let you download each entity's sheet on its own — Neroli, SKNBar,
  IBW, and so on.

The export/reconciliation changes are **server-side (worker)** and stay entirely
in the export layer — invoice routing, approvals, and credit-card matching are
untouched. The sidebar and Export-tab changes ship in the desktop app.

## [1.8.8] — 2026-07-09

### Added
- **Download a credit-card receipt.** When you open a receipt (from Transactions,
  the Receipt Tracker, or the Inbox), a **Download** button now lets you save a
  copy of the PDF or image you're viewing. (Invoices already had Download PDF on
  the invoice page.)
- **Download an invoice PDF straight from the Invoices list.** Each invoice row
  that has a PDF now has a one-click **PDF** download, so you don't have to open
  the invoice first.
- **Collapse / expand each cardholder in the Credit Card Ledger.** Click a
  cardholder's header to fold its split matrix away (the header and charge count
  stay visible) and click again to expand — handy when the ledger has many
  cardholders. Sections start expanded, exactly as before.
- **Hover tooltips on cut-off text.** Long file names, merchant/cardholder names,
  and the entity · location · GL coding labels that were truncated now show their
  full value on hover (the coding label even spells out the full GL category).

These are all **view-only conveniences** — downloading, folding a section, and
hover tooltips. Nothing about invoices, receipts, matching, splits, coding, or
exports is changed; no data is created, edited, or removed.

## [1.8.7] — 2026-07-09

### Changed
- **Rebranded to "EBG - Invoices and Credit Cards" with a dollar-bill logo.** The
  app name now reads **EBG - Invoices and Credit Cards** everywhere it shows —
  the sidebar (EBG over "Invoices & Credit Cards"), the login screen, the window
  and taskbar title, the installer, and the Start Menu shortcut. The old "IQ"
  badge is replaced by a dollar-bill (banknote) mark in the same brand color,
  including the app/taskbar icon. No functionality changed; the internal app id
  is unchanged so existing installs still auto-update in place.

## [1.8.6] — 2026-07-09

### Added
- **Credit Card Accountant is now a Credit-Cards-only view.** A user with the
  "Credit Card Accountant" role now sees only the Credit Cards module — the same
  Credit Cards view an admin sees (Dashboard, Ledger, Receipt Tracker,
  Transactions, Inbox, Upload, Notifications, Cardholders, My Receipts) — and
  none of the invoicing/AP screens. They land directly on the Credit Cards
  dashboard, their sidebar shows just Credit Cards + Settings, and the AP pages
  are off-limits (typing an invoice URL bounces them back to Credit Cards). All
  other roles are unchanged. (Assign the role in Admin → Users.)

### Fixed
- **"Check for updates" no longer errors right after a release ships.** Updating
  could briefly fail with "Cannot find latest.yml … 404" in the ~8-second window
  after a new release went live but before its auto-update metadata finished
  uploading. The release pipeline now keeps each release as a hidden draft until
  every file is uploaded and only then publishes it, so that window is gone — and
  the app also retries that transient case and shows a friendly "a new version is
  finishing publishing, try again in a minute" message instead of a raw error.

The Credit-Card-Accountant view ships in the desktop app; the auto-update fix is
part release pipeline (protects all installed clients on the next update) and
part desktop app.

## [1.8.5] — 2026-07-09

### Changed
- **Dashboard vendor/category charts are now fully hover-driven — zero baked-in
  text.** Following up on 1.8.4: the "Spend by entity", "Spend by category", and
  "Top vendors" panels no longer show any legend or axis labels. They're clean
  charts you explore by hovering — point at a donut slice or a vendor bar and a
  tooltip shows the **name, amount, and percent of total**. (The credit-card
  dashboard's per-cardholder progress bars keep their names, since the name is
  what identifies each row there.)
- While you hover a donut slice, the centered **TOTAL** fades out so the tooltip
  reads cleanly in that space — no more text overlapping in the middle of the
  donut. Vendor-bar tooltips are labeled "Spend" instead of a generic "Value".

This is a **desktop-app (renderer) change**; it ships in the installer.

## [1.8.4] — 2026-07-09

### Added
- **Invoices paid by credit card are routed to the Credit Cards section
  automatically.** When an invoice is scanned and the document states it was
  paid on a card (e.g. "Paid by Credit Card", "Visa ending 1234", "charged to
  card on file"), the invoice is lifted out of the accounts-payable flow and
  dropped into the Credit Card module: it auto-matches to the corresponding card
  transaction when one can be found, otherwise it lands in the accountant's
  receipt inbox to triage. The original invoice is **archived, never deleted**,
  so a mis-detection is fully recoverable. Detection reads a new "how it was
  paid" field captured during OCR extraction and is deliberately conservative —
  a generic "we accept Visa/Mastercard" footer does not trigger it. If the
  Credit Card module isn't enabled, nothing changes and the invoice stays in AP.

### Changed
- **Dashboard charts redesigned — no more overlapping or spilled text.** The
  "Top vendors" and "Spend by category / entity" panels no longer print labels
  on top of the chart. Instead you get clean charts with a hover tooltip that
  shows the exact **name, amount, and percent of total** for whatever slice or
  bar you point at, plus a compact legend beneath each donut. Long vendor and
  category names are truncated (full name on hover) so nothing runs off the card.
- **KPI cards (Total AP, Invoices, Avg Invoice, etc.) restyled** to a cleaner,
  more uniform, professional layout — same color scheme, refined spacing,
  iconography, and typography.

### Fixed
- **Deleting a credit-card transaction now removes it from all dashboard
  reporting.** Archived/deleted CC transactions were still counted in the Credit
  Card dashboard's totals, per-cardholder breakdown, KPIs, spend-by-category,
  spend-by-entity, and monthly trend — so the numbers overstated real spend.
  Every dashboard aggregation now excludes archived transactions, so reporting
  reflects only transactions that still exist.

The dashboard/UI changes ship in the desktop app; the invoice-routing and
CC-dashboard fixes are **server-side (worker)** and take effect as soon as the
worker redeploys.

## [1.8.3] — 2026-07-09

### Fixed
- **Invoices tab now loads at scale (the real root cause).** Once an account had
  more than ~100 invoices, the Invoices list failed with a database error
  (`D1_ERROR: too many SQL variables`) and showed nothing. Cause: the list ran a
  single query that bound one parameter per invoice to compute review-flag
  counts, and Cloudflare D1 caps a query at 100 bound parameters — so with a few
  hundred invoices the whole request 500'd. The query now batches its lookups in
  chunks of 90, so it works no matter how many invoices exist.
- **Same fix applied to Export and bulk credit-card operations**, which used the
  identical "one parameter per id" pattern and would have failed the same way at
  scale (invoice export, audit-log name lookups, CC upload-batch delete/dedup,
  notification scoping). All now batch their queries under the D1 limit.

This is a **server-side (worker) fix** — the desktop app is unchanged from 1.8.2;
the version bump is just the release marker. The fix takes effect as soon as the
worker redeploys.

## [1.8.2] — 2026-07-09

### Fixed
- **Invoices tab no longer shows up empty with no explanation.** The Invoices
  page now surfaces load failures (with a Retry) instead of silently showing an
  empty list, and when the list is genuinely empty it explains why and offers a
  way out: if invoices were archived (e.g. via "Clear"), a **Show archived**
  button reveals and restores them; active filters get a **Clear filters**
  button; and non-admin roles are told they only see invoices assigned to them.
  (Root cause: the page never read the API error, so any failed/empty load looked
  identical to "no invoices.")

### Added
- **"Do you want to split it?" after uploading a credit-card receipt.** Uploading
  a receipt no longer jumps straight into the split screen. After the receipt is
  saved (and the accountant notified), the exec gets a clear choice — **Split it**
  (opens the split/coding step) or **Not now / Send as-is** (files it for the
  accountant to code). Works the same on the desktop app (My Receipts) and the
  phone site.

## [1.8.1] — 2026-07-07

### Added — Executive Mobile Receipt Site
- **Split one business across multiple locations.** On the phone quick-split, a
  multi-campus business (Neroli, Skn Bar Rx, Institute) now has a **"📍 Locations"**
  picker that lets you select **more than one** location at once — each chosen
  location gets its own amount row (e.g. Neroli → Downtown $40, Eastside $40,
  Mequon $40). Previously each business was limited to a single location. Single-
  location businesses (Nala, Admin, Institute Chicago, Urban Ayurveda) are
  unchanged. Everything still balances exact-to-cent and rolls up to the
  accountant's ledger; no backend or data-model change (the entity × location ×
  GL model already supported it — this unlocks it in the UI).

## [1.8.0] — 2026-07-07

### Added — Executive Mobile Receipt Site
- **Split by location (institution), not just business.** On the phone split
  screen, tapping a multi-campus business (Neroli, Skn Bar Rx, Institute) opens a
  location picker so the exec chooses the exact campus — Neroli → Mequon /
  Downtown / Eastside / North Shore / Brookfield; Skn Bar Rx → Shorewood /
  Pewaukee; Institute → Milwaukee / Madison; the single-location businesses
  (Nala, Admin, Institute Chicago, Urban Ayurveda) select automatically. The
  location map is the **same one the desktop invoice splitting uses**.
- **Optional line-by-line split.** A "Line by line" mode lets the exec assign
  each scanned line item — and the sales tax — to its own business **and**
  location, with a live per-line + whole-receipt reconcile. "Quick split"
  (whole receipt across businesses/locations) remains the default.
- **Reskinned to match the desktop app.** The mobile site now uses the invoice
  app's warm cream/charcoal/mauve palette and typography (Hanken Grotesk,
  Cormorant Garamond, Marcellus) instead of the earlier dark theme.

### Under the hood
- The exec's split now flows through the existing entity × location × GL
  line-coding model, so a mobile receipt codes the same way the accountant codes
  on desktop, and still rolls up to the accountant ledger automatically. The
  pending-match carry-through was upgraded to carry the richer coding and apply
  it when the charge matches — fully backward compatible with the previous
  entity-only split.

### Note
- As with 1.7.0, the **desktop app is unchanged** in this release — 1.8.0
  upgrades the server-served mobile receipt site. The version bump keeps the
  product on one version line.

## [1.7.0] — 2026-07-07

### Added
- **Executive Mobile Receipt Site.** A lightweight mobile web app (no install —
  executives just open a link and stay signed in) that lets a cardholder snap a
  store receipt on their phone, review the OCR-scanned line items and total, do
  the **same entity split as the desktop app** (the identical 7 entities and
  exact-to-cent balancing), and submit — it flows straight to the Credit Card
  Accountant for approval, auto-matching to the card charge when the statement is
  already imported. It reuses the existing server: same login, same OCR + match,
  same split validation, same inbox. Served same-origin by the InvoiceIQ worker
  as static assets, so there is no second server to run.
  - When the charge is already on the statement, the split is applied on submit.
  - When the charge hasn't imported yet, the receipt is filed to the accountant
    and the split is **saved to apply automatically** the moment the charge
    matches — the exec never has to come back.
  - **Additive only:** the desktop app, the invoice flow, and every existing
    Credit Card screen are untouched. The worker still serves every `/api/*` and
    `/ingest/*` route exactly as before (verified: API paths are never shadowed by
    the mobile site; only non-API paths serve the app).

### Note
- The **desktop app is unchanged from 1.6.4** in this release — 1.7.0 adds the
  server-side mobile receipt site. The version bump keeps the product on a single
  version line; there's nothing new to click in the desktop app itself.

## [1.6.4] — 2026-07-07

### Added
- **Credit Card Accountant "Ledger."** A new **Ledger** tab in the Credit Cards
  module reproduces the per-cardholder accounting workbook automatically: one
  section per cardholder with the exact columns — Receipt · In QB · Date · Vendor
  · Charge · one column per business entity (Nala Beauty Brands, Urban Ayurveda,
  Skn Bar Rx, Admin, Institute, Institute Chicago, Neroli) · Total · Difference ·
  Notes — populated from each transaction's entity splits ("after splits are
  done"). Fully-split charges reconcile to a blank Difference; unsplit or credit
  rows are flagged so nothing slips through. Totals row per cardholder, and a
  cycle date filter.
- **One-click Excel export** of the ledger that matches the workbook: one sheet
  per cardholder (named "Name last4") plus a Summary sheet.
- **Credit Card Accountant is now a selectable role when onboarding a user** — it
  grants access to the Credit Cards module and this ledger.

### Changed
- Role names now display cleanly everywhere (sidebar + user management) — e.g.
  "Credit Card Accountant" instead of the raw value.

## [1.6.3] — 2026-07-06

### Added / Changed — vendor coding
- **~30 common vendors now code themselves.** Added a managed vendor list
  (Culligan, Cintas, CTC Supplies, Wella, OPI, Marlo, Concordance, Ultraceuticals,
  Cohere, FROMM, UKG, TOGO, Gordon Flesch, Global Sight, STAMM, Salescomm, Delta
  Dental, CSC, Colectivo, Imaginal, Brixmor, West Place, WASH, Adelman, Avellas,
  Beautiful Clean, Guthrie & Frey, Fish Window Cleaning, Pivot Point, and more) so
  their invoices auto-code to the correct GL category. Each mapping sets the
  **category only** — the entity, location, and approver are still decided per
  invoice by the address and routing rules (nothing hard-coded to a vendor).
- **Water / utility invoices recognized by keyword.** Invoices from water vendors
  (e.g. Culligan / "Total Water Treatment Systems") now code to **Utilities** even
  when the vendor isn't on the mapped list — the keyword is read from the vendor
  name, so a breakroom-water statement no longer falls into a generic bucket.
- **Untangled "Olive Garden" vs "Olivia Garden."** The beauty-tools brand
  (Olivia Garden) codes to Retail / Product Costs; the restaurant (a stray test
  line) codes to Guest Relations. Removed the old alias that conflated them.
- **Soundness fix:** a mapped vendor whose account doesn't exist for an unusual
  entity now falls through to review instead of exporting a blank account number.

Verified against the coding-audit corpus with the regression gate — every change
maps to an intended vendor/keyword/category rule, with no unexplained coding
regressions. The vendor mappings auto-seed on deploy (no manual step).

## [1.6.2] — 2026-07-05

### Changed
- **Cleaner Credit Cards UI.** The Credit Card section got a visual refresh — a
  clearer highlighted tab in the sub-navigation, crisper status badges, tidier
  tables and cards, cleaner receipt drop-zones, and a clear selection indicator
  in the inbox. Same colors and all the same features — just a more polished,
  easier-to-scan layout. (Credit Cards only; the rest of the app is unchanged.)

## [1.6.1] — 2026-07-05

### Fixed
- Review banner now reads "1 line item **is** flagged for review" (subject-verb
  agreement for the single-line case).

## [1.6.0] — 2026-07-05

### Fixed / Changed — invoice OCR → GL coding accuracy
A systematic pass on how invoices are read and coded, from a diagnosis of real
mis-codings (e.g. a locker invoice billed to Madison that coded to Milwaukee and
booked steel lockers as "Service Costs").

- **Right location / class.** Coding now weighs *unique* address evidence (city,
  street, ZIP) above brand names shared by co-located campuses, and normalizes
  street-suffix variants (Ln↔Lane, St↔Street, …), so an invoice billed to Madison
  no longer defaults to Milwaukee. When the evidence is genuinely ambiguous it is
  **flagged for review instead of guessed** (a "Location needs confirmation" chip).
- **Equipment is no longer "Service Costs."** Lockers, fixtures, furniture, chairs,
  stations, cabinets, shelving and the like now code to **Equipment & Fixtures**.
  The "looks like a product" test was tightened (generic words like "color"/"spray"
  no longer force a product coding), and keyword/model evidence now outranks the
  generic fallback — while genuine salon/spa products still code as product.
- **Low confidence actually means something.** Fallback-coded and low-confidence
  lines are now flagged for review (and the OCR "unsure" signal that was being lost
  on every invoice is repaired), so weak codings surface in the review queue
  instead of flowing to approval unnoticed.
- **Money adds up.** Restored the reconciliation check — if booked lines + tax don't
  equal the invoice total, the invoice is flagged with the exact gap. **Shipping /
  freight is now captured as its own coded Freight line** instead of silently
  vanishing.
- **Reprocess keeps your work.** Re-running an invoice now preserves manual GL
  overrides and line splits instead of wiping them.
- **Smarter approval routing.** Large equipment purchases route to senior approval
  even under the dollar threshold, and exactly-$10,000 invoices now hit the senior
  rule.
- **Export warns instead of blocking.** Export now warns (with a confirm) when an
  invoice still has review flags, ambiguous location, or a reconciliation gap —
  and only hard-blocks lines that truly can't be coded.

Verified against the coding-audit corpus with a baseline-vs-after regression gate:
every behavior change maps to an intended fix, with no unexplained coding
regressions. Adds three self-applying database columns (shipping, location flag,
reconciliation delta) — no manual migration step.

## [1.5.0] — 2026-07-04

### Added
- **Redesigned dashboards — clean, QuickBooks-style analytics for both Invoices
  and Credit Cards.** Each dashboard now opens with a row of KPI stat cards and a
  set of charts, all driven by your real data:
  - **Invoice dashboard:** Total AP, invoice count, average invoice, awaiting
    approval (with overdue count), export-ready, and exported-this-month cards; a
    12-month accounts-payable trend; and spend-by-entity, top-vendors, and
    spend-by-GL-category charts — above the existing invoice queue, which is
    unchanged.
  - **Credit Card dashboard:** Total spend, transactions, receipts-received %,
    open receipts, in-QuickBooks, and unmatched cards; a 12-month spend +
    receipt-completion chart; per-cardholder progress with a quick "Remind" list;
    and a spend-by-entity breakdown — keeping the cycle date filter.
- Numbers are computed on the server so they stay accurate at scale and reconcile
  with the underlying invoice/transaction lists (archived items excluded, same as
  the lists). Two new read-only analytics endpoints back the charts; the existing
  summary/stats endpoints are unchanged.

Charts render fully offline (no external services). No database migration is
required.

## [1.4.0] — 2026-06-29

### Added
- **Delete an upload batch (managers), safely.** You can now remove a wrong import
  from the Credit Cards → Upload history. The delete is **guarded**: if any
  transaction in that batch already has a receipt, coding, or is marked in
  QuickBooks, the app refuses and tells you how many are affected — you can still
  **"delete anyway"** to confirm. Deleting a batch cleans up after itself
  (its transactions, receipts, splits, line coding, and stored files), and any
  dropped receipts that were matched to those transactions are returned to the
  inbox queue rather than lost.
- **Bulk actions on the Transactions list (managers).** Select multiple
  transactions (with a select-all option) and apply one action to all of them:
  **set receipt status**, **mark in / not in QuickBooks**, **reassign cardholder**
  (the fast way to fix a whole UNMATCHED batch), **archive**, or **export the
  selected rows to Excel**.

Both are manager-only and isolated to the Credit Cards module; the invoice
workflow is unchanged, and there is no database migration in this release.

## [1.3.9] — 2026-06-29

### Added
- **Fix a mis-parsed Credit Card transaction (managers).** A new **Edit details**
  button on a transaction opens a modal to correct the **vendor, amount,
  transaction date, and category** when the import read them wrong — plus the
  **Exp Acct** and **In QB** fields, which previously had no place to edit. Only
  the fields you change are saved. If you change the amount on a transaction that
  already has entity splits or line coding, the modal warns you to re-check the
  coding so it still reconciles.
- **Reassign a transaction to the right cardholder (managers).** The Cardholder
  field in a transaction's detail is now an editable dropdown of active
  cardholders — the fastest way to resolve an **UNMATCHED** charge — with an
  "Unassigned" option to clear it. (The permission for this already existed; it
  just had no control until now.)

Editing and reassigning are manager-only; cardholders can still only edit notes
on their own transactions. Changes are isolated to the Credit Cards module; the
invoice workflow is unchanged, and there is no database migration in this release.

## [1.3.8] — 2026-06-29

### Added
- **Safe "Download Excel + Clear" for Credit Card transactions.** Managers can now
  declutter the Transactions list at the end of a cycle the same way the invoice
  side works: one button **exports the current view to Excel first, and only then
  archives** those transactions. If the export fails for any reason, nothing is
  archived — so you never lose a record. Archiving is **reversible** (it hides
  rows, it does not delete them).
- **Show archived / Unarchive.** A **Show archived** toggle brings hidden
  transactions back into view (shown muted with an "Archived" badge), and an
  **Unarchive** button in a transaction's detail panel restores it to the normal
  list.
- The archive covers the **full filtered set**, not just the page on screen, so a
  cycle clear is complete.

The hidden/restored state is stored in a new, automatically-applied database
column — **no manual setup or migration step** is required; it upgrades itself on
update. Changes are isolated to the Credit Cards module; the invoice workflow is
unchanged.

## [1.3.7] — 2026-06-29

### Added
- **Download Excel on every Credit Card list.** The Credit Cards module now has a
  proper **Export Excel** button on **Transactions**, **Receipt Tracker**,
  **Cardholders**, **Notifications**, and the **Dashboard** — real `.xlsx` files
  matching the rest of the app (the Transactions export used to be CSV).
- **Transactions/Receipt-Tracker exports now cover the full filtered set**, not
  just the first page on screen. The export pulls every matching row (respecting
  your current filters and search) instead of silently stopping at 200, so a
  cycle export is complete.
- **Delete a wrong receipt from the app (managers).** A manager can now remove a
  mistakenly-attached receipt directly from a transaction's detail panel. When the
  last receipt is removed, the transaction's receipt status automatically reverts
  to **Pending** (a deliberate *Not required* / *Waived* status is left untouched).
- **Discard junk dropped receipts from the inbox (managers).** Manager inbox /
  returned-receipt views now have a delete (trash) action to clear out duplicate
  or junk dropped receipts that were sitting in the queue with no way to remove
  them.

All changes are isolated to the Credit Cards module — the invoice workflow is
unchanged, and there is no database migration in this release.

## [1.3.6] — 2026-06-29

### Fixed / Added
- **Misspelled vendor names now code correctly (vendor aliases).** When the OCR
  reads a vendor name with a spelling/character error (e.g. `Olivia Garden`
  instead of `Olive Garden`), the invoice used to miss the vendor's mapping and
  get mis-coded (e.g. Repairs & Maintenance instead of Retail). You can now map a
  variant to the right vendor and it inherits that vendor's correct GL coding,
  entity, and approver routing. The known `Olivia Garden → Olive Garden` case is
  fixed automatically; others you can add yourself.
- **Manage vendor aliases in the app.** On the **Vendors** admin page, expand a
  vendor to add/remove alias spellings under it — one field to map, say,
  `Olivia Garden` to `Olive Garden`. Aliases apply to the next invoice processed.
- Matching stays **deterministic and safe**: only the aliases you approve change
  coding — the app never auto-merges two different vendors on its own. (Verified
  against the coding audit with **zero regressions**; e.g. `Olive Branch` is not
  treated as `Olive Garden`.)

## [1.3.5] — 2026-06-29

### Changed
- **QuickBooks bill-import export reformatted to match QBO.** The factor / QBO
  Bill Import spreadsheet now exports:
  - **Class = the location only** (e.g. `Mequon`, `Madison`) instead of
    `Entity:Location` — the business is the tab.
  - **Account/category names without the leading number** (e.g.
    `Repairs & Maintenance`, not `6290 Repairs & Maintenance`).
  - **Vendor names without the legal suffix** (e.g. `CTC Supplies INC` →
    `CTC Supplies`, `AbbVie US LLC` → `AbbVie US`).
  - A **business total row at the bottom of each entity tab** (a `Total — <Entity>`
    summary line, kept below a blank row with the import key-fields empty so a QBO
    import skips it).
  Invoices **split across multiple entities/locations** continue to land in the
  correct entity tab with the correct location and amount (verified to reconcile).
  The CSV export is unchanged.

## [1.3.4] — 2026-06-29

### Fixed
- **Re-downloading a bill-import (QBO) export from Export History produced a file
  Excel wouldn't open.** The history "Download" button saved the stored export
  data as a raw file instead of rebuilding the spreadsheet, so the `.xlsx` wasn't
  actually a workbook. It now rebuilds a proper multi-tab `.xlsx` on re-download,
  matching the original export. (The first download at export time was always
  fine; only the re-download was affected. CSV exports were never affected.) **Any
  bad file you already saved is recoverable — just click Download again on that
  export in Export History after updating; no re-export needed.**

## [1.3.3] — 2026-06-29

### Added
- **Credit Cards — drop receipts and let them auto-file.** A cardholder can now
  upload one or more receipt photos/PDFs **without first finding the transaction**.
  The OCR reads each one and **auto-matches it to one of their transactions** (by
  card, amount, and date). If it can't be sure, the receipt goes to the **Credit
  Card Accountant's new Inbox**, who can preview it, **assign it to the right
  transaction** (with suggested matches), or **send it back** to the cardholder
  with a note. Drop several at once — each is filed or queued independently.
- **A "Quick split" tab — the fast way to code a receipt.** The coding screen now
  opens on **Quick split**: pick the **business** → **location(s)** (defaults to
  "all") → **Back bar / Retail / 50-50**, applied to the whole charge (sales tax
  follows the locations). The detailed **Line by line** grid is now a second tab
  you only use when a receipt needs different coding per item.

### Changed
- The receipt coding flow now opens on **Quick split** by default instead of the
  old entity-only split (which remains available behind the scenes).

(Still separate from invoicing; the new inbox table applies automatically on
deploy — nothing to run.)

## [1.3.2] — 2026-06-27

### Added
- **Credit Cards — code a receipt line by line.** When a receipt is uploaded, the
  OCR now reads it **line by line**, and each line can be coded individually:
  - Pick the **entity** (Neroli, SKNBar, IBW, …), then the **location(s)** — one,
    several, or "all". Picking multiple locations **splits that line evenly** across
    them (3 locations → 3 ways), and a **manual override** lets you set any amount by
    hand.
  - Mark each line **Back bar vs Retail** — including a **50/50** split.
  - The receipt's **sales tax** is read automatically and **split across the same
    locations** the lines used.
  - A live reconcile bar shows Receipt total / Allocated / Remaining; **Save unlocks
    only when it balances to the cent.**
  - Available to the cardholder at upload (in **My Receipts**) and to the manager in
    **Transactions**. A receipt the OCR can't itemize falls back to the existing
    whole-charge entity split.

(Still separate from invoicing; the new line-item tables apply automatically on
deploy — nothing to run. Back bar/Retail is recorded as a label only.)

## [1.3.1] — 2026-06-27

### Changed
- **Credit Cards — Amex import now reads the real Amex activity export (CSV or
  XLSX).** Previously the importer only accepted a per-cardholder workbook, so the
  standard Amex transaction report wouldn't upload. It now reads the flat activity
  export (Date · Description · Card Member · Account # · Amount) directly, as a
  **CSV or an XLSX**, and matches each row to the right cardholder by **card last-5
  and Card Member name** (so a cardholder still matches even when the last-5 on the
  export differs from the one on file). The per-cardholder workbook still works too.
- **Capital One cardholders can now upload and code their receipts in the app.**
  Instead of being sent to the Capital One mobile app, a Capital One transaction in
  **My Receipts** now offers the same in-app flow as Amex: upload the receipt
  (PDF/photo) and allocate it across the entities. Entity coding is available for
  both Capital One and Amex transactions (cardholder and manager views), and the
  manager is notified when a receipt is uploaded for either card.

(Still separate from invoicing; no database changes. Visible to the Credit Card
Accountant role + the test cardholder, per the beta rollout.)

## [1.2.10] — 2026-06-27

### Changed
- **Credit Cards — split the module into two role-based views.** The beta now
  shows the right view per person instead of one combined screen:
  - **Credit Card Accountant** (a new account you create with that role) — and
    admins — get the **full manager dashboard**: imports, all transactions, the
    receipt tracker, reminders, and the cardholder registry.
  - **Executives (cardholders)** get a personal **"My Receipts"** view only — just
    the card transactions *they* need to submit receipts for, with upload + entity
    split. No dashboard, no other people's data. During the beta this cardholder
    view is still limited to the test account (Lori); one switch opens it to every
    executive later.
  - The "Credit Cards" menu now lands each person on their correct screen and only
    offers the screens their role can use (the manager screens were already
    protected server-side). Still fully separate from invoicing; no database
    changes.

## [1.2.9] — 2026-06-27

### Added
- **Credit Cards — a new Credit Card Receipt module (beta, limited rollout).** A
  separate area for tracking corporate-card receipts and reconciling them against
  card transactions, built on the same OCR and entity-splitting engine as
  invoices. In this release it is visible **only to the test account (Lori)** while
  it's validated; everyone else sees no change. It adds:
  - **Weekly card imports** — upload the Capital One CSV and the Amex XLSX
    (per-cardholder sheets); transactions are matched to a cardholder by card
    last-4, with a preview (row count, date range, unmatched cards) before commit,
    duplicate detection, and blank-template handling.
  - **Receipt OCR with cardholder matching** — uploaded receipts are read by the
    same OCR, which now also pulls the **card last-4 and purchaser name** and
    auto-assigns the receipt to the right cardholder (flagging unmatched ones).
  - **Receipt tracker + reminders** — a per-cardholder checklist with status
    badges and one-click check-off, plus batch email reminders (with a mail-app
    fallback when email isn't configured).
  - **Entity splitting** — allocate an Amex charge across the business entities;
    the split must balance to the cent before it can be saved.
  - A new **Credit Card Accountant** role and Executive/cardholder view are wired
    but kept off until the beta is signed off.
- The new module is **fully separate from invoicing** — the existing invoice
  flow, coding, and screens are unchanged. Its database tables are created
  automatically on deploy; there is nothing to run.

## [1.2.8] — 2026-06-26

### Added
- **Download the invoice PDF while viewing it.** A **Download PDF** button now sits
  in the invoice detail header — anyone who can see the invoice can save its PDF.
- **Bulk-download approved PDFs as one .zip.** On the Export screen, **Download
  approved PDFs (.zip)** packages every export-ready approved invoice's PDF into a
  single zip (with progress), so you can file them all at once.
- **"APPROVED" stamp burned into the PDF.** Once an invoice is approved, its PDF
  carries an **APPROVED** stamp (approver name + approval date) on the first page.
  The stamp travels with the file everywhere it's downloaded — the single download,
  the bulk zip, and the QBO export — while the original scan is preserved untouched.
- **Download to Excel + Clear (safe archive) for the Invoices list and the Audit
  log.** Each view gets a **Download Excel** button (saves what's currently shown to
  a spreadsheet) and an admin-only **Clear** button that *exports the Excel first,
  then declutters the view* — it never deletes:
  - Invoices are **archived** (reversible): they drop out of the default list but
    are fully preserved, viewable via the **Show archived** toggle and restorable
    per-row with **Unarchive**.
  - The **Audit log is never altered.** Clear sets a personal "cleared up to here"
    bookmark that hides older entries from your view only; every audit row stays in
    the database permanently, and **Show all** brings the full history back.

### Note
- The archive / audit-clear features need an additive backend database change
  (a new column + a small table). This is applied **automatically** by the
  backend on its next deploy — there is no manual step and nothing to run on
  anyone's computer.

## [1.2.7] — 2026-06-26

### Fixed
- **Product-vendor invoices now code each line by what it actually is.** When a
  vendor was flagged as selling product (e.g. Pivot Point, CTC, Ultraceuticals),
  the app was stamping *every* line — shipping, tariffs, utilities, repairs — as
  Retail/Backbar based only on tax, **before reading the line**. That single defect
  was behind the recurring mis-codes. Those invoices now read each line:
  - **Shipping / freight / carriers** (UPS, FedEx, USPS, DHL) → **Freight (6150)**
  - **Tariffs / duties / surcharges / fees** → **Penalties & Fees (6255)**
  - **Utilities** → **Utilities (6360)**; **repairs / labor** → **Repairs & Maintenance (6290)**
  - genuine products still split by tax (untaxed → Retail, taxed → Backbar)
  Measured against an 86-line coding audit, accuracy on product-vendor invoices went
  from **35% → 100%** (overall 70% → 100%), and the high-confidence mis-bookings that
  were never flagged for review are gone. **Reprocess** an affected invoice to
  re-code it.

## [1.2.6] — 2026-06-25

### Fixed
- **Non-product expenses are no longer coded as products.** The "sales tax decides
  retail vs. backbar" rule had become a catch-all that swept *any* untaxed line
  into **Retail / Product Costs** and *any* taxed line into **Service Costs /
  Backbar** — even when the line wasn't a product. So a **water/sewer utility
  bill** landed in Retail, a **plumbing repair** ("Shower Leak — diverter cartridge
  replaced") landed in Backbar, and a **tax line** written as "Milwaukee City
  (7.9%)" was treated as a backbar product. Those line types are now recognized and
  coded correctly:
  - **Utilities** (water, sewer, electric, gas, trash/recycling, municipal fees) →
    **Utilities (6360)**
  - **Repairs / plumbing / labor / trade work** → **Repairs & Maintenance (6290)**
  - **Tax lines** written as a jurisdiction + percentage ("City (7.9%)") →
    **Sales/Use Tax**
  Genuine products still split by tax exactly as before — untaxed → Retail, taxed →
  Backbar — and the v1.2.5 inventory-vendor behavior is unchanged. **Reprocess** an
  affected invoice to re-code it.

## [1.2.5] — 2026-06-25

### Fixed
- **Sales tax now correctly decides retail vs. backbar — even for known product
  vendors.** Previously a vendor flagged as an "inventory" supplier was always
  coded to **Retail / Product Costs (5100)**, ignoring the invoice's sales tax — so
  a taxed supplies invoice (e.g. CTC Supplies, $18.54 tax) wrongly landed in 5100.
  Now the rule is consistent everywhere: **sales tax on the invoice → 5000 Service
  Costs (backbar); no sales tax → 5100 Retail / Product Costs.** A per-line tax
  overrides the invoice-level tax, an explicit non-product account (Freight, IT,
  etc.) still wins, and manual edits still win. **Reprocess** an affected invoice to
  re-code it.

## [1.2.4] — 2026-06-25

### Added
- **Accountants can send approval reminders.** The **Remind** button (recipient
  picker + a draft in your own mail app, or automated email if Resend is set up)
  is now available to accountants as well as executives/admins — so an accountant
  can nudge approvers to go in and review/approve.
- **macOS installer (.dmg).** Each release now also publishes a **`.dmg`**
  alongside the Windows `.exe`. It's unsigned, so on first open macOS may warn
  "unidentified developer" — right-click the app → **Open** to proceed.

## [1.2.3] — 2026-06-24

### Added
- **"Remind approvers" works without any email setup.** When automatic email
  (Resend) isn't configured, the **Remind** button now opens a ready-to-send draft
  in your own mail app (Outlook, Gmail, etc.) with the selected approvers
  pre-addressed (BCC) and the subject/message filled in — you just hit Send, from
  your own mailbox. If automatic email is configured later, it goes back to
  one-click sending automatically. (Replaces the dead-end "Email isn't configured"
  message.)

## [1.2.2] — 2026-06-24

### Fixed
- **Campus/class is now filled in automatically when the business is known but the
  address didn't pin a campus.** Some invoices route to the right business by
  **vendor** (e.g. Ultraceuticals → IBW) rather than by a full address match — and
  a vendor rule sets the business but not the campus, so the **Class** came up
  blank ("—"). The app now recovers the campus from the city on the invoice,
  scoped to that business (an IBW invoice that says "Milwaukee" → Milwaukee;
  "Madison" → Madison), so it can never cross into another business's campus. To
  apply it to existing invoices, **Reprocess** them.

## [1.2.1] — 2026-06-24

### Added
- **"Re-scan" button on each invoice** (accountant/admin). **Reprocess** re-runs
  the coding over the existing scan; **Re-scan** re-reads the PDF at the latest
  high-fidelity extraction *and* re-codes — without deleting and re-uploading, so
  the invoice keeps its history and audit trail. Manually-added lines are kept.

### Changed
- **Mapping updates now apply automatically on deploy.** Location keywords (like
  the "Institute of Beauty & Wellness" → IBW routing) and the managed product-
  vendor mappings (Wella, AbbVie, OPI, Olive Garden) are applied automatically the
  first time the backend handles a request after an update — no manual database
  command needed. Only those system-managed mapping rows are touched; invoices,
  line items, users, and vendor mappings you add yourself are never affected.

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

[1.2.7]: https://github.com/oofski/Invoice/releases/tag/v1.2.7
[1.2.6]: https://github.com/oofski/Invoice/releases/tag/v1.2.6
[1.2.5]: https://github.com/oofski/Invoice/releases/tag/v1.2.5
[1.2.4]: https://github.com/oofski/Invoice/releases/tag/v1.2.4
[1.2.3]: https://github.com/oofski/Invoice/releases/tag/v1.2.3
[1.2.2]: https://github.com/oofski/Invoice/releases/tag/v1.2.2
[1.2.1]: https://github.com/oofski/Invoice/releases/tag/v1.2.1
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
