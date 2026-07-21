import { PDFDocument } from "pdf-lib";

/**
 * v1.9.9 — attachment normalization.
 *
 * The whole app treats "an invoice attachment" as a PDF: the viewer is a PDF
 * viewer, the "APPROVED" stamp runs pdf-lib on page 1, and the bulk-zip names
 * every entry `.pdf`. But the SharePoint/email ingest accepts WHATEVER bytes are
 * posted (a scanned JPEG/PNG, an HTML email body, a Word doc) and used to store
 * them verbatim under an `application/pdf` label with no validation — so a
 * non-PDF would later download as a `.pdf` full of unreadable/"text" bytes.
 *
 * This module sniffs the real type by magic bytes and normalizes it:
 *   - a real PDF  -> stored as-is (application/pdf)
 *   - a JPEG/PNG  -> wrapped into a real one-page PDF (stays uniform: viewer,
 *                    stamp, and zip all keep working)
 *   - anything we can't turn into a PDF (GIF/WEBP/TIFF/HEIC/HTML/…) -> stored
 *     with its TRUE mime + extension so it's at least labeled honestly and the
 *     export can name it correctly instead of forging a broken `.pdf`.
 */

export type SniffedType =
  | "pdf"
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "tiff"
  | "heic"
  | "html"
  | "unknown";

const MIME: Record<SniffedType, string> = {
  pdf: "application/pdf",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  tiff: "image/tiff",
  heic: "image/heic",
  html: "text/html",
  unknown: "application/octet-stream",
};

const EXT: Record<SniffedType, string> = {
  pdf: "pdf",
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
  tiff: "tiff",
  heic: "heic",
  html: "html",
  unknown: "bin",
};

export function mimeFor(t: SniffedType): string {
  return MIME[t];
}
export function extFor(t: SniffedType): string {
  return EXT[t];
}

/**
 * Identifies a byte payload by its leading magic bytes. Only the first ~16 bytes
 * are needed, so callers may pass a short prefix (e.g. an R2 range read).
 */
export function sniffBytes(head: Uint8Array): SniffedType {
  const b = head;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46)
    return "pdf"; // %PDF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return "png";
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif"; // GIF
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // WEBP
  )
    return "webp";
  if (
    b.length >= 4 &&
    ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || // II*\0 (LE)
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) // MM\0* (BE)
  )
    return "tiff";
  if (
    b.length >= 12 &&
    b[4] === 0x66 &&
    b[5] === 0x74 &&
    b[6] === 0x79 &&
    b[7] === 0x70 // 'ftyp' box
  ) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
    if (brand.startsWith("hei") || brand.startsWith("mif") || brand.startsWith("hev"))
      return "heic";
  }
  // Text-ish: an HTML/email body starts with '<' (optionally after a BOM/whitespace).
  let i = 0;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3; // UTF-8 BOM
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d))
    i++;
  if (i < b.length && b[i] === 0x3c) return "html"; // '<'
  return "unknown";
}

export interface NormalizedAttachment {
  /** Bytes to persist to R2. */
  bytes: Uint8Array;
  /** True mime to store in pdf_files.mime + R2 httpMetadata. */
  mime: string;
  /** Correct extension for a human-facing file name. */
  ext: string;
  /** True when the stored bytes are a real, viewable PDF (original or converted). */
  isPdf: boolean;
  /** True when we wrapped an image into a PDF. */
  converted: boolean;
  /** What the incoming bytes actually were. */
  sourceType: SniffedType;
}

/** Letter portrait, in PDF points. */
const PAGE_W = 612;
const PAGE_H = 792;
const PAGE_MARGIN = 18;

/** Embeds a JPEG/PNG onto a Letter page, scaled to fit (aspect preserved). */
async function imageToPdf(buf: ArrayBuffer, kind: "jpeg" | "png"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const img = kind === "jpeg" ? await doc.embedJpg(buf) : await doc.embedPng(buf);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const maxW = PAGE_W - PAGE_MARGIN * 2;
  const maxH = PAGE_H - PAGE_MARGIN * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, {
    x: (PAGE_W - w) / 2,
    y: (PAGE_H - h) / 2,
    width: w,
    height: h,
  });
  return doc.save();
}

/**
 * Sniffs `buf` and returns the storable form. Never throws: if image→PDF
 * conversion fails, it falls back to storing the raw image under its true mime.
 */
export async function normalizeToStorable(
  buf: ArrayBuffer,
): Promise<NormalizedAttachment> {
  const head = new Uint8Array(buf.slice(0, 16));
  const t = sniffBytes(head);

  if (t === "pdf") {
    return {
      bytes: new Uint8Array(buf),
      mime: MIME.pdf,
      ext: EXT.pdf,
      isPdf: true,
      converted: false,
      sourceType: t,
    };
  }

  if (t === "jpeg" || t === "png") {
    try {
      const pdfBytes = await imageToPdf(buf, t);
      return {
        bytes: pdfBytes,
        mime: MIME.pdf,
        ext: EXT.pdf,
        isPdf: true,
        converted: true,
        sourceType: t,
      };
    } catch {
      // Fall through: store the raw image honestly labeled.
    }
  }

  return {
    bytes: new Uint8Array(buf),
    mime: MIME[t],
    ext: EXT[t],
    isPdf: false,
    converted: false,
    sourceType: t,
  };
}

/** Replaces (or appends) a file name's extension. */
export function withExt(fileName: string, ext: string): string {
  const base = fileName.replace(/\.[^./\\]+$/, "");
  return `${base}.${ext}`;
}
