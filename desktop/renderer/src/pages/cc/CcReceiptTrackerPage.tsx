import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  BellRing,
  CheckCheck,
  Ban,
  ListChecks,
  Eye,
  Download,
  SplitSquareHorizontal,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { downloadSheet, exportDateStamp } from "@/cc/ccExport";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { CcReceiptPane } from "@/components/cc/CcReceiptPane";
import { EntitySplitModal } from "@/components/cc/EntitySplitModal";
import { LineCodingModal } from "@/components/cc/LineCodingModal";
import { emitCcRefresh } from "@/cc/ccRefresh";
import {
  ccApi,
  sendCcReminders,
  type CcTransaction,
  type EntitySplit,
  type Receipt,
  type ReceiptLine,
  type ReceiptStatus,
} from "@/cc/ccApi";

interface Group {
  cardholderId: string | null;
  name: string;
  rows: CcTransaction[];
  open: number;
  received: number;
}

export default function CcReceiptTrackerPage() {
  const [transactions, setTransactions] = useState<CcTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [flatList, setFlatList] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  // receipt preview
  const [previewTxId, setPreviewTxId] = useState<string | null>(null);
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // Manual allocate (with or without a receipt). Opens the same coding modals
  // used on the Transactions page: LineCodingModal when the tx already has OCR
  // lines, else EntitySplitModal (entity split + overall GL category). The split
  // PUT has no receipt gate, so a receiptless tx can be allocated freely.
  const [allocTx, setAllocTx] = useState<CcTransaction | null>(null);
  const [allocSplits, setAllocSplits] = useState<EntitySplit[]>([]);
  const [allocLines, setAllocLines] = useState<ReceiptLine[]>([]);
  const [allocSplitOpen, setAllocSplitOpen] = useState(false);
  const [allocLinesOpen, setAllocLinesOpen] = useState(false);
  const [allocLoadingId, setAllocLoadingId] = useState<string | null>(null);

  async function openAllocate(t: CcTransaction) {
    setAllocLoadingId(t.id);
    try {
      const detail = await ccApi.getTransaction(t.id);
      setAllocTx(detail.transaction);
      setAllocSplits(detail.splits ?? []);
      let lines: ReceiptLine[] = [];
      try {
        const lr = await ccApi.getLines(t.id);
        lines = lr.lines ?? [];
      } catch {
        lines = [];
      }
      setAllocLines(lines);
      if (lines.length > 0) setAllocLinesOpen(true);
      else setAllocSplitOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to open allocation");
      setAllocTx(null);
    } finally {
      setAllocLoadingId(null);
    }
  }

  function closeAllocate() {
    setAllocSplitOpen(false);
    setAllocLinesOpen(false);
    setAllocTx(null);
    setAllocSplits([]);
    setAllocLines([]);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Track everything that still needs attention plus recently received.
      const res = await ccApi.listTransactions({ per_page: 200 });
      // Exclude payments/credits that never need a receipt.
      setTransactions(
        (res.transactions ?? []).filter((t) => !t.is_payment),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load tracker");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const t of transactions) {
      const key = t.cardholder_id ?? "__unmatched__";
      let g = map.get(key);
      if (!g) {
        g = {
          cardholderId: t.cardholder_id,
          name: t.cardholder_name || "UNMATCHED",
          rows: [],
          open: 0,
          received: 0,
        };
        map.set(key, g);
      }
      g.rows.push(t);
      if (t.receipt_status === "PENDING" || t.receipt_status === "UPLOADED")
        g.open++;
      if (t.receipt_status === "RECEIVED") g.received++;
    }
    // Most-pending first.
    return Array.from(map.values()).sort((a, b) => b.open - a.open);
  }, [transactions]);

  function toggleCollapse(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Optimistic check-off: flip the badge instantly, PATCH, then RECONCILE from
  // the server's authoritative row (mirrors CcTransactionsPage.changeStatus so
  // the change is confirmed + visible, not just optimistic). Reverts + toasts on
  // error.
  async function checkOff(t: CcTransaction, status: ReceiptStatus) {
    const prevStatus = t.receipt_status;
    setTransactions((rows) =>
      rows.map((r) => (r.id === t.id ? { ...r, receipt_status: status } : r)),
    );
    try {
      const res = await ccApi.patchTransaction(t.id, { receipt_status: status });
      // Reconcile from the server (authoritative), not just the optimistic flip.
      setTransactions((rows) =>
        rows.map((r) => (r.id === t.id ? res.transaction : r)),
      );
      toast.success(status === "RECEIVED" ? "Marked received" : "Status updated");
      emitCcRefresh();
    } catch (err) {
      setTransactions((rows) =>
        rows.map((r) =>
          r.id === t.id ? { ...r, receipt_status: prevStatus } : r,
        ),
      );
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    }
  }

  async function bulkUpdate(status: ReceiptStatus) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBusy(true);
    // optimistic
    const prev = transactions;
    setTransactions((rows) =>
      rows.map((r) =>
        selected.has(r.id) ? { ...r, receipt_status: status } : r,
      ),
    );
    try {
      const res = await ccApi.bulkPatchTransactions({
        transaction_ids: ids,
        updates: { receipt_status: status },
      });
      toast.success(`${res.updated_count} updated`);
      setSelected(new Set());
      emitCcRefresh();
      // Reconcile from the server so the badges/progress match persisted state.
      await load();
    } catch (err) {
      setTransactions(prev);
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    } finally {
      setBusy(false);
    }
  }

  async function remindSelected() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    // Map the selected transactions to their cardholders.
    const cardholderIds = Array.from(
      new Set(
        transactions
          .filter((t) => selected.has(t.id) && t.cardholder_id)
          .map((t) => t.cardholder_id as string),
      ),
    );
    if (cardholderIds.length === 0) {
      toast.error("Selected transactions have no matched cardholder.");
      return;
    }
    setBusy(true);
    try {
      const { result, openedMailto } = await sendCcReminders(
        { cardholder_ids: cardholderIds, transaction_ids: ids },
        desktop()?.openExternal,
      );
      if (openedMailto) {
        toast.success("Opened a reminder draft in your mail app");
      } else if (result.sent_count > 0) {
        toast.success(
          `${result.sent_count} reminder${result.sent_count === 1 ? "" : "s"} sent`,
        );
      } else if (result.not_configured_count > 0) {
        toast.error(
          "Email isn't configured and no mail client is available to draft a reminder.",
        );
      } else {
        toast.info("Nothing pending to remind about.");
      }
      setSelected(new Set());
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send reminders");
    } finally {
      setBusy(false);
    }
  }

  // The tracker list is capped at 200 rows; page through the full set for the
  // export so the worklist file isn't silently truncated. Mirrors the page's own
  // filter (drop payments/credits that never need a receipt).
  async function exportExcel() {
    setExporting(true);
    try {
      const PER_PAGE = 200;
      const MAX_PAGES = 100;
      const all: CcTransaction[] = [];
      let page = 1;
      let total = Infinity;
      while (page <= MAX_PAGES && all.length < total) {
        const res = await ccApi.listTransactions({ page, per_page: PER_PAGE });
        const batch = res.transactions ?? [];
        all.push(...batch);
        total = res.total ?? all.length;
        if (batch.length < PER_PAGE) break;
        page++;
      }
      const rows = all
        .filter((t) => !t.is_payment)
        .map((t) => [
          t.cardholder_name,
          formatDate(t.transaction_date),
          t.vendor,
          t.amount,
          t.category ?? "",
          t.receipt_status,
        ]);
      if (rows.length === 0) {
        toast.info("Nothing to export.");
        return;
      }
      downloadSheet(
        `CC_ReceiptTracker_${exportDateStamp()}.xlsx`,
        "Receipt Tracker",
        ["Cardholder", "Date", "Vendor", "Amount", "Category", "Receipt Status"],
        rows,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function openPreview(txId: string) {
    setPreviewTxId(txId);
    setPreviewReceipt(null);
    setPreviewLoading(true);
    try {
      const res = await ccApi.listReceipts(txId);
      const first = res.receipts?.[0] ?? null;
      if (!first) {
        toast.info("No receipt attached to this transaction.");
        setPreviewTxId(null);
        return;
      }
      setPreviewReceipt(first);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load receipt");
      setPreviewTxId(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  function renderRow(t: CcTransaction) {
    const checkedOff = t.receipt_status === "RECEIVED";
    return (
      <tr
        key={t.id}
        className={cn(
          "border-b border-line transition-colors hover:bg-surface-2",
          selected.has(t.id) && "bg-selected-bg",
        )}
      >
        <td className="px-3 py-2.5">
          <input
            type="checkbox"
            checked={selected.has(t.id)}
            onChange={() => toggleRow(t.id)}
            aria-label={`Select ${t.vendor}`}
          />
        </td>
        <td className="px-3 py-2.5">
          <button
            onClick={() =>
              checkOff(t, checkedOff ? "PENDING" : "RECEIVED")
            }
            title={checkedOff ? "Mark pending" : "Mark received"}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded border",
              checkedOff
                ? "border-success bg-success text-success-fg"
                : "border-line text-transparent hover:border-accent",
            )}
          >
            <CheckCheck className="h-3.5 w-3.5" />
          </button>
        </td>
        <td className="px-3 py-2.5 text-ink-muted">
          {formatDate(t.transaction_date)}
        </td>
        <td className="px-3 py-2.5 font-medium text-ink">{t.vendor}</td>
        <td className="px-3 py-2.5 text-right tabular-nums">
          {formatCurrency(t.amount)}
        </td>
        <td className="px-3 py-2.5 text-xs text-ink-muted">
          {t.category ?? "—"}
        </td>
        <td className="px-3 py-2.5">
          <CcStatusBadge status={t.receipt_status} />
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={() => openAllocate(t)}
              disabled={allocLoadingId === t.id}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-50"
              title="Allocate this transaction across entities (with or without a receipt)"
            >
              <SplitSquareHorizontal className="h-3.5 w-3.5" />
              {allocLoadingId === t.id ? "Opening…" : "Allocate"}
            </button>
            <button
              onClick={() => openPreview(t.id)}
              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </button>
          </div>
        </td>
      </tr>
    );
  }

  const tableHead = (
    <thead>
      <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
        <th className="px-3 py-2 font-medium" />
        <th className="px-3 py-2 font-medium" />
        <th className="px-3 py-2 font-medium">Date</th>
        <th className="px-3 py-2 font-medium">Vendor</th>
        <th className="px-3 py-2 text-right font-medium">Amount</th>
        <th className="px-3 py-2 font-medium">Category</th>
        <th className="px-3 py-2 font-medium">Status</th>
        <th className="px-3 py-2" />
      </tr>
    </thead>
  );

  return (
    <div>
      <PageHeader
        title="Receipt Tracker"
        subtitle="Daily receipt-collection workflow"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={exportExcel}
              loading={exporting}
              disabled={exporting}
            >
              <Download className="h-4 w-4" />
              Export Excel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setFlatList((v) => !v)}
            >
              <ListChecks className="h-4 w-4" />
              {flatList ? "Group by cardholder" : "Flat list"}
            </Button>
          </div>
        }
      />
      <CcSubNav />

      {/* Bulk toolbar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-selected-bg px-6 py-2.5">
          <span className="text-sm font-medium text-accent">
            {selected.size} selected
          </span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={remindSelected}
              loading={busy}
            >
              <BellRing className="h-3.5 w-3.5" />
              Send reminder
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => bulkUpdate("RECEIVED")}
              loading={busy}
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Mark received
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => bulkUpdate("WAIVED")}
              loading={busy}
            >
              <Ban className="h-3.5 w-3.5" />
              Waive
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-4 p-6">
        {loading ? (
          <div className="flex justify-center py-20">
            <Spinner />
          </div>
        ) : transactions.length === 0 ? (
          <EmptyState
            title="Nothing to track"
            description="Import a statement to start collecting receipts."
          />
        ) : flatList ? (
          <Card>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[820px] text-sm">
                {tableHead}
                <tbody>{transactions.map(renderRow)}</tbody>
              </table>
            </div>
          </Card>
        ) : (
          groups.map((g) => {
            const key = g.cardholderId ?? "__unmatched__";
            const isCollapsed = collapsed.has(key);
            const total = g.open + g.received;
            const pct = total > 0 ? Math.round((g.received / total) * 100) : 0;
            return (
              <Card key={key}>
                <button
                  onClick={() => toggleCollapse(key)}
                  className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 text-ink-subtle" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-ink-subtle" />
                  )}
                  <span
                    className={cn(
                      "font-display text-sm font-semibold",
                      g.cardholderId ? "text-ink" : "text-danger",
                    )}
                  >
                    {g.name}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {g.received} of {total} received
                  </span>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          pct >= 100 ? "bg-success" : "bg-accent",
                        )}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-ink-muted">
                      {pct}%
                    </span>
                  </div>
                </button>
                {!isCollapsed && (
                  <div className="scroll-thin overflow-x-auto">
                    <table className="w-full min-w-[820px] text-sm">
                      {tableHead}
                      <tbody>{g.rows.map(renderRow)}</tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })
        )}
      </div>

      {/* Manual allocate — entity split + overall GL category (no-lines path) */}
      {allocTx && (
        <EntitySplitModal
          open={allocSplitOpen}
          onClose={closeAllocate}
          transactionId={allocTx.id}
          amount={allocTx.amount}
          vendor={allocTx.vendor}
          existingSplits={allocSplits}
          showGlCategory
          glCategory={allocTx.gl_category ?? null}
          onSaved={() => {
            closeAllocate();
            void load();
          }}
        />
      )}

      {/* Manual allocate — line-by-line coding (when the tx already has OCR lines) */}
      {allocTx && allocLines.length > 0 && (
        <LineCodingModal
          open={allocLinesOpen}
          onClose={closeAllocate}
          transactionId={allocTx.id}
          amount={allocTx.amount}
          vendor={allocTx.vendor}
          lines={allocLines}
          onSaved={() => {
            closeAllocate();
            void load();
          }}
        />
      )}

      {/* Receipt preview */}
      <Modal
        open={!!previewTxId}
        onClose={() => {
          setPreviewTxId(null);
          setPreviewReceipt(null);
        }}
        title={previewReceipt?.file_name ?? "Receipt"}
        className="h-[88vh] w-[90vw] max-w-[1100px]"
        fill
      >
        <div className="h-full">
          {previewLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <CcReceiptPane
              receiptId={previewReceipt?.id ?? null}
              fileType={previewReceipt?.file_type}
              fileName={previewReceipt?.file_name}
            />
          )}
        </div>
      </Modal>
    </div>
  );
}
