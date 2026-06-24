import type { Env } from "./types";

/** Resend transactional email via REST (fetch) — Brief §04/§09. */

interface InvoiceEmailData {
  invoiceId: string;
  vendor: string;
  totalAmount: number;
  business: string | null;
  dueDate: string | null;
  invoiceNumber: string;
}

function money(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function shell(env: Env, title: string, body: string) {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#0f172a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:18px">InvoiceIQ</div><div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}</div></div></body></html>`;
}

function details(d: InvoiceEmailData) {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px">${k}</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">${v}</td></tr>`;
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 16px">${row("Vendor", d.vendor)}${row("Invoice #", d.invoiceNumber)}${row("Amount", money(d.totalAmount))}${row("Entity", d.business || "—")}${row("Due Date", d.dueDate || "—")}</table>`;
}

async function send(env: Env, to: string, subject: string, html: string) {
  if (!env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY not set; skipping email to", to);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "invoices@example.com",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) console.error("[email] resend error:", res.status, await res.text());
}

export function sendApprovalEmail(env: Env, to: string, d: InvoiceEmailData) {
  const html = shell(
    env,
    "An invoice needs your approval",
    `<p style="font-size:14px">A new invoice has been routed to you for approval. Open InvoiceIQ to review and approve.</p>${details(d)}`,
  );
  return send(env, to, `Approval needed: ${d.vendor} — ${money(d.totalAmount)}`, html);
}

export function sendReminderEmail(env: Env, to: string, d: InvoiceEmailData, hours: number) {
  const html = shell(
    env,
    "Reminder: invoice awaiting your approval",
    `<p style="font-size:14px">This invoice has been waiting <strong>${Math.round(hours)} hours</strong> for approval.</p>${details(d)}`,
  );
  return send(env, to, `Reminder: ${d.vendor} invoice awaiting approval`, html);
}

export function sendApproverDigestEmail(
  env: Env,
  to: string,
  approverName: string,
  pendingCount: number,
  note?: string,
) {
  const noteBlock = note
    ? `<blockquote style="margin:8px 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:14px">${note}</blockquote>`
    : "";
  const html = shell(
    env,
    "Invoices awaiting your approval",
    `<p style="font-size:14px">Hi ${approverName}, you have <strong>${pendingCount}</strong> invoice(s) awaiting approval.</p>${noteBlock}<p style="font-size:14px">Open InvoiceIQ to review and approve.</p>`,
  );
  return send(
    env,
    to,
    `Reminder: ${pendingCount} invoice(s) awaiting your approval`,
    html,
  );
}

export function sendRejectionEmail(
  env: Env,
  to: string,
  d: InvoiceEmailData,
  rejectedBy: string,
  note: string,
) {
  const html = shell(
    env,
    "An invoice was rejected",
    `<p style="font-size:14px"><strong>${rejectedBy}</strong> rejected this invoice:</p><blockquote style="margin:8px 0 16px;padding:12px 16px;background:#fef2f2;border-left:3px solid #dc2626;border-radius:4px;font-size:14px">${note}</blockquote>${details(d)}`,
  );
  return send(env, to, `Rejected: ${d.vendor} — ${money(d.totalAmount)}`, html);
}
