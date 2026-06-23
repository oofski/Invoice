import { type NextRequest } from "next/server";
import { ok, fail, withErrorHandling } from "@/lib/api";
import { getSessionProfile } from "@/lib/auth";
import { processInvoiceAI } from "@/lib/process";
import { ROLES } from "@/lib/constants";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/invoices/process — Brief §07 (auth: internal).
 *
 * Re-runs the AI pipeline for an existing invoice, reusing the stored Textract
 * output so reprocessing never re-bills Textract (Brief §13). Authenticated as
 * an accountant/admin session OR via the PROCESS_SECRET header for
 * server-to-server invocation.
 *
 * Body: { "invoiceId": "uuid" }
 */
export const POST = withErrorHandling(async (request: NextRequest) => {
  const secret = request.headers.get("x-process-secret");
  const validSecret =
    !!process.env.PROCESS_SECRET && secret === process.env.PROCESS_SECRET;

  let actorId: string | null = null;
  if (!validSecret) {
    const session = await getSessionProfile();
    const role = session?.profile?.role;
    if (!session?.profile || (role !== ROLES.ACCOUNTANT && role !== ROLES.ADMIN)) {
      return fail("Forbidden: internal endpoint", 403);
    }
    actorId = session.profile.id;
  }

  const body = await request.json().catch(() => ({}));
  const invoiceId = body?.invoiceId as string | undefined;
  if (!invoiceId) return fail("invoiceId is required", 400);

  const result = await processInvoiceAI(invoiceId, actorId);
  return ok({ invoiceId, ...result });
});
