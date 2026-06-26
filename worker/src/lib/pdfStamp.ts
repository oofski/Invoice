import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Env, InvoiceRow } from "./types";
import { AUDIT_ACTION } from "./constants";
import { getStampedPdf_R2, putStampedPdf, getPdf } from "./storage";

/**
 * F2 — "APPROVED" stamp burned onto an invoice PDF.
 *
 * The clean original always stays at its R2 key untouched. Stamping happens
 * on-the-fly in the PDF read path ONLY for APPROVED/EXPORTED invoices, and the
 * result is memoized to an R2 sidecar (storage.stampedKey) keyed on the approval
 * state via customMetadata { decidedAt, approver } so a re-approval/reroute (which
 * changes decided_at) self-invalidates the cache.
 *
 * Worker-compat: pdf-lib is pure JS; we use a bundled standard font
 * (HelveticaBold) and drawText only — NO fontkit, NO custom TTF, NO image.
 */

/**
 * Pure draw: load bytes, stamp page 1, return new PDF bytes. No I/O.
 * Throws on a malformed/encrypted-unreadable PDF — callers must try/catch and
 * fall back to the original bytes.
 */
export async function stampApproved(
  bytes: ArrayBuffer,
  opts: { approver: string; decidedDate: string },
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  if (pages.length === 0) {
    // Nothing to stamp — re-serialize as-is.
    return doc.save();
  }
  const page = pages[0];
  const { width, height } = page.getSize();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);

  const approver = opts.approver?.trim() || "—";
  // Show just the date portion when an ISO timestamp is supplied.
  const decided = (opts.decidedDate || "").slice(0, 10) || opts.decidedDate || "";

  const line1 = "APPROVED";
  const line2 = `By: ${approver}`;
  const line3 = decided ? `Date: ${decided}` : "";

  const titleSize = 20;
  const subSize = 10;
  const padX = 12;
  const padY = 10;
  const gap = 4;

  // Box sized to the widest line.
  const w1 = font.widthOfTextAtSize(line1, titleSize);
  const w2 = font.widthOfTextAtSize(line2, subSize);
  const w3 = line3 ? font.widthOfTextAtSize(line3, subSize) : 0;
  const boxW = Math.max(w1, w2, w3) + padX * 2;
  const boxH =
    titleSize + subSize + (line3 ? subSize + gap : 0) + gap + padY * 2;

  // Top-right corner, clamped to the page so it never falls off small pages.
  const margin = 24;
  let boxX = width - margin - boxW;
  let boxY = height - margin - boxH;
  if (boxX < margin) boxX = Math.max(0, (width - boxW) / 2);
  if (boxY < 0) boxY = Math.max(0, height - boxH);

  const green = rgb(0.05, 0.5, 0.15);

  page.drawRectangle({
    x: boxX,
    y: boxY,
    width: boxW,
    height: boxH,
    borderColor: green,
    borderWidth: 2,
    color: rgb(1, 1, 1),
    opacity: 0.85,
    borderOpacity: 1,
  });

  let cursorY = boxY + boxH - padY - titleSize;
  page.drawText(line1, {
    x: boxX + padX,
    y: cursorY,
    size: titleSize,
    font,
    color: green,
  });
  cursorY -= subSize + gap;
  page.drawText(line2, {
    x: boxX + padX,
    y: cursorY,
    size: subSize,
    font,
    color: rgb(0.1, 0.1, 0.1),
  });
  if (line3) {
    cursorY -= subSize + gap;
    page.drawText(line3, {
      x: boxX + padX,
      y: cursorY,
      size: subSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  return doc.save();
}

/**
 * Resolves the decided date for the stamp:
 *   approvals.decided_at -> APPROVED audit row created_at -> inv.created_at.
 * (There is NO invoices.updated_at column.)
 */
async function resolveDecidedDate(env: Env, inv: InvoiceRow): Promise<string> {
  const approval = await env.DB.prepare(
    "SELECT decided_at FROM approvals WHERE invoice_id = ? AND decided_at IS NOT NULL ORDER BY decided_at DESC LIMIT 1",
  )
    .bind(inv.id)
    .first<{ decided_at: string | null }>();
  if (approval?.decided_at) return approval.decided_at;

  const auditRow = await env.DB.prepare(
    "SELECT created_at FROM audit_log WHERE invoice_id = ? AND action = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(inv.id, AUDIT_ACTION.APPROVED)
    .first<{ created_at: string }>();
  if (auditRow?.created_at) return auditRow.created_at;

  return inv.created_at;
}

/**
 * Returns stamped bytes for an APPROVED/EXPORTED invoice, memoized to the R2
 * sidecar. Serves the sidecar when its customMetadata matches the current
 * {decidedAt, approver}; else stamps, writes the sidecar, and returns the bytes.
 *
 * NEVER throws to the caller: on any pdf-lib failure it falls back to the
 * ORIGINAL bytes so the PDF viewer never 500s.
 */
export async function getStampedPdf(
  env: Env,
  inv: InvoiceRow,
  originalKey: string,
): Promise<ArrayBuffer> {
  const approver = inv.approved_by ?? "";
  const decidedDate = await resolveDecidedDate(env, inv);

  // Serve a fresh sidecar if present and still matching the approval state.
  try {
    const cached = await getStampedPdf_R2(env, originalKey);
    if (cached) {
      const meta = cached.customMetadata ?? {};
      if (meta.decidedAt === decidedDate && meta.approver === approver) {
        return await cached.arrayBuffer();
      }
    }
  } catch (e) {
    console.error("[pdfStamp] sidecar read failed:", e);
  }

  // Load the clean original.
  const obj = await getPdf(env, originalKey);
  if (!obj) throw new Error("original PDF object missing");
  const original = await obj.arrayBuffer();

  // Stamp, memoize, return. On any failure, fall back to the original bytes.
  try {
    const stamped = await stampApproved(original, { approver, decidedDate });
    try {
      await putStampedPdf(env, originalKey, stamped, {
        decidedAt: decidedDate,
        approver,
      });
    } catch (e) {
      console.error("[pdfStamp] sidecar write failed:", e);
    }
    // Return a standalone ArrayBuffer copy (avoids SharedArrayBuffer typing).
    return stamped.slice().buffer;
  } catch (e) {
    console.error("[pdfStamp] stamp failed, serving original:", e);
    return original;
  }
}
