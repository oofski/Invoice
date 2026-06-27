/**
 * CCRMS transactional email (NEW). MIRRORS `lib/email.ts`: a module-private
 * `send()` that POSTs to Resend and NEVER throws (returns `EmailResult`,
 * `not_configured` when no API key), plus the `shell()` HTML wrapper. The CTA is
 * always in-app navigation (a `#/credit-cards/...` deep route), NEVER a magic
 * link. `lib/email.ts` itself is never edited.
 */
import type { Env } from "../lib/types";
import type { Tx } from "./ccTypes";

/**
 * Outcome of a CC email send attempt. Same shape as `lib/email.ts`'s
 * `EmailResult` so callers can report honestly. `send()` never throws.
 */
export type EmailResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "send_failed"; detail?: string };

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** HTML shell wrapper (mirrors `email.ts` `shell()`). */
function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#0f172a;color:#fff;padding:16px 20px;border-radius:12px 12px 0 0;font-weight:700;font-size:18px">InvoiceIQ</div><div style="background:#fff;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}</div></div></body></html>`;
}

/**
 * Sends one transactional email via Resend. NEVER throws (mirrors `email.ts`):
 *   - no API key  -> { ok:false, reason:"not_configured" } (warn-logs)
 *   - non-2xx     -> { ok:false, reason:"send_failed", detail:<status> }
 *   - fetch throws-> { ok:false, reason:"send_failed", detail:<message> }
 *   - else        -> { ok:true }
 */
async function send(env: Env, to: string, subject: string, html: string): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) {
    console.warn("[cc-email] RESEND_API_KEY not set; skipping email to", to);
    return { ok: false, reason: "not_configured" };
  }
  try {
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
    if (!res.ok) {
      console.error("[cc-email] resend error:", res.status, await res.text());
      return { ok: false, reason: "send_failed", detail: String(res.status) };
    }
    return { ok: true };
  } catch (err) {
    console.error("[cc-email] resend fetch threw:", err);
    return { ok: false, reason: "send_failed", detail: String(err) };
  }
}

/** Renders the subject + HTML body for a cardholder reminder (no send). */
export function renderCcReminder(p: CcReminderParams): { subject: string; html: string } {
  const total = p.capOneTx.length + p.amexTx.length;
  const subject = `[Action Required] Receipt Submission Needed — ${total} Transaction${total === 1 ? "" : "s"}`;

  const li = (tx: Tx, tail: string) =>
    `<li style="margin:4px 0;font-size:14px">${esc(tx.transaction_date)} — ${esc(tx.vendor)} — ${money(tx.amount)}${tx.category ? ` (${esc(tx.category)})` : ""} ${tail}</li>`;

  const sections: string[] = [];
  if (p.capOneTx.length) {
    sections.push(
      `<h3 style="margin:16px 0 6px;font-size:15px">Capital One Transactions</h3><ul style="margin:0 0 8px;padding-left:18px">${p.capOneTx
        .map((tx) =>
          li(
            tx,
            `&rarr; Submit via the Capital One mobile app: find this transaction and tap "Add Receipt."`,
          ),
        )
        .join("")}</ul>`,
    );
  }
  if (p.amexTx.length) {
    sections.push(
      `<h3 style="margin:16px 0 6px;font-size:15px">Amex Transactions</h3><ul style="margin:0 0 8px;padding-left:18px">${p.amexTx
        .map((tx) =>
          li(
            tx,
            `&rarr; Download your invoice as a PDF and upload it in InvoiceIQ: Open InvoiceIQ &rarr; Credit Cards &rarr; My Receipts`,
          ),
        )
        .join("")}</ul>`,
    );
  }

  const navHint = p.appNavHint || "#/credit-cards/my-receipts";
  const html = shell(
    "Receipts Needed",
    `<p style="font-size:14px">Hi ${esc(p.firstName)}, We need receipts for the following credit card transactions. Please submit them to keep our billing cycle on track.</p>${sections.join("")}<p style="font-size:13px;color:#6b7280;margin-top:8px">In the app: <strong>${esc(navHint)}</strong></p><p style="font-size:14px;margin-top:16px">If you have questions, contact Hunter at ${esc(p.managerEmail)}. Thank you, Finance Team.</p>`,
  );
  return { subject, html };
}

/** Parameters for the cardholder receipt reminder (§7.1). */
export interface CcReminderParams {
  firstName: string;
  capOneTx: Tx[];
  amexTx: Tx[];
  managerEmail: string;
  /** In-app deep route shown as the CTA hint; defaults to the My-Receipts route. */
  appNavHint?: string;
}

/**
 * Sends a receipt reminder to a cardholder (§7.1). Sections omit when empty; the
 * CTA is in-app navigation. The caller is responsible for logging the
 * `cc_notifications` row and supplying the recipient `to`.
 */
export function sendCcReminder(env: Env, to: string, p: CcReminderParams): Promise<EmailResult> {
  const { subject, html } = renderCcReminder(p);
  return send(env, to, subject, html);
}

/** Parameters for the manager "receipt ready for review" alert (§7.2). */
export interface CcManagerAlertParams {
  cardholderName: string;
  vendor: string;
  amount: number;
  date: string;
  splitSummary: string;
  txId: string;
  managerEmail: string;
}

/** Renders the subject + HTML body for a manager alert (no send). */
export function renderCcManagerAlert(p: CcManagerAlertParams): { subject: string; html: string } {
  const subject = `Receipt Ready for Review — ${p.cardholderName} | ${p.vendor} ${money(p.amount)}`;
  const html = shell(
    "Receipt Ready for Review",
    `<p style="font-size:14px"><strong>${esc(p.cardholderName)}</strong> has uploaded a receipt for:</p><table style="width:100%;border-collapse:collapse;margin:8px 0 16px"><tr><td style="padding:6px 0;color:#6b7280;font-size:13px">Transaction</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">${esc(p.vendor)} — ${money(p.amount)} on ${esc(p.date)}</td></tr><tr><td style="padding:6px 0;color:#6b7280;font-size:13px">Entity Split</td><td style="padding:6px 0;text-align:right;font-weight:600;font-size:13px">${esc(p.splitSummary)}</td></tr></table><p style="font-size:14px">Review and check off here: Open InvoiceIQ &rarr; Credit Cards &rarr; Transactions</p><p style="font-size:13px;color:#6b7280">In the app: <strong>#/credit-cards/transactions/${esc(p.txId)}</strong></p>`,
  );
  return { subject, html };
}

/**
 * Sends the manager alert that a receipt was uploaded (§7.2). Fired server-side
 * on an executive Amex receipt upload. Sent to `p.managerEmail`. Never throws.
 */
export function sendCcManagerAlert(env: Env, p: CcManagerAlertParams): Promise<EmailResult> {
  const { subject, html } = renderCcManagerAlert(p);
  return send(env, p.managerEmail, subject, html);
}
