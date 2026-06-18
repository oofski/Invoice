# InvoiceIQ — Windows Desktop App + Cloudflare Backend

This is the desktop build of InvoiceIQ: a downloadable **Windows app** (Electron)
backed by a **Cloudflare Worker + D1** database. (The Next.js app at the repo
root is an alternate web/Supabase target; the desktop app does not use it.)

```
desktop/renderer   Vite + React SPA (the UI), talks to the Worker over HTTPS
desktop/electron    Electron shell that loads the built SPA from file://
worker/             Cloudflare Worker (Hono) + D1 schema/seed = backend + DB
.github/workflows/release.yml   builds the Windows installer on a tag
```

## 1. Deploy the Cloudflare backend (one time)

```bash
cd worker
npm install
npx wrangler login                       # authenticate to your Cloudflare acct
npx wrangler d1 create invoiceiq          # copy the database_id into wrangler.toml
npx wrangler r2 bucket create invoiceiq-pdfs   # PDF object storage (binding PDFS)
npm run db:init                           # apply schema + seed to the remote D1

# Secrets (never committed):
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
# Optional vars in wrangler.toml: AWS_REGION, RESEND_FROM_EMAIL, APP_URL

npm run deploy                            # -> https://invoiceiq.<account>.workers.dev
```

## 2. Build the Windows installer (the download link)

The installer is produced by GitHub Actions on a Windows runner and attached to
a GitHub Release.

1. In the GitHub repo: **Settings → Secrets and variables → Actions → Variables**,
   add `VITE_API_BASE_URL` = your Worker URL from step 1.
   *(Optional — the app's login screen also has a "Server URL" field, so a built
   app can be pointed at any Worker without rebuilding.)*
2. Tag and push a version:
   ```bash
   git tag v1.0.0 && git push origin v1.0.0
   ```
3. The workflow builds `InvoiceIQ Setup 1.0.0.exe` and publishes it at:
   **`https://github.com/<owner>/<repo>/releases/tag/v1.0.0`**

### Build the installer locally instead (on Windows)
```bash
cd desktop
npm install
set VITE_API_BASE_URL=https://invoiceiq.<account>.workers.dev
npm run dist            # -> desktop/release/InvoiceIQ Setup 1.0.0.exe
```
(On Linux/macOS you can only produce an unpacked build via `npm run dist:dir`;
the signed NSIS `.exe` requires a Windows runner.)

## 3. First run

1. Install and launch InvoiceIQ.
2. On the login screen, confirm the **Server URL** points at your Worker.
3. Click **"First time? Create the admin account"** to bootstrap the first admin
   (only works while the database has no users).
4. Log in. As admin, create the accountant / executive / staff users
   (User Management shows each new user's temporary password to share securely;
   they set their own password on first login).

## Notes
- **PDF storage:** invoice PDFs are stored in **Cloudflare R2** (object storage,
  bucket `invoiceiq-pdfs`, binding `PDFS`) — built for large scans and high
  volume. D1 only holds the R2 object key + metadata in `pdf_files`. PDF
  read/write is abstracted in `worker/src/lib/storage.ts`.
- **Auth:** email + password (PBKDF2 + session tokens). No HTTPS/domain setup is
  required of you — Cloudflare serves the Worker over HTTPS automatically and the
  desktop app calls it directly.
- **No realtime:** the dashboard polls every 15s (D1 has no subscriptions).
