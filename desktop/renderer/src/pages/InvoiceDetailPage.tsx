import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  ScanLine,
  AlertTriangle,
  Trash2,
  Download,
} from "lucide-react";
import { PdfPane } from "@/components/PdfPane";
import { InvoiceDataPanel } from "@/components/InvoiceDataPanel";
import { LineItemsTable } from "@/components/LineItemsTable";
import { AuditTimeline } from "@/components/AuditTimeline";
import { Card, Button, Spinner } from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { downloadBlob } from "@/lib/utils";
import { toast } from "@/components/ui/Toast";
import { INVOICE_STATUS, ROLES } from "@/lib/constants";
import type { InvoiceWithRelations } from "@/lib/types";

interface DetailResponse {
  invoice: InvoiceWithRelations;
}

export default function InvoiceDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const profile = useProfile();
  const { data, loading, error, refetch } = useApi<DetailResponse>(
    `/api/invoices/${id}`,
  );
  const [reprocessing, setReprocessing] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);

  const invoice = data?.invoice;
  const lineItems = useMemo(() => invoice?.line_items ?? [], [invoice]);

  const reviewCount = useMemo(
    () => lineItems.filter((li) => li.requires_review).length,
    [lineItems],
  );

  // GL coding is for accountant/admin/staff only. Executives are NEVER shown
  // or allowed to edit the 47-category GL view (GL is hidden server-side too).
  const canSeeGl =
    profile.role === ROLES.ACCOUNTANT ||
    profile.role === ROLES.ADMIN ||
    profile.role === ROLES.STAFF;

  const canEdit =
    !!invoice && invoice.status !== INVOICE_STATUS.EXPORTED && canSeeGl;

  const canSeeAudit =
    profile.role === ROLES.ACCOUNTANT || profile.role === ROLES.ADMIN;

  // Re-routing (Feature A) is an accountant/admin action and is blocked once an
  // invoice has been exported (the Worker returns 409 in that case).
  const canEditRouting =
    !!invoice &&
    (profile.role === ROLES.ACCOUNTANT || profile.role === ROLES.ADMIN) &&
    invoice.status !== INVOICE_STATUS.EXPORTED;

  // Adding a missing line item is an accountant/admin action and is blocked
  // once exported (the Worker returns 409). Executives never manage GL.
  const canAdd =
    !!invoice &&
    (profile.role === ROLES.ACCOUNTANT || profile.role === ROLES.ADMIN) &&
    invoice.status !== INVOICE_STATUS.EXPORTED;

  async function reprocess() {
    setReprocessing(true);
    try {
      await api.post("/api/invoices/process", { invoiceId: id });
      toast.success("Reprocessed with AI");
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Reprocess failed");
    } finally {
      setReprocessing(false);
    }
  }

  // Re-scan (v1.2.1): re-reads the PDF with the latest OCR settings (not just the
  // cached text), then re-codes. Use when the original scan misread or missed
  // lines; manually-added lines are preserved. Re-reads the document, so confirm.
  async function rescan() {
    if (
      !window.confirm(
        "Re-scan re-reads the PDF with the latest extraction and re-codes the invoice. Line items may change; manually-added lines are kept. Continue?",
      )
    )
      return;
    setRescanning(true);
    try {
      await api.post("/api/invoices/process", { invoiceId: id, rescan: true });
      toast.success("Re-scanned with the latest extraction");
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Re-scan failed");
    } finally {
      setRescanning(false);
    }
  }

  // F4: download the current PDF. Hits the same /pdf endpoint the viewer uses,
  // so an APPROVED/EXPORTED invoice's file arrives with the on-the-fly stamp.
  async function downloadPdf() {
    if (!invoice) return;
    setDownloadingPdf(true);
    try {
      const blob = await api.getBlob(`/api/invoices/${invoice.id}/pdf`);
      downloadBlob(blob, `${invoice.vendor}_${invoice.invoice_number}.pdf`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Download failed");
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function deleteInvoice() {
    if (
      !window.confirm(
        "Delete this invoice permanently? This removes its PDF, line items, and approval. This cannot be undone.",
      )
    )
      return;
    setDeleting(true);
    try {
      await api.del(`/api/invoices/${id}`);
      toast.success("Invoice deleted");
      navigate("/invoices", { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !invoice) {
    return (
      <div className="p-6">
        <Link
          to="/invoices"
          className="mb-4 inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <Card className="p-8 text-center text-ink-muted">
          {error ?? "Invoice not found"}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-line bg-surface px-6 py-3">
        <Link
          to="/invoices"
          className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-4 w-4" /> Invoices
        </Link>
        <div className="flex items-center gap-2">
          {invoice.has_pdf && (
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadPdf}
              loading={downloadingPdf}
            >
              <Download className="h-4 w-4" />
              Download PDF
            </Button>
          )}
          {(profile.role === ROLES.ACCOUNTANT ||
            profile.role === ROLES.ADMIN) && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={reprocess}
                loading={reprocessing}
                disabled={rescanning}
              >
                <RefreshCw className="h-4 w-4" />
                Reprocess
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={rescan}
                loading={rescanning}
                disabled={reprocessing}
                title="Re-read the PDF with the latest extraction (use if the original scan missed or misread lines)"
              >
                <ScanLine className="h-4 w-4" />
                Re-scan
              </Button>
            </>
          )}
          {profile.role === ROLES.ADMIN && (
            <Button
              variant="danger"
              size="sm"
              onClick={deleteInvoice}
              loading={deleting}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        {/* Left: PDF */}
        <div className="min-h-[40vh] border-b border-line lg:border-b-0 lg:border-r">
          <PdfPane invoiceId={invoice.id} hasPdf={invoice.has_pdf ?? true} />
        </div>

        {/* Right: data + line items + audit */}
        <div className="scroll-thin min-h-0 overflow-y-auto p-5">
          <InvoiceDataPanel
            invoice={invoice}
            canEditRouting={canEditRouting}
            onRerouted={refetch}
          />

          {reviewCount > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-danger-soft-fg/30 bg-danger-soft-bg p-3 text-sm text-danger-soft-fg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                <strong>{reviewCount}</strong> line item
                {reviewCount === 1 ? "" : "s"} require manual review. Export is
                blocked until resolved.
              </span>
            </div>
          )}

          {canSeeGl && (
            <div className="mt-6">
              <h3 className="mb-2 font-display text-sm font-semibold text-ink">
                Line Items {canEdit && "· GL Coding"}
              </h3>
              <Card>
                <LineItemsTable
                  lineItems={lineItems}
                  editable={canEdit}
                  onChange={refetch}
                  invoiceBusiness={invoice.business}
                  canAdd={canAdd}
                  invoiceId={invoice.id}
                />
              </Card>
            </div>
          )}

          {canSeeAudit && invoice.audit_log && (
            <div className="mt-6">
              <h3 className="mb-2 font-display text-sm font-semibold text-ink">
                Audit Trail
              </h3>
              <Card>
                <AuditTimeline entries={invoice.audit_log} />
              </Card>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
