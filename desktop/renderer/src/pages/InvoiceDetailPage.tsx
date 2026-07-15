import { useCallback, useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  RefreshCw,
  ScanLine,
  AlertTriangle,
  Trash2,
  Download,
  Check,
} from "lucide-react";
import { PdfPane } from "@/components/PdfPane";
import { InvoiceDataPanel } from "@/components/InvoiceDataPanel";
import { LineItemsTable } from "@/components/LineItemsTable";
import { AuditTimeline } from "@/components/AuditTimeline";
import { SplitSummary } from "@/components/SplitSummary";
import { Card, Button, Spinner } from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { useInvoiceRefresh } from "@/lib/invoiceRefresh";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { downloadBlob, formatDate } from "@/lib/utils";
import { toast } from "@/components/ui/Toast";
import { INVOICE_STATUS, ROLES } from "@/lib/constants";
import type { InvoiceWithRelations } from "@/lib/types";

interface DetailResponse {
  invoice: InvoiceWithRelations;
}

/** Reprocess/rescan response — preserved/dropped human-work counts (FIX-10). */
interface ProcessResponse {
  preservedOverrides?: number;
  droppedOverrides?: number;
  preservedSplits?: number;
  droppedSplits?: number;
}

/** " — N override(s) preserved[, M dropped]" suffix, or "" when none preserved. */
function overridesSuffix(res: ProcessResponse | null | undefined): string {
  const preserved = res?.preservedOverrides ?? 0;
  if (preserved <= 0) return "";
  let s = ` — ${preserved} override${preserved === 1 ? "" : "s"} preserved`;
  const dropped = res?.droppedOverrides ?? 0;
  if (dropped > 0) s += `, ${dropped} dropped`;
  return s;
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
  const [acceptingReview, setAcceptingReview] = useState(false);

  // v1.9.7 (bug #36): keep this page live under changes made elsewhere (another
  // window/session approving, etc.) — subscribe to the refresh bus + focus + poll.
  const refreshSilent = useCallback(() => refetch({ silent: true }), [refetch]);
  useInvoiceRefresh(refreshSilent, 15000);

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

  // v1.9.4: a one-click "these are fine, proceed" for review-flagged invoices.
  // Admin / accountant / CC-accountant, on a non-exported invoice.
  const isNeedsReview = invoice?.status === INVOICE_STATUS.NEEDS_REVIEW;
  const canAcceptReview =
    !!invoice &&
    invoice.status !== INVOICE_STATUS.EXPORTED &&
    (profile.role === ROLES.ADMIN ||
      profile.role === ROLES.ACCOUNTANT ||
      profile.role === ROLES.CREDIT_CARD_ACCOUNTANT);
  // v1.9.8: "These are fine — proceed" is available on any still-actionable
  // (non-exported) flagged invoice, INCLUDING an already-approved one — accepting
  // the flags post-approval is exactly what makes it cleanly Export Ready. The
  // flags that keep it out of clean Export-Ready are: flagged lines, a
  // location-ambiguity, or a reconciliation gap.
  const notExported = invoice?.status !== INVOICE_STATUS.EXPORTED;
  const hasReconcileGap = invoice?.reconciliation_delta != null;
  // "…only" = no flagged lines and not sent-back — used to word the banner.
  const locationOnlyReview =
    !!invoice?.location_ambiguous && reviewCount === 0 && !isNeedsReview && notExported;
  const reconcileOnlyReview =
    hasReconcileGap &&
    reviewCount === 0 &&
    !isNeedsReview &&
    !invoice?.location_ambiguous &&
    notExported;
  const showReviewBanner =
    !!invoice &&
    notExported &&
    (reviewCount > 0 ||
      isNeedsReview ||
      !!invoice.location_ambiguous ||
      hasReconcileGap);

  // v1.9.7 (bug #4): reprocess/rescan rebuild the AI coding + approval, so they
  // must not be offered on an already-approved or exported invoice (the Worker
  // now 409s too). Reject/reroute exist for changing a decided invoice.
  const canReprocess =
    !!invoice &&
    (profile.role === ROLES.ACCOUNTANT || profile.role === ROLES.ADMIN) &&
    invoice.status !== INVOICE_STATUS.EXPORTED &&
    invoice.status !== INVOICE_STATUS.APPROVED;

  async function acceptReview() {
    setAcceptingReview(true);
    try {
      const res = await api.post<{ cleared: number; advanced: boolean }>(
        `/api/invoices/${id}/accept-review`,
      );
      toast.success(
        res.advanced
          ? "Manual review registered — re-sent for approval"
          : res.cleared > 0
            ? `Manual review registered — ${res.cleared} line${res.cleared === 1 ? "" : "s"} accepted`
            : "Manual review registered",
      );
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to accept review");
    } finally {
      setAcceptingReview(false);
    }
  }

  async function reprocess() {
    setReprocessing(true);
    try {
      const res = await api.post<ProcessResponse>("/api/invoices/process", {
        invoiceId: id,
      });
      toast.success(`Reprocessed with AI${overridesSuffix(res)}`);
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
        "Re-scan re-reads the PDF with the latest extraction and re-codes the invoice. Line items may change; your GL overrides, splits, and manually-added lines are preserved. Continue?",
      )
    )
      return;
    setRescanning(true);
    try {
      const res = await api.post<ProcessResponse>("/api/invoices/process", {
        invoiceId: id,
        rescan: true,
      });
      toast.success(`Re-scanned with the latest extraction${overridesSuffix(res)}`);
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

  // v1.9.7 (bug #24): first-load only. `loading` also toggles on background/
  // silent refetches; blanking the page then unmounts the PDF pane (re-download
  // + lost scroll) on every inline edit. With data present, stay on screen.
  if (loading && !data) {
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
          {canReprocess && (
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
                title="Re-read the PDF with the latest extraction (use if the original scan missed or misread lines). Your GL overrides, splits, and manually-added lines are preserved."
              >
                <ScanLine className="h-4 w-4" />
                Re-scan
              </Button>
            </>
          )}
          {(profile.role === ROLES.ADMIN ||
            profile.role === ROLES.ACCOUNTANT) && (
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

          {/* v1.9.3 (Feature E): if a split was applied during approval, show what
              it was (per-target breakdown) + who approved it and when. */}
          <SplitSummary invoice={invoice} />

          {showReviewBanner && (
            <div className="mt-4 rounded-lg border border-danger-soft-fg/30 bg-danger-soft-bg p-3 text-sm text-danger-soft-fg">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <span>
                    {isNeedsReview ? (
                      <>
                        This invoice was sent back for review.
                        {reviewCount > 0 && (
                          <>
                            {" "}
                            <strong>{reviewCount}</strong> line
                            {reviewCount === 1 ? " is" : "s are"} flagged.
                          </>
                        )}
                      </>
                    ) : locationOnlyReview ? (
                      <>
                        The location for this invoice was decided on shared
                        evidence and needs confirmation. Confirm the routing (or
                        edit it) to clear this flag.
                      </>
                    ) : reconcileOnlyReview ? (
                      <>
                        The line items don&apos;t add up to the invoice total
                        {invoice.reconciliation_delta != null && (
                          <>
                            {" "}
                            (off by{" "}
                            <strong>
                              ${Math.abs(invoice.reconciliation_delta).toFixed(2)}
                            </strong>
                            )
                          </>
                        )}
                        . Confirm it&apos;s correct to clear this flag.
                      </>
                    ) : (
                      <>
                        <strong>{reviewCount}</strong> line item
                        {reviewCount === 1 ? " is" : "s are"} flagged for review.
                        Export will warn until resolved.
                      </>
                    )}
                  </span>
                  {canAcceptReview && (
                    <div className="mt-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={acceptReview}
                        loading={acceptingReview}
                        title="Accept the current coding and move this invoice forward"
                      >
                        <Check className="h-3.5 w-3.5" />
                        These are fine — proceed
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* v1.9.8: the registered manual review check — persists after the
              flags are cleared so there's an accountable record that a human
              accepted this invoice before it was cleared for export. */}
          {invoice.manually_reviewed_at && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-success-soft-fg/30 bg-success-soft-bg p-3 text-sm text-success-soft-fg">
              <Check className="h-4 w-4 shrink-0" />
              <span>
                Manually reviewed
                {invoice.manually_reviewed_by
                  ? ` by ${invoice.manually_reviewed_by}`
                  : ""}{" "}
                · {formatDate(invoice.manually_reviewed_at)}
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
                  canDelete={canAdd}
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
