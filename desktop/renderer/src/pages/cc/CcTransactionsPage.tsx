import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Ban,
  CheckCheck,
  Download,
  ReceiptText,
  SlidersHorizontal,
  Paperclip,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import {
  Card,
  Button,
  Spinner,
  EmptyState,
  Input,
  Select,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { useCcManager } from "@/cc/useCcEnabled";
import { downloadSheet, exportDateStamp } from "@/cc/ccExport";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { CcReceiptPane } from "@/components/cc/CcReceiptPane";
import { EntitySplitModal } from "@/components/cc/EntitySplitModal";
import { LineCodingModal } from "@/components/cc/LineCodingModal";
import { CcEditTransactionModal } from "@/components/cc/CcEditTransactionModal";
import {
  ccApi,
  ccEntityLabel,
  notificationTxIds,
  type Cardholder,
  type CcTransaction,
  type EntitySplit,
  type Receipt,
  type Notification,
  type ReceiptLine,
  type ReceiptStatus,
  type TransactionsQuery,
} from "@/cc/ccApi";

const STATUSES: (ReceiptStatus | "ALL")[] = [
  "ALL",
  "PENDING",
  "UPLOADED",
  "RECEIVED",
  "NOT_REQUIRED",
  "WAIVED",
];

// Receipt statuses for the bulk "Set status" Select (STATUSES minus "ALL").
const BULK_STATUSES = STATUSES.filter((s) => s !== "ALL") as ReceiptStatus[];

export default function CcTransactionsPage() {
  const { id: routeId } = useParams<{ id?: string }>();
  const isManager = useCcManager();
  const [filters, setFilters] = useState<TransactionsQuery>({ per_page: 200 });
  const [search, setSearch] = useState("");
  const [transactions, setTransactions] = useState<CcTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  // Manager multi-select (ids of loaded transactions) + bulk-action busy flag.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // detail panel
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deep-link (#/credit-cards/transactions/:id, e.g. from the manager-alert
  // email) opens the detail panel for that transaction.
  useEffect(() => {
    if (routeId) setSelectedId(routeId);
  }, [routeId]);
  const [detail, setDetail] = useState<{
    transaction: CcTransaction;
    splits: EntitySplit[];
    receipts: Receipt[];
  } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const [splitOpen, setSplitOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);

  // Active cardholders for the manager reassign Select (loaded once).
  const [cardholders, setCardholders] = useState<Cardholder[]>([]);

  // Line-by-line coding (loaded lazily per detail; empty -> legacy split path).
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [linesOpen, setLinesOpen] = useState(false);

  const queryString = useMemo(() => {
    const f: TransactionsQuery = { ...filters };
    if (search.trim()) f.q = search.trim();
    return f;
  }, [filters, search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.listTransactions(queryString);
      setTransactions(res.transactions ?? []);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load transactions");
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    const t = setTimeout(load, search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // Managers can reassign the cardholder; load the active list once.
  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    ccApi
      .listCardholders()
      .then((res) => {
        if (!cancelled) setCardholders(res.cardholders ?? []);
      })
      .catch(() => {
        if (!cancelled) setCardholders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isManager]);

  const activeCardholders = useMemo(
    () =>
      cardholders.filter((c) => c.is_active === true || c.is_active === 1),
    [cardholders],
  );

  // --- Multi-select -------------------------------------------------------
  const allSelected =
    transactions.length > 0 && selectedIds.size === transactions.length;

  function toggleRowSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Header "select all (loaded)" — selects/clears every loaded transaction.
  function toggleSelectAll() {
    setSelectedIds((prev) =>
      prev.size === transactions.length
        ? new Set()
        : new Set(transactions.map((t) => t.id)),
    );
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setLines([]);
    try {
      const res = await ccApi.getTransaction(id);
      setDetail(res);
      // Best-effort: load any OCR/coded lines. Empty (or 503 pre-migration)
      // falls back to the legacy whole-charge entity split.
      try {
        const linesRes = await ccApi.getLines(id);
        setLines(linesRes.lines ?? []);
      } catch {
        setLines([]);
      }
      try {
        const notifRes = await ccApi.listNotifications({
          cardholder_id: res.transaction.cardholder_id ?? undefined,
        });
        // Only those referencing this tx.
        setNotifications(
          (notifRes.notifications ?? []).filter((n) =>
            notificationTxIds(n).includes(id),
          ),
        );
      } catch {
        setNotifications([]);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load transaction");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) loadDetail(selectedId);
    else {
      setDetail(null);
      setNotifications([]);
    }
  }, [selectedId, loadDetail]);

  async function changeStatus(id: string, status: ReceiptStatus) {
    try {
      const res = await ccApi.patchTransaction(id, { receipt_status: status });
      setTransactions((prev) =>
        prev.map((t) => (t.id === id ? res.transaction : t)),
      );
      if (detail?.transaction.id === id)
        setDetail((d) => (d ? { ...d, transaction: res.transaction } : d));
      toast.success("Status updated");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    }
  }

  async function reassignCardholder(id: string, cardholderId: string) {
    try {
      await ccApi.patchTransaction(id, {
        cardholder_id: cardholderId || null,
      });
      toast.success("Cardholder updated");
      await loadDetail(id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    }
  }

  async function saveNotes(id: string, notes: string) {
    try {
      const res = await ccApi.patchTransaction(id, { notes });
      if (detail?.transaction.id === id)
        setDetail((d) => (d ? { ...d, transaction: res.transaction } : d));
      setTransactions((prev) =>
        prev.map((t) => (t.id === id ? res.transaction : t)),
      );
      toast.success("Notes saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save notes");
    }
  }

  async function unarchive(id: string) {
    try {
      await ccApi.unarchiveTransaction(id);
      toast.success("Transaction restored");
      if (detail?.transaction.id === id) await loadDetail(id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Unarchive failed");
    }
  }

  // Page through the FULL filtered set (the list view is capped at 200, so we
  // fetch every result here rather than only what's on screen). Shared by
  // exportExcel and exportAndClear so both export an identical row set.
  const fetchAllFiltered = useCallback(async (): Promise<CcTransaction[]> => {
    const PER_PAGE = 200;
    const MAX_PAGES = 100; // defensive cap to avoid an infinite loop
    const all: CcTransaction[] = [];
    let page = 1;
    let total = Infinity;
    while (page <= MAX_PAGES && all.length < total) {
      const res = await ccApi.listTransactions({
        ...queryString,
        page,
        per_page: PER_PAGE,
      });
      const batch = res.transactions ?? [];
      all.push(...batch);
      total = res.total ?? all.length;
      if (batch.length < PER_PAGE) break;
      page++;
    }
    return all;
  }, [queryString]);

  // Build + download the xlsx for a fetched row set. Returns false when there
  // was nothing to export (so callers can bail without archiving).
  function downloadTransactions(all: CcTransaction[]): boolean {
    if (all.length === 0) {
      toast.info("No transactions to export.");
      return false;
    }
    const header = [
      "Date",
      "Cardholder",
      "Source",
      "Vendor",
      "Category",
      "Amount",
      "Receipt Status",
      "In QB",
      "Exp Acct",
      "Notes",
    ];
    const rows = all.map((t) => [
      t.transaction_date,
      t.cardholder_name,
      t.source,
      t.vendor,
      t.category ?? "",
      t.amount,
      t.receipt_status,
      t.in_qb ? "Yes" : "No",
      t.exp_acct ?? "",
      t.notes ?? "",
    ]);
    downloadSheet(
      `CC_Transactions_${exportDateStamp()}.xlsx`,
      "Transactions",
      header,
      rows,
    );
    return true;
  }

  async function exportExcel() {
    setExporting(true);
    try {
      const all = await fetchAllFiltered();
      downloadTransactions(all);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  // Manager: export the current view, THEN archive those rows. Export is locked
  // before archive — if the fetch/download throws, we archive NOTHING.
  async function exportAndClear() {
    if (
      !window.confirm(
        "Download an Excel of the current view, then archive (hide) those transactions? Archived transactions are hidden from the list but can be restored with 'Show archived'.",
      )
    )
      return;
    setExporting(true);
    try {
      // EXPORT FIRST. Any throw here aborts before a single archive call.
      let rows: CcTransaction[];
      try {
        rows = await fetchAllFiltered();
        if (!downloadTransactions(rows)) return; // nothing to export
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Export failed");
        return; // export-locked: archive nothing
      }
      // Only after a successful download: archive the (non-archived) rows.
      const ids = rows.filter((r) => !r.archived_at).map((r) => r.id);
      if (ids.length === 0) {
        toast.info("Nothing to archive (already archived).");
        return;
      }
      const res = await ccApi.archiveTransactions(ids);
      toast.success(`Exported and archived ${res.archived} transaction(s)`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Archive failed");
    } finally {
      setExporting(false);
    }
  }

  async function deleteReceipt(receipt: Receipt) {
    if (!window.confirm("Delete this receipt? This cannot be undone.")) return;
    try {
      await ccApi.deleteReceipt(receipt.id);
      toast.success("Receipt deleted");
      if (detail) await loadDetail(detail.transaction.id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  // --- Bulk actions (manager-only) ----------------------------------------
  // Apply a partial patch to every selected transaction, then clear + reload.
  async function bulkPatch(
    updates: Partial<{
      receipt_status: ReceiptStatus;
      in_qb: boolean;
      cardholder_id: string | null;
    }>,
  ) {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkBusy(true);
    try {
      const res = await ccApi.bulkPatchTransactions({
        transaction_ids: ids,
        updates,
      });
      toast.success(`Updated ${res.updated_count} transaction(s)`);
      clearSelection();
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkArchive() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !window.confirm(
        `Archive (hide) ${ids.length} selected transaction(s)? They can be restored with 'Show archived'.`,
      )
    )
      return;
    setBulkBusy(true);
    try {
      const res = await ccApi.archiveTransactions(ids);
      toast.success(`Archived ${res.archived} transaction(s)`);
      clearSelection();
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Bulk update failed");
    } finally {
      setBulkBusy(false);
    }
  }

  // Export ONLY the selected rows, client-side over rows already in state
  // (same columns as the full "Export Excel"). No refetch.
  function exportSelected() {
    const rows = transactions.filter((t) => selectedIds.has(t.id));
    downloadTransactions(rows);
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle="All credit-card transactions"
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
            {isManager && (
              <Button
                variant="secondary"
                size="sm"
                onClick={exportAndClear}
                disabled={exporting}
              >
                <Archive className="h-4 w-4" />
                Download Excel + Clear
              </Button>
            )}
          </div>
        }
      />
      <CcSubNav />

      <div className="flex gap-4 p-6">
        <div className={cn("min-w-0 flex-1", selectedId && "hidden lg:block")}>
          <Card>
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
              <SlidersHorizontal className="h-4 w-4 text-ink-subtle" />
              <Input
                placeholder="Search vendor…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-44"
              />
              <Select
                value={filters.source ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    source: (e.target.value || undefined) as
                      | "CAPITAL_ONE"
                      | "AMEX"
                      | undefined,
                  }))
                }
                className="w-36"
              >
                <option value="">All sources</option>
                <option value="CAPITAL_ONE">Capital One</option>
                <option value="AMEX">Amex</option>
              </Select>
              <Select
                value={filters.receipt_status ?? "ALL"}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    receipt_status:
                      e.target.value === "ALL"
                        ? undefined
                        : (e.target.value as ReceiptStatus),
                  }))
                }
                className="w-40"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s === "ALL" ? "All statuses" : s.replace(/_/g, " ")}
                  </option>
                ))}
              </Select>
              <Input
                type="date"
                value={filters.date_from ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    date_from: e.target.value || undefined,
                  }))
                }
                className="w-40"
              />
              <Input
                type="date"
                value={filters.date_to ?? ""}
                onChange={(e) =>
                  setFilters((f) => ({
                    ...f,
                    date_to: e.target.value || undefined,
                  }))
                }
                className="w-40"
              />
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink-muted">
                <input
                  type="checkbox"
                  checked={!!filters.includeArchived}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      includeArchived: e.target.checked ? 1 : undefined,
                    }))
                  }
                  className="h-4 w-4 rounded border-line accent-accent"
                />
                Show archived
              </label>
            </div>

            {/* Bulk toolbar (manager-only, ≥1 selected) */}
            {isManager && selectedIds.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-line bg-selected-bg px-4 py-2.5">
                <span className="text-sm font-medium text-accent">
                  {selectedIds.size} selected
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearSelection}
                  disabled={bulkBusy}
                >
                  Clear
                </Button>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {/* Set status */}
                  <Select
                    value=""
                    onChange={(e) => {
                      if (e.target.value)
                        bulkPatch({
                          receipt_status: e.target.value as ReceiptStatus,
                        });
                    }}
                    disabled={bulkBusy}
                    className="w-40"
                    aria-label="Set receipt status"
                  >
                    <option value="">Set status…</option>
                    {BULK_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                  {/* In QB */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => bulkPatch({ in_qb: true })}
                    loading={bulkBusy}
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Mark in QB
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => bulkPatch({ in_qb: false })}
                    loading={bulkBusy}
                  >
                    <Ban className="h-3.5 w-3.5" />
                    Mark not in QB
                  </Button>
                  {/* Reassign cardholder ("__none__" placeholder so the
                      "Unassigned" option (value "") still fires onChange) */}
                  <Select
                    value="__none__"
                    onChange={(e) => {
                      if (e.target.value !== "__none__")
                        bulkPatch({ cardholder_id: e.target.value || null });
                    }}
                    disabled={bulkBusy}
                    className="w-48"
                    aria-label="Reassign cardholder"
                  >
                    <option value="__none__" disabled>
                      Reassign cardholder…
                    </option>
                    <option value="">— Unassigned —</option>
                    {activeCardholders.map((c) => (
                      <option key={c.id} value={c.id}>
                        {cardholderLabel(c)}
                      </option>
                    ))}
                  </Select>
                  {/* Export selected */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={exportSelected}
                    disabled={bulkBusy}
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export selected
                  </Button>
                  {/* Archive */}
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={bulkArchive}
                    loading={bulkBusy}
                  >
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </Button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-16">
                <Spinner />
              </div>
            ) : transactions.length === 0 ? (
              <EmptyState
                title="No transactions"
                description="Adjust the filters or import a statement."
                icon={<ReceiptText className="h-8 w-8" />}
              />
            ) : (
              <div className="scroll-thin overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                      {isManager && (
                        <th className="px-4 py-2.5 font-medium">
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleSelectAll}
                            className="h-4 w-4 rounded border-line accent-accent"
                            aria-label="Select all loaded"
                          />
                        </th>
                      )}
                      <th className="px-4 py-2.5 font-medium">Date</th>
                      <th className="px-4 py-2.5 font-medium">Cardholder</th>
                      <th className="px-4 py-2.5 font-medium">Vendor</th>
                      <th className="px-4 py-2.5 font-medium">Source</th>
                      <th className="px-4 py-2.5 text-right font-medium">
                        Amount
                      </th>
                      <th className="px-4 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transactions.map((t) => (
                      <tr
                        key={t.id}
                        onClick={() => setSelectedId(t.id)}
                        className={cn(
                          "cursor-pointer border-b border-line transition-colors hover:bg-surface-2",
                          selectedId === t.id && "bg-selected-bg",
                          t.archived_at && "opacity-60",
                        )}
                      >
                        {isManager && (
                          <td
                            className="px-4 py-3"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(t.id)}
                              onChange={() => toggleRowSelect(t.id)}
                              className="h-4 w-4 rounded border-line accent-accent"
                              aria-label={`Select ${t.vendor}`}
                            />
                          </td>
                        )}
                        <td className="px-4 py-3 text-ink-muted">
                          {formatDate(t.transaction_date)}
                        </td>
                        <td className="px-4 py-3 text-ink-muted">
                          <span
                            className={cn(
                              t.cardholder_id ? "" : "text-danger",
                            )}
                          >
                            {t.cardholder_name}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-ink">
                          <span className="flex items-center gap-2">
                            <span>{t.vendor}</span>
                            {t.archived_at && (
                              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-ink-muted">
                                Archived
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-ink-muted">
                          {t.source === "AMEX" ? "Amex" : "Cap One"}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {formatCurrency(t.amount)}
                        </td>
                        <td className="px-4 py-3">
                          <CcStatusBadge status={t.receipt_status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Detail panel */}
        {selectedId && (
          <div className="w-full lg:w-[420px] lg:shrink-0">
            <Card className="sticky top-6">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <h2 className="font-display text-sm font-semibold text-ink">
                  Transaction detail
                </h2>
                <div className="flex items-center gap-2">
                  {isManager && detail && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditOpen(true)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit details
                    </Button>
                  )}
                  <button
                    onClick={() => setSelectedId(null)}
                    className="text-ink-subtle hover:text-ink"
                    aria-label="Close"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              {detailLoading || !detail ? (
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              ) : (
                <div className="space-y-4 p-4">
                  {detail.transaction.archived_at && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
                      <span className="text-ink-muted">
                        Archived {formatDate(detail.transaction.archived_at)}
                      </span>
                      {isManager && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => unarchive(detail.transaction.id)}
                        >
                          <ArchiveRestore className="h-4 w-4" />
                          Unarchive
                        </Button>
                      )}
                    </div>
                  )}
                  <DetailRow label="Vendor" value={detail.transaction.vendor} />
                  <DetailRow
                    label="Amount"
                    value={formatCurrency(detail.transaction.amount)}
                  />
                  <DetailRow
                    label="Date"
                    value={formatDate(detail.transaction.transaction_date)}
                  />
                  {isManager ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                        Cardholder
                      </span>
                      <Select
                        value={detail.transaction.cardholder_id ?? ""}
                        onChange={(e) =>
                          reassignCardholder(
                            detail.transaction.id,
                            e.target.value,
                          )
                        }
                        className="w-56"
                      >
                        <option value="">— Unassigned —</option>
                        {/* Keep the current cardholder selectable even if it's
                            no longer active (so the Select can show it). */}
                        {detail.transaction.cardholder_id &&
                          !activeCardholders.some(
                            (c) => c.id === detail.transaction.cardholder_id,
                          ) && (
                            <option value={detail.transaction.cardholder_id}>
                              {detail.transaction.cardholder_name}
                            </option>
                          )}
                        {activeCardholders.map((c) => (
                          <option key={c.id} value={c.id}>
                            {cardholderLabel(c)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <DetailRow
                      label="Cardholder"
                      value={detail.transaction.cardholder_name}
                    />
                  )}
                  <DetailRow
                    label="Category"
                    value={detail.transaction.category ?? "—"}
                  />

                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      Receipt status
                    </p>
                    <Select
                      value={detail.transaction.receipt_status}
                      onChange={(e) =>
                        changeStatus(
                          detail.transaction.id,
                          e.target.value as ReceiptStatus,
                        )
                      }
                    >
                      {(
                        [
                          "PENDING",
                          "UPLOADED",
                          "RECEIVED",
                          "NOT_REQUIRED",
                          "WAIVED",
                        ] as ReceiptStatus[]
                      ).map((s) => (
                        <option key={s} value={s}>
                          {s.replace(/_/g, " ")}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {/* Line coding (when the receipt has OCR lines) OR the
                      legacy whole-charge entity split (no-lines fallback). */}
                  {(detail.transaction.source === "AMEX" ||
                    detail.transaction.source === "CAPITAL_ONE") &&
                    (lines.length > 0 ? (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                            Line coding
                          </p>
                          <button
                            onClick={() => setLinesOpen(true)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit lines
                          </button>
                        </div>
                        <LineCodingSummary lines={lines} />
                      </div>
                    ) : (
                      <div>
                        <div className="mb-1 flex items-center justify-between">
                          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                            Entity split
                          </p>
                          <button
                            onClick={() => setSplitOpen(true)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                          >
                            <Pencil className="h-3 w-3" />
                            Edit
                          </button>
                        </div>
                        {detail.splits.length === 0 ? (
                          <p className="text-xs text-ink-muted">No split yet.</p>
                        ) : (
                          <ul className="rounded-lg border border-line text-sm">
                            {detail.splits.map((s) => (
                              <li
                                key={s.id}
                                className="flex items-center justify-between border-b border-line px-3 py-1.5 last:border-0"
                              >
                                <span className="text-ink-muted">
                                  {ccEntityLabel(s.entity_name)}
                                </span>
                                <span className="tabular-nums text-ink">
                                  {formatCurrency(s.amount)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}

                  {/* Receipts */}
                  <div>
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      Receipts
                    </p>
                    {detail.receipts.length === 0 ? (
                      <p className="text-xs text-ink-muted">
                        No receipts attached.
                      </p>
                    ) : (
                      <ul className="space-y-1">
                        {detail.receipts.map((r) => (
                          <li
                            key={r.id}
                            className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-sm"
                          >
                            <span className="flex items-center gap-2 truncate text-ink">
                              <Paperclip className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                              <span className="truncate">{r.file_name}</span>
                            </span>
                            <span className="ml-2 flex shrink-0 items-center gap-2">
                              <button
                                onClick={() => setPreviewReceipt(r)}
                                className="text-xs font-medium text-accent hover:underline"
                              >
                                Preview
                              </button>
                              {isManager && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void deleteReceipt(r);
                                  }}
                                  className="text-ink-subtle hover:text-danger"
                                  title="Delete receipt"
                                  aria-label="Delete receipt"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  {/* Notification history */}
                  {notifications.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
                        Notifications
                      </p>
                      <ul className="space-y-1 text-xs text-ink-muted">
                        {notifications.map((n) => (
                          <li key={n.id}>
                            {formatDate(n.created_at)} · {n.delivery}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Notes */}
                  <NotesEditor
                    initial={detail.transaction.notes ?? ""}
                    onSave={(v) => saveNotes(detail.transaction.id, v)}
                  />
                </div>
              )}
            </Card>
          </div>
        )}
      </div>

      {/* Split modal (no-lines fallback) */}
      {detail &&
        (detail.transaction.source === "AMEX" ||
          detail.transaction.source === "CAPITAL_ONE") && (
        <EntitySplitModal
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          transactionId={detail.transaction.id}
          amount={detail.transaction.amount}
          vendor={detail.transaction.vendor}
          existingSplits={detail.splits}
          onSaved={(splits) =>
            setDetail((d) => (d ? { ...d, splits } : d))
          }
        />
      )}

      {/* Line-coding modal (manager edits the OCR-line coding) */}
      {detail && lines.length > 0 && (
        <LineCodingModal
          open={linesOpen}
          onClose={() => setLinesOpen(false)}
          transactionId={detail.transaction.id}
          amount={detail.transaction.amount}
          vendor={detail.transaction.vendor}
          lines={lines}
          onSaved={(res) => {
            setLines(res.lines ?? []);
            // The save re-derives cc_entity_splits server-side; refresh detail
            // so the embedded entity rollup stays correct.
            void loadDetail(detail.transaction.id);
          }}
        />
      )}

      {/* Edit details modal (manager-only mis-parse corrections) */}
      {detail && isManager && (
        <CcEditTransactionModal
          open={editOpen}
          onClose={() => setEditOpen(false)}
          transaction={detail.transaction}
          hasSplits={detail.splits.length > 0}
          hasLines={lines.length > 0}
          onSaved={async () => {
            await loadDetail(detail.transaction.id);
            await load();
          }}
        />
      )}

      {/* Receipt preview modal */}
      <Modal
        open={!!previewReceipt}
        onClose={() => setPreviewReceipt(null)}
        title={previewReceipt?.file_name ?? "Receipt"}
        className="h-[88vh] w-[90vw] max-w-[1100px]"
        fill
      >
        <div className="h-full">
          <CcReceiptPane
            receiptId={previewReceipt?.id ?? null}
            fileType={previewReceipt?.file_type}
          />
        </div>
      </Modal>
    </div>
  );
}

function LineCodingSummary({ lines }: { lines: ReceiptLine[] }) {
  return (
    <ul className="space-y-1.5">
      {lines.map((line, li) => (
        <li
          key={line.id ?? li}
          className="rounded-lg border border-line px-3 py-2 text-sm"
        >
          <div className="flex items-center justify-between">
            <span className="truncate font-medium text-ink">
              {line.kind === "TAX"
                ? line.description || "Sales Tax"
                : line.description || `Line ${li + 1}`}
            </span>
            <span className="shrink-0 tabular-nums text-ink-muted">
              {formatCurrency(line.amount)}
            </span>
          </div>
          {line.allocations.length === 0 ? (
            <p className="mt-0.5 text-xs text-ink-subtle">Not coded yet.</p>
          ) : (
            <ul className="mt-1 space-y-0.5">
              {line.allocations.map((a, ai) => (
                <li
                  key={a.id ?? ai}
                  className="flex items-center justify-between text-xs text-ink-muted"
                >
                  <span className="truncate">
                    {ccEntityLabel(a.entity_name)} · {a.location} ·{" "}
                    {ccCatShort(a.gl_category)}
                  </span>
                  <span className="shrink-0 tabular-nums">
                    {formatCurrency(a.amount)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function ccCatShort(gl: string): string {
  if (gl === "Service Costs") return "Back bar";
  if (gl === "Retail / Product Costs") return "Retail";
  if (gl === "Sales/Use Tax") return "Tax";
  return gl;
}

/**
 * Cardholder Select option label: "First Last" + the card last-4/5 when known,
 * matching how cardholders are shown on CcCardholdersPage (`••XXXX`).
 */
function cardholderLabel(c: Cardholder): string {
  const name = `${c.first_name}${c.last_name ? ` ${c.last_name}` : ""}`;
  const last = c.cap_one_last4 ?? c.amex_last5;
  return last ? `${name} (••${last})` : name;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className="text-sm text-ink">{value}</span>
    </div>
  );
}

function NotesEditor({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (v: string) => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const dirty = value !== initial;
  return (
    <div>
      <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-muted">
        Notes
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={2}
        className="w-full rounded-lg border border-line bg-surface p-2 text-sm text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring"
      />
      {dirty && (
        <div className="mt-1 flex justify-end">
          <Button size="sm" onClick={() => onSave(value)}>
            Save notes
          </Button>
        </div>
      )}
    </div>
  );
}
