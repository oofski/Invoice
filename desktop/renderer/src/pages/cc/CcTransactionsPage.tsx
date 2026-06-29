import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Download,
  ReceiptText,
  SlidersHorizontal,
  Paperclip,
  Pencil,
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
import { cn, formatCurrency, formatDate, downloadBlob } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { CcReceiptPane } from "@/components/cc/CcReceiptPane";
import { EntitySplitModal } from "@/components/cc/EntitySplitModal";
import { LineCodingModal } from "@/components/cc/LineCodingModal";
import {
  ccApi,
  ccEntityLabel,
  notificationTxIds,
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

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function CcTransactionsPage() {
  const { id: routeId } = useParams<{ id?: string }>();
  const [filters, setFilters] = useState<TransactionsQuery>({ per_page: 200 });
  const [search, setSearch] = useState("");
  const [transactions, setTransactions] = useState<CcTransaction[]>([]);
  const [loading, setLoading] = useState(true);

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
  const [previewReceipt, setPreviewReceipt] = useState<Receipt | null>(null);

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

  function exportCsv() {
    if (transactions.length === 0) {
      toast.info("No transactions to export.");
      return;
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
    const lines = [header.join(",")];
    for (const t of transactions) {
      lines.push(
        [
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
        ]
          .map(csvEscape)
          .join(","),
      );
    }
    downloadBlob(
      new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" }),
      `CC_Transactions_${new Date().toISOString().slice(0, 10)}.csv`,
    );
  }

  return (
    <div>
      <PageHeader
        title="Transactions"
        subtitle="All credit-card transactions"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={exportCsv}
            disabled={transactions.length === 0}
          >
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
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
            </div>

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
                          "cursor-pointer border-b border-line hover:bg-surface-2",
                          selectedId === t.id && "bg-selected-bg",
                        )}
                      >
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
                          {t.vendor}
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
                <button
                  onClick={() => setSelectedId(null)}
                  className="text-ink-subtle hover:text-ink"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {detailLoading || !detail ? (
                <div className="flex justify-center py-12">
                  <Spinner />
                </div>
              ) : (
                <div className="space-y-4 p-4">
                  <DetailRow label="Vendor" value={detail.transaction.vendor} />
                  <DetailRow
                    label="Amount"
                    value={formatCurrency(detail.transaction.amount)}
                  />
                  <DetailRow
                    label="Date"
                    value={formatDate(detail.transaction.transaction_date)}
                  />
                  <DetailRow
                    label="Cardholder"
                    value={detail.transaction.cardholder_name}
                  />
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
                            <button
                              onClick={() => setPreviewReceipt(r)}
                              className="ml-2 shrink-0 text-xs font-medium text-accent hover:underline"
                            >
                              Preview
                            </button>
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
