import { Resend } from "resend";

/**
 * Resend transactional email (Brief §04 step 6, §09). Sends approval requests,
 * reminders, and rejection notifications. Emails always include the invoice
 * vendor, amount, entity, due date, and a direct login/deep link.
 */

let _client: Resend | null = null;
function getClient(): Resend {
  if (!_client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("Missing RESEND_API_KEY env var");
    _client = new Resend(key);
  }
  return _client;
}

function fromAddress(): string {
  return process.env.RESEND_FROM_EMAIL || "invoices@example.com";
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

function money(n: number | null | undefined): string {
  const v = typeof n === "number" ? n : 0;
  return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

interface InvoiceEmailData {
  invoiceId: string;
  vendor: string;
  totalAmount: number;
  business: string | null;
  dueDate: string | null;
  invoiceNumber: string;
}

function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <div style="background:#0f172a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:18px">InvoiceIQ</div>
    <div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none">
      <h2 style="margin:0 0 12px;font-size:18px">${title}</h2>
      ${body}
    </div>
    <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px">InvoiceIQ — AP automation. This is an automated message.</p>
  </div></body></html>`;
}

function detailsTable(d: InvoiceEmailData): string {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">${v}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px">
    ${row("Vendor", d.vendor)}
    ${row("Invoice #", d.invoiceNumber)}
    ${row("Amount", money(d.totalAmount))}
    ${row("Entity", d.business || "—")}
    ${row("Due Date", d.dueDate || "—")}
  </table>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px">${label}</a>`;
}

async function send(to: string, subject: string, html: string) {
  return getClient().emails.send({
    from: fromAddress(),
    to,
    subject,
    html,
  });
}

/** Approval request sent to the assigned exec on processing complete. */
export async function sendApprovalEmail(to: string, d: InvoiceEmailData) {
  const link = `${appUrl()}/approvals/${d.invoiceId}`;
  const html = shell(
    "An invoice needs your approval",
    `<p style="font-size:14px;line-height:1.5">A new invoice has been routed to you for approval.</p>
     ${detailsTable(d)}
     ${button(link, "Review & Approve")}`,
  );
  return send(to, `Approval needed: ${d.vendor} — ${money(d.totalAmount)}`, html);
}

/** Reminder sent to an exec with an invoice still pending. */
export async function sendReminderEmail(
  to: string,
  d: InvoiceEmailData,
  hoursPending: number,
) {
  const link = `${appUrl()}/approvals/${d.invoiceId}`;
  const html = shell(
    "Reminder: invoice awaiting your approval",
    `<p style="font-size:14px;line-height:1.5">This invoice has been waiting <strong>${Math.round(hoursPending)} hours</strong> for your approval.</p>
     ${detailsTable(d)}
     ${button(link, "Approve now")}`,
  );
  return send(
    to,
    `Reminder: ${d.vendor} invoice awaiting approval`,
    html,
  );
}

/** Rejection notice sent to the accountant when an exec rejects. */
export async function sendRejectionEmail(
  to: string,
  d: InvoiceEmailData,
  rejectedBy: string,
  note: string,
) {
  const link = `${appUrl()}/invoices/${d.invoiceId}`;
  const html = shell(
    "An invoice was rejected",
    `<p style="font-size:14px;line-height:1.5"><strong>${rejectedBy}</strong> rejected this invoice with the note:</p>
     <blockquote style="margin:8px 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:14px">${note}</blockquote>
     ${detailsTable(d)}
     ${button(link, "View invoice")}`,
  );
  return send(to, `Rejected: ${d.vendor} — ${money(d.totalAmount)}`, html);
}
