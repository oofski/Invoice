import { createAdminClient } from "@/lib/supabase/admin";

export const PDF_BUCKET = "invoices";
export const EXPORT_BUCKET = "exports";

/** Uploads a PDF buffer to the private bucket and returns its storage path. */
export async function uploadPdf(
  buffer: Buffer,
  fileName: string,
): Promise<string> {
  const admin = createAdminClient();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${new Date().getFullYear()}/${crypto.randomUUID()}-${safe}`;
  const { error } = await admin.storage
    .from(PDF_BUCKET)
    .upload(path, buffer, {
      contentType: "application/pdf",
      upsert: false,
    });
  if (error) throw new Error(`PDF upload failed: ${error.message}`);
  return path;
}

/** Generates a short-lived signed URL for viewing a stored PDF. */
export async function signedPdfUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string | null> {
  if (!path) return null;
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(PDF_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error) {
    console.error("[storage] signed URL error:", error.message);
    return null;
  }
  return data?.signedUrl ?? null;
}

/** Downloads a stored PDF as a Buffer (used by the processing pipeline). */
export async function downloadPdf(path: string): Promise<Buffer> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(PDF_BUCKET).download(path);
  if (error || !data)
    throw new Error(`PDF download failed: ${error?.message ?? "no data"}`);
  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/** Stores a generated export file (e.g. QBO Bills CSV) and returns its path. */
export async function uploadExport(
  content: string,
  fileName: string,
): Promise<string> {
  const admin = createAdminClient();
  const path = `${new Date().getFullYear()}/${fileName}`;
  const { error } = await admin.storage
    .from(EXPORT_BUCKET)
    .upload(path, Buffer.from(content, "utf-8"), {
      contentType: "text/csv",
      upsert: true,
    });
  if (error) throw new Error(`Export upload failed: ${error.message}`);
  return path;
}

/** Downloads a stored export file as a string (used for re-download). */
export async function downloadExport(path: string): Promise<string> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage
    .from(EXPORT_BUCKET)
    .download(path);
  if (error || !data)
    throw new Error(`Export download failed: ${error?.message ?? "no data"}`);
  return await data.text();
}
