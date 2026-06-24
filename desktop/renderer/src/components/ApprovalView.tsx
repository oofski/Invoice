import { useEffect, useState } from "react";
import {
  Check,
  X,
  ChevronLeft,
  Calendar,
  Building2,
  Inbox,
  RefreshCw,
  Split,
  ChevronDown,
  ChevronUp,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { PdfPane } from "@/components/PdfPane";
import { LineItemsTable } from "@/components/LineItemsTable";
import { SplitInvoiceModal } from "@/components/SplitInvoiceModal";
import { Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { useProfile } from "@/components/ProfileProvider";
import { formatCurrency, formatDate, ageLabel, cn, sameName } from "@/lib/utils";
import { INVOICE_STATUS, ROLES, BUSINESS_CLASSES } from "@/lib/constants";
import type { InvoiceRow, InvoiceWithRelations } from "@/lib/types";

interface DetailResponse {
  invoice: InvoiceWithRelations;
}

export function ApprovalView({ initialId }: { initialId?: string }) {
  const profile = useProfile();
  const { data, loading, error, refetch } = useApi<{ invoices: InvoiceRow[] }>(
    `/api/invoices?status=${INVOICE_STATUS.PENDING_APPROVAL}&limit=500`,
  );
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const invoices = data?.invoices ?? [];

  useEffect(() => {
    const id = setInterval(() => refetch(), 15000);
    return () => clearInterval(id);
  }, [refetch]);

  return (
    <div className="flex h-screen flex-col lg:flex-row">
      {/* List sidebar — collapsible on desktop */}
      <aside
        className={cn(
          "shrink-0 border-r border-slate-200 bg-white transition-all duration-200",
          selectedId ? "hidden lg:block" : "block",
          sidebarCollapsed ? "lg:w-10" : "w-full lg:w-80",
        )}
      >
        {sidebarCollapsed ? (
          /* Collapsed strip — just an expand button */
          <div className="flex flex-col items-center py-3">
            <button
              onClick={() => setSidebarCollapsed(false)}
              title="Expand inbox"
              className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <PanelLeftOpen className="h-5 w-5" />
            </button>
          </div>
        ) : (
          <>
            <div className="border-b border-slate-200 px-4 py-4">
              <div className="flex items-center justify-between">
                <h1 className="text-lg font-bold text-slate-900">
                  Pending Approvals
                </h1>
                <div className="flex items-center gap-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => refetch()}
                    disabled={loading}
                  >
                    <RefreshCw
                      className={cn("h-4 w-4", loading && "animate-spin")}
                    />
                    Refresh
                  </Button>
                  <button
                    onClick={() => setSidebarCollapsed(true)}
                    title="Collapse inbox"
                    className="hidden rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:block"
                  >
                    <PanelLeftClose className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="text-sm text-slate-500">
                {invoices.length} awaiting your decision
              </p>
            </div>
            <div className="scroll-thin h-[calc(100vh-81px)] overflow-y-auto">
              {error ? (
                <div className="px-4 py-4 text-sm text-red-600">
                  Couldn&apos;t load approvals: {error}. Check the server
                  connection and try Refresh.
                </div>
              ) : loading ? (
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
          </>
        )}
      </aside>

      {/* Detail */}
      <div
        className={cn(
          "min-w-0 flex-1",
          selectedId ? "block" : "hidden lg:block",
        )}
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
  const [splitOpen, setSplitOpen] = useState(false);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [showDetail, setShowDetail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  const invoice = data?.invoice;
  const isPending = invoice?.status === INVOICE_STATUS.PENDING_APPROVAL;
  const isAssigned =
    sameName(invoice?.approved_by, profile.name) || profile.role === ROLES.ADMIN;
  const isExec = profile.role === ROLES.EXECUTIVE;
  const classes = invoice?.business
    ? (BUSINESS_CLASSES[invoice.business] ?? [])
    : [];
  const canSplit = classes.length >= 2;

  async function approve() {
    setBusy(true);
    try {
      await api.post(`/api/invoices/${invoiceId}/approve`, {
        comment: comment.trim() || undefined,
      });
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
      {/* Top bar */}
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
        {/* Desktop-only: toggle the decision panel */}
        <button
          onClick={() => setPanelCollapsed((v) => !v)}
          title={panelCollapsed ? "Show decision panel" : "Collapse decision panel"}
          className="hidden rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 lg:block"
        >
          {panelCollapsed ? (
            <PanelRightOpen className="h-4 w-4" />
          ) : (
            <PanelRightClose className="h-4 w-4" />
          )}
        </button>
      </div>

      {/* Main body — flex row so the PDF column gets a proper constrained height
          (grid auto-rows didn't constrain the child height for overflow-auto). */}
      <div className="flex min-h-0 flex-1">
        {/* PDF — flex-1 fills remaining width; lg:flex so it shows on desktop */}
        <div className="hidden min-h-0 flex-col border-r border-slate-200 lg:flex lg:flex-1">
          <PdfPane invoiceId={invoice.id} hasPdf={invoice.has_pdf ?? true} />
        </div>

        {/* Decision panel — fixed width on desktop, full-width on mobile */}
        <div
          className={cn(
            "scroll-thin min-h-0 overflow-y-auto p-6",
            panelCollapsed
              ? "hidden lg:hidden"
              : "w-full lg:w-[380px] lg:shrink-0",
          )}
        >
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
            {invoice.split_type && (
              <div className="mt-3 flex justify-center">
                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
                  <Split className="h-3 w-3" />
                  {invoice.split_type === "QUICK_EVEN"
                    ? "Split: even"
                    : invoice.split_type === "PER_LINE"
                      ? "Split: per line"
                      : "Split"}
                </span>
              </div>
            )}
          </div>

          {/* Decision buttons */}
          {canDecide && isAssigned && isPending ? (
            <div className="mt-6 space-y-3">
              <div className="grid grid-cols-3 gap-3">
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
                  variant="secondary"
                  size="lg"
                  onClick={() => setSplitOpen(true)}
                  disabled={!canSplit}
                  title={
                    canSplit
                      ? undefined
                      : "This business has a single class — nothing to split."
                  }
                  className="py-4 text-base"
                >
                  <Split className="h-5 w-5" /> Split
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
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                placeholder="Optional comment (added to the approval)…"
                className="w-full rounded-lg border border-slate-300 p-3 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
          ) : (
            <div className="mt-6 rounded-lg bg-slate-50 p-3 text-center text-sm text-slate-500">
              {!isPending
                ? `This invoice is ${invoice.status.replace(/_/g, " ").toLowerCase()}.`
                : "View only."}
            </div>
          )}

          {/* Line-by-line detail */}
          <div className="mt-6">
            <button
              onClick={() => setShowDetail((v) => !v)}
              className="inline-flex items-center gap-1 text-sm font-semibold text-slate-700 hover:text-slate-900"
            >
              {showDetail ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
              Show line-by-line detail
            </button>

            {showDetail && (
              <div className="mt-2 rounded-xl border border-slate-200 bg-white">
                {isExec ? (
                  <ExecLineItemsTable lineItems={invoice.line_items} />
                ) : (
                  <LineItemsTable
                    lineItems={invoice.line_items}
                    editable={canDecide && isAssigned && isPending}
                    onChange={refetch}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {invoice && (
        <SplitInvoiceModal
          invoice={invoice}
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          onDone={refetch}
        />
      )}

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

/**
 * Read-only line item table for executives — shows description, amount, and the
 * business/class only. GL category and confidence are deliberately omitted
 * (the Worker hides GL from execs; this view must never surface it).
 */
function ExecLineItemsTable({
  lineItems,
}: {
  lineItems: InvoiceWithRelations["line_items"];
}) {
  const rows = lineItems.filter((li) => !li.split_parent_id);
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2.5 font-medium">Description</th>
            <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            <th className="px-4 py-2.5 font-medium">Business / Class</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((li) => (
            <tr key={li.id} className="border-b border-slate-100 align-top">
              <td className="px-4 py-3 text-slate-800">
                {li.description ?? "—"}
              </td>
              <td className="px-4 py-3 text-right font-medium text-slate-900">
                {formatCurrency(Number(li.amount ?? 0))}
              </td>
              <td className="px-4 py-3 text-slate-700">
                {li.business
                  ? li.class && li.class !== "None"
                    ? `${li.business} · ${li.class}`
                    : li.business
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
