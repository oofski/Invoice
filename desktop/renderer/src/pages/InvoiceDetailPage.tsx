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
          className="mb-4 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <Card className="p-8 text-center text-slate-500">
          {error ?? "Invoice not found"}
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <Link
          to="/invoices"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
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
        <div className="min-h-[40vh] border-b border-slate-200 lg:border-b-0 lg:border-r">
          <PdfPane invoiceId={invoice.id} hasPdf={invoice.has_pdf ?? true} />
        </div>

        {/* Right: data + line items + audit */}
        <div className="scroll-thin min-h-0 overflow-y-auto p-5">
          <InvoiceDataPanel invoice={invoice} />

          {reviewCount > 0 && (
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
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
              <h3 className="mb-2 text-sm font-semibold text-slate-700">
                Line Items {canEdit && "· GL Coding"}
              </h3>
              <Card>
                <LineItemsTable
                  lineItems={lineItems}
                  editable={canEdit}
                  onChange={refetch}
                />
              </Card>
            </div>
          )}

          {canSeeAudit && invoice.audit_log && (
            <div className="mt-6">
              <h3 className="mb-2 text-sm font-semibold text-slate-700">
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
