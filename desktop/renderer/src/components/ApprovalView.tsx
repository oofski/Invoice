import { useState } from "react";
import { Check, X, ChevronLeft, Calendar, Building2, Inbox } from "lucide-react";
import { PdfPane } from "@/components/PdfPane";
import { LineItemsTable } from "@/components/LineItemsTable";
import { Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { useProfile } from "@/components/ProfileProvider";
import { formatCurrency, formatDate, ageLabel, cn, sameName } from "@/lib/utils";
import { INVOICE_STATUS, ROLES } from "@/lib/constants";
import type { InvoiceRow, InvoiceWithRelations } from "@/lib/types";

interface DetailResponse {
  invoice: InvoiceWithRelations;
}

export function ApprovalView({ initialId }: { initialId?: string }) {
  const profile = useProfile();
  const { data, loading, refetch } = useApi<{ invoices: InvoiceRow[] }>(
    `/api/invoices?status=${INVOICE_STATUS.PENDING_APPROVAL}&limit=500`,
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId);

  const invoices = data?.invoices ?? [];

  return (
    <div className="flex h-screen flex-col lg:flex-row">
      {/* List sidebar */}
      <aside
        className={cn(
          "w-full shrink-0 border-r border-slate-200 bg-white lg:w-80",
          selectedId ? "hidden lg:block" : "block",
        )}
      >
        <div className="border-b border-slate-200 px-4 py-4">
          <h1 className="text-lg font-bold text-slate-900">Approvals</h1>
          <p className="text-sm text-slate-500">
            {invoices.length} awaiting your decision
          </p>
        </div>
        <div className="scroll-thin h-[calc(100vh-73px)] overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-10">
              <Spinner />
            </div>
          ) : invoices.length === 0 ? (
            <EmptyState
              title="All caught up"
              description="No invoices awaiting approval."
              icon={<Inbox className="h-10 w-10" />}
            />
          ) : (
            invoices.map((inv) => (
              <button
                key={inv.id}
                onClick={() => setSelectedId(inv.id)}
                className={cn(
                  "block w-full border-b border-slate-100 px-4 py-3 text-left transition-colors hover:bg-slate-50",
                  selectedId === inv.id && "bg-blue-50",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-900">
                    {inv.vendor}
                  </span>
                  <span className="text-sm font-semibold text-slate-900">
                    {formatCurrency(Number(inv.total_amount))}
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs text-slate-500">
                  <span>{inv.business}</span>
                  <span>{ageLabel(inv.created_at)} old</span>
                </div>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Detail */}
      <div
        className={cn("min-w-0 flex-1", selectedId ? "block" : "hidden lg:block")}
      >
        {selectedId ? (
          <ApprovalDetail
            invoiceId={selectedId}
            canDecide={
              profile.role === ROLES.EXECUTIVE || profile.role === ROLES.ADMIN
            }
            onBack={() => setSelectedId(undefined)}
            onDecided={() => {
              setSelectedId(undefined);
              refetch();
            }}
          />
        ) : (
          <div className="hidden h-full items-center justify-center lg:flex">
            <EmptyState
              title="Select an invoice"
              description="Choose an invoice from the list to review and approve."
              icon={<Inbox className="h-10 w-10" />}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalDetail({
  invoiceId,
  canDecide,
  onBack,
  onDecided,
}: {
  invoiceId: string;
  canDecide: boolean;
  onBack: () => void;
  onDecided: () => void;
}) {
  const profile = useProfile();
  const { data, loading, refetch } = useApi<DetailResponse>(
    `/api/invoices/${invoiceId}`,
  );
  const [rejectOpen, setRejectOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const invoice = data?.invoice;
  const isPending = invoice?.status === INVOICE_STATUS.PENDING_APPROVAL;
  const isAssigned =
    sameName(invoice?.approved_by, profile.name) || profile.role === ROLES.ADMIN;

  async function approve() {
    setBusy(true);
    try {
      await api.post(`/api/invoices/${invoiceId}/approve`);
      toast.success("Invoice approved");
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!note.trim()) {
      toast.error("A rejection note is required");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/invoices/${invoiceId}/reject`, { note });
      toast.success("Invoice rejected");
      setRejectOpen(false);
      setNote("");
      onDecided();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Reject failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading || !invoice) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 lg:hidden"
        >
          <ChevronLeft className="h-4 w-4" /> Back
        </button>
        <span className="ml-auto text-xs text-slate-400">
          #{invoice.invoice_number}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        {/* PDF */}
        <div className="hidden border-r border-slate-200 lg:block">
          <PdfPane invoiceId={invoice.id} hasPdf={invoice.has_pdf ?? true} />
        </div>

        {/* Decision panel */}
        <div className="scroll-thin min-h-0 overflow-y-auto p-6">
          <div className="text-center">
            <p className="text-sm text-slate-500">{invoice.vendor}</p>
            <p className="my-1 text-5xl font-bold text-slate-900">
              {formatCurrency(Number(invoice.total_amount))}
            </p>
            <div className="mt-2 flex items-center justify-center gap-4 text-sm text-slate-500">
              <span className="inline-flex items-center gap-1">
                <Building2 className="h-4 w-4" /> {invoice.business}
                {invoice.class && invoice.class !== "None"
                  ? ` · ${invoice.class}`
                  : ""}
              </span>
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-4 w-4" /> Due{" "}
                {formatDate(invoice.due_date)}
              </span>
            </div>
          </div>

          {/* Decision buttons */}
          {canDecide && isAssigned && isPending ? (
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button
                variant="success"
                size="lg"
                loading={busy}
                onClick={approve}
                className="py-4 text-base"
              >
                <Check className="h-5 w-5" /> Approve
              </Button>
              <Button
                variant="danger"
                size="lg"
                onClick={() => setRejectOpen(true)}
                className="py-4 text-base"
              >
                <X className="h-5 w-5" /> Reject
              </Button>
            </div>
          ) : (
            <div className="mt-6 rounded-lg bg-slate-50 p-3 text-center text-sm text-slate-500">
              {!isPending
                ? `This invoice is ${invoice.status.replace(/_/g, " ").toLowerCase()}.`
                : "View only."}
            </div>
          )}

          {/* Expandable line items for GL override */}
          <div className="mt-6">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">
              Line Items
            </h3>
            <div className="rounded-xl border border-slate-200 bg-white">
              <LineItemsTable
                lineItems={invoice.line_items}
                editable={canDecide && isAssigned && isPending}
                onChange={refetch}
              />
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title="Reject invoice"
      >
        <p className="mb-2 text-sm text-slate-600">
          A note is required when rejecting. The accountant will be notified.
        </p>
        <textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={4}
          placeholder="Reason for rejection…"
          className="w-full rounded-lg border border-slate-300 p-3 text-sm outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRejectOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={reject}
            loading={busy}
            disabled={!note.trim()}
          >
            Confirm rejection
          </Button>
        </div>
      </Modal>
    </div>
  );
}
