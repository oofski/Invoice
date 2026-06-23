# Deploy the backend from the Cloudflare dashboard (no CLI)

This sets up the entire InvoiceIQ backend — database (D1), PDF storage (R2), the
Worker, and secrets — using only the **Cloudflare dashboard** and the **GitHub
web editor**. You don't install `wrangler` or anything else on your computer.

> The idea: Cloudflare connects to your GitHub repo and builds + deploys the
> Worker for you every time the code changes. You just click through the
> dashboard and edit one config value in GitHub's website.

**Order:** Create D1 → put its ID in `wrangler.toml` (GitHub web) → create tables
→ create R2 bucket → connect the repo & deploy → add secrets → get the URL.

---

## 1. Create a Cloudflare account
Go to **dash.cloudflare.com** → **Sign up** (free). Verify your email and log in.

## 2. Create the D1 database
1. Left sidebar → **Storage & Databases → D1 SQL Database** → **Create**.
2. Name it exactly **`invoiceiq`** → **Create**.
3. On the database page, copy the **Database ID** (a long `xxxxxxxx-xxxx-...`
   string). You'll paste it in the next step.

## 3. Paste the Database ID into `wrangler.toml` (GitHub website)
The Worker needs to know which database to use. This ID is **not a secret**
(it's just a resource name; access still requires your Cloudflare login), so
it's fine to commit.

1. In your browser go to **github.com/oofski/Invoice** → open
   **`worker/wrangler.toml`** → click the **pencil (Edit)** icon.
2. Find:
   ```toml
   database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"
   ```
   and replace the placeholder with the ID you copied:
   ```toml
   database_id = "your-real-database-id-here"
   ```
3. **Commit changes** → commit directly to the **`claude/zen-goldberg-wgv2c4`**
   branch (or `main` if that's what you deploy from).

## 4. Create the tables (D1 Console)
1. Back in Cloudflare → your **`invoiceiq`** D1 database → **Console** tab.
2. In GitHub, open **`worker/src/db/schema.sql`**, click **Raw**, select all,
   copy.
3. Paste it into the D1 **Console** query box → **Execute**. This creates all 8
   tables and seeds the location/vendor routing lists. (If the box rejects the
   whole thing at once, paste and run it in a few chunks — order doesn't matter
   for the `CREATE TABLE` statements.)
4. You can confirm with `SELECT name FROM sqlite_master WHERE type='table';`

## 5. Create the R2 bucket (PDF storage)
1. Left sidebar → **R2 Object Storage** → **Create bucket**.
   (R2 asks for a payment method to enable it, but the free tier covers a lot;
   you won't be charged within it.)
2. Name it exactly **`invoiceiq-pdfs`** → **Create bucket**.
   *(The name must match `wrangler.toml`'s `bucket_name`.)*

## 6. Connect the repo and deploy the Worker
1. Left sidebar → **Compute (Workers)** → **Workers & Pages** → **Create** →
   **Workers** → **Import a repository** (connect your GitHub account if asked,
   and grant access to the `Invoice` repo).
2. Select **oofski/Invoice**.
3. Configure the build:
   - **Branch:** the branch you committed to in step 3 (e.g.
     `claude/zen-goldberg-wgv2c4`).
   - **Root directory:** `worker`
   - **Deploy command:** `npx wrangler deploy`
   - (Build command can be left default; Cloudflare runs `npm install` for you.)
4. **Save and Deploy.** Cloudflare clones the repo, installs dependencies, reads
   `wrangler.toml` (picking up the D1 + R2 bindings), and deploys. First build
   takes a couple of minutes.

## 7. Add the secrets
The API keys are kept out of the code. Add them to the Worker:

1. Cloudflare → your **invoiceiq** Worker → **Settings → Variables and Secrets**.
2. **Add** each of these as type **Secret** (encrypted, not "Text"):
   | Name | Value |
   | --- | --- |
   | `ANTHROPIC_API_KEY` | from console.anthropic.com |
   | `REDUCTO_API_KEY` | from your Reducto dashboard |
   | `INGEST_TOKEN` | *(optional)* a long random string — only if using SharePoint ingest |
3. **Deploy** to apply. (If the Worker was already serving traffic, trigger a
   redeploy: **Deployments → … → Retry**, or push any commit.)

> You don't need `RESEND_API_KEY` — email notifications are optional and the app
> works fully without them.

## 8. Get your Worker URL
On the Worker's page (or **Settings → Domains & Routes**) you'll see the address:

```
https://invoiceiq.<your-account>.workers.dev
```

Open it in a browser — you should see `{"name":"InvoiceIQ API","status":"ok"}`.
That confirms the backend is live.

## 9. Log in from the app and test
1. Launch the InvoiceIQ Windows app.
2. On the login screen, set **Server URL** to your `…workers.dev` address.
3. Click **"First time? Create the admin account"**, fill in your name/email/
   password, and submit (this only works while the database has no users).
4. Log in. Upload a sample invoice PDF — if it processes and routes to an
   approver, the full stack (D1 + R2 + Reducto + Claude) is working.

---

## Shipping later code changes
Because the Worker is connected to GitHub, **every push to the deploy branch
rebuilds and redeploys automatically** — no clicking required. Secrets and the
D1/R2 data persist across deploys.

## Troubleshooting
- **Login says "network error":** the Server URL is wrong, or the deploy failed.
  Visit the `…workers.dev` URL directly — it must return the `status: ok` JSON.
- **Upload fails / "AI processing failed":** a secret is missing or wrong. Re-check
  `ANTHROPIC_API_KEY` and `REDUCTO_API_KEY` in **Settings → Variables and Secrets**,
  then redeploy.
- **"D1_ERROR" / no such table:** step 4 didn't run — re-run `schema.sql` in the
  D1 Console.
- **Build fails:** confirm **Root directory = `worker`** and the D1 **Database ID**
  in `wrangler.toml` is filled in (step 3).
