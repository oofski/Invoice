# Auto-ingest invoices from a SharePoint folder (Power Automate)

Drop a PDF into a SharePoint document library and have it flow straight into
InvoiceIQ — no one has to open the app and upload it. A Microsoft **Power
Automate** flow watches the folder and posts each new file to the Worker's
ingestion endpoint, which then runs the exact same pipeline as a normal upload
(Reducto OCR → 3 Claude prompts → approval routing).

```
SharePoint library  --(file created)-->  Power Automate flow  --HTTP POST-->  Worker /ingest/upload
```

## Endpoint

```
POST  https://invoiceiq.<your-account>.workers.dev/ingest/upload?filename=<name>.pdf
Header:  Authorization: Bearer <INGEST_TOKEN>
Body:    the raw PDF bytes
```

- Auth is a single shared secret, `INGEST_TOKEN` (not a user login).
- `201` = ingested and processing. `409` = duplicate (already in the system).
  `401` = bad/missing token. `503` = `INGEST_TOKEN` not set on the Worker.
- Ingested invoices are attributed to the **first admin user** and treated as an
  ACCOUNTANT submission, so they land in the normal approval queue.

## Step 1 — set the ingestion secret on the Worker

Pick a long random string for `INGEST_TOKEN` (e.g. a password generator, 32+
chars). Then add it to the Worker:

- **Dashboard:** Cloudflare → your Worker → **Settings → Variables and Secrets**
  → **Add** → type `Secret`, name `INGEST_TOKEN`, paste the value → **Deploy**.
- **CLI:** `wrangler secret put INGEST_TOKEN`

Keep this value handy — you paste it into Power Automate in Step 3.

## Step 2 — make the SharePoint drop folder

1. In SharePoint, open (or create) a site, then a **Document library** —
   e.g. `Invoices`.
2. Optionally add subfolders `Processed`, `Duplicates`, and `Failed` so the flow
   can file each PDF after sending it (keeps the inbox clean and gives an audit
   trail).

## Step 3 — build the Power Automate flow

Go to **make.powerautomate.com** → **Create** → **Automated cloud flow**.

1. **Trigger:** search **SharePoint** → **When a file is created (properties
   only)**. Choose your **Site Address** and the **Library Name** (`Invoices`).
2. **Action:** **SharePoint → Get file content.** Set **Site Address** to the
   same site, and **File Identifier** to the trigger's **Identifier** value.
3. **Action:** **HTTP** (this is a *premium* connector — see note below).
   - **Method:** `POST`
   - **URI:** `https://invoiceiq.<your-account>.workers.dev/ingest/upload?filename=`
     then click into the box and append the trigger's **File name with
     extension** dynamic value.
   - **Headers:**
     | Key | Value |
     | --- | --- |
     | `Authorization` | `Bearer <INGEST_TOKEN>` |
     | `Content-Type` | `application/pdf` |
   - **Body:** the **File Content** output from the *Get file content* step.
4. *(Optional but recommended)* Add a **Condition** on the HTTP step's
   **Status code**:
   - `201` → **Move file** to `Processed`
   - `409` → **Move file** to `Duplicates`
   - otherwise → **Move file** to `Failed`
   To branch on the status code, set the HTTP action to "Get response
   schema"/expose the status, or use the `outputs('HTTP')['statusCode']`
   expression in the condition.
5. **Save**, then **Test** by dropping a sample invoice PDF into the library.

### Only process PDFs
If non-PDFs land in the folder, add a Condition right after the trigger that the
**File name with extension** ends with `.pdf` before doing anything else.

## Notes & gotchas

- **Premium connector:** Power Automate's **HTTP** action requires a *premium*
  Power Automate license (most Microsoft 365 business plans add this per-user or
  per-flow). If you don't have it, alternatives are the **"HTTP with Microsoft
  Entra ID"** connector or a small Azure Logic App; the request shape is
  identical.
- **Large/slow scans:** the endpoint runs OCR + 3 AI prompts before responding,
  which can take 10–30s. Power Automate's HTTP action waits up to ~120s by
  default, which is plenty.
- **Duplicates:** the Worker rejects a re-drop of the same vendor + invoice # +
  total with `409` — safe to ignore or file into `Duplicates`.
- **Security:** anyone with the URL **and** the `INGEST_TOKEN` can submit
  invoices, so treat the token like a password. Rotate it by setting a new
  `INGEST_TOKEN` secret and updating the flow's `Authorization` header.
- **Turning it off:** delete/disable the Power Automate flow, or remove the
  `INGEST_TOKEN` secret (the endpoint then returns `503`).
