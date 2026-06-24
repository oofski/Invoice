import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, RefreshCw, AlertTriangle, Trash2 } from "lucide-react";
import { PdfPane } from "@/components/PdfPane";
import { InvoiceDataPanel } from "@/components/InvoiceDataPanel";
import { LineItemsTable } from "@/components/LineItemsTable";
import { AuditTimeline } from "@/components/AuditTimeline";
import { Card, Button, Spinner } from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils";
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
  const [deleting, setDeleting] = useState(false);

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

  // Reconciliation advisory (Feature L): Σ(non-split-parent line amounts) + tax
  // should equal the invoice total. Split-parent lines are excluded because
  // their split children carry the amounts (matches LineItemsTable / the exec
  // table, which key off `split_parent_id`). A parent (a line that has at least
  // one child pointing at it via split_parent_id) is therefore dropped; its
  // children — which themselves have a non-null split_parent_id — are also
  // dropped, so we sum only the canonical leaf/root lines: those that are NOT a
  // split child AND are NOT a split parent.
  const { lineSum, reconciled, hasLines } = useMemo(() => {
    const parentIds = new Set(
      lineItems.map((li) => li.split_parent_id).filter(Boolean) as string[],
    );
    const canonical = lineItems.filter(
      (li) => !li.split_parent_id && !parentIds.has(li.id),
    );
    const sum = canonical.reduce((acc, li) => acc + Number(li.amount ?? 0), 0);
    const total = Number(invoice?.total_amount ?? 0);
    const tax = Number(invoice?.sales_tax ?? 0);
    return {
      lineSum: sum,
      hasLines: canonical.length > 0,
      reconciled: Math.abs(sum + tax - total) <= 0.01,
    };
  }, [lineItems, invoice]);

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
          {(profile.role === ROLES.ACCOUNTANT ||
            profile.role === ROLES.ADMIN) && (
            <Button
              variant="secondary"
              size="sm"
              onClick={reprocess}
              loading={reprocessing}
            >
              <RefreshCw className="h-4 w-4" />
              Reprocess
            </Button>
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

          {/* Reconciliation advisory — accountant/admin only (canAdd). Advisory
              only; it complements the server's reconciliation flag and never
              blocks anything. */}
          {canAdd && hasLines && !reconciled && (
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-warning-soft-fg/30 bg-warning-soft-bg p-3 text-sm text-warning-soft-fg">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>
                Line items + tax (≈ {formatCurrency(lineSum + Number(invoice.sales_tax ?? 0))})
                don&apos;t match the invoice total (
                {formatCurrency(Number(invoice.total_amount ?? 0))}). A line may
                be missing or mis-read — add it below.
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
