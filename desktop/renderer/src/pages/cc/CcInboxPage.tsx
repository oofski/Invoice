import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Inbox,
  ReceiptText,
  Trash2,
  Plus,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Spinner, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import {
  CcInboxPane,
  CcInboxReceiptPane,
} from "@/components/cc/CcInboxPane";
import { CcDropReceipts } from "@/components/cc/CcDropReceipts";
import { ccApi, type InboxItem } from "@/cc/ccApi";
import { useCcManager } from "@/cc/useCcEnabled";

/**
 * Manager "Inbox / Unmatched receipts" screen (design §4 — Feature A) at
 * `/credit-cards/inbox`. Left: the PENDING_MATCH queue (cardholder name, OCR
 * vendor/total/date, file, age). Right: the dropped-file preview
 * (`CcInboxReceiptPane`) + the candidate suggestions / assign picker / send-back
 * controls (`CcInboxPane`). Assign creates the cc_receipts row server-side and
 * flips the item to MATCHED; send-back returns it to the cardholder with a note.
 * Both remove the item from the queue.
 */

/** Friendly "x ago" from an ISO timestamp. */
function ageOf(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function CcInboxPage() {
  const isManager = useCcManager();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // v1.9.1: let the accountant add receipts here (upload PDFs / take a photo).
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.listInbox({ status: "PENDING_MATCH" });
      const list = res.items ?? [];
      setItems(list);
      // Keep a valid selection.
      setSelectedId((cur) =>
        cur && list.some((i) => i.id === cur) ? cur : (list[0]?.id ?? null),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load inbox");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) ?? null,
    [items, selectedId],
  );

  /** Drop an item from the local queue and advance the selection. */
  function removeFromQueue(id: string) {
    setItems((prev) => {
      const next = prev.filter((i) => i.id !== id);
      setSelectedId((cur) => (cur === id ? (next[0]?.id ?? null) : cur));
      return next;
    });
  }

  async function handleAssign(transactionId: string) {
    if (!selected) return;
    setBusy(true);
    try {
      const res = await ccApi.assignInbox(selected.id, {
        transaction_id: transactionId,
      });
      toast.success(`Filed to ${res.transaction?.vendor ?? "transaction"}`);
      removeFromQueue(selected.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to assign");
    } finally {
      setBusy(false);
    }
  }

  async function handleReturn(note: string) {
    if (!selected) return;
    setBusy(true);
    try {
      await ccApi.returnInbox(selected.id, note ? { note } : {});
      toast.success("Sent back to cardholder");
      removeFromQueue(selected.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send back");
    } finally {
      setBusy(false);
    }
  }

  /** Discard a junk/duplicate dropped receipt (manager-only). */
  async function handleDelete(it: InboxItem) {
    if (!window.confirm("Delete this dropped receipt? This cannot be undone.")) {
      return;
    }
    setBusy(true);
    try {
      await ccApi.deleteInbox(it.id);
      toast.success("Receipt deleted");
      removeFromQueue(it.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inbox"
        subtitle="Unmatched receipts dropped by cardholders"
      />
      <CcSubNav />

      {/* Add receipts — upload PDFs or take a photo (v1.9.1). Collapsible so it
          stays out of the way of the queue. */}
      <div className="px-6 pt-4">
        <Card className="overflow-hidden">
          <button
            type="button"
            onClick={() => setAddOpen((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-2"
          >
            {addOpen ? (
              <ChevronDown className="h-4 w-4 text-ink-subtle" />
            ) : (
              <ChevronRight className="h-4 w-4 text-ink-subtle" />
            )}
            <Plus className="h-4 w-4 text-ink-subtle" />
            <span className="font-display text-sm font-semibold text-ink">
              Add receipts
            </span>
            <span className="ml-auto text-xs text-ink-muted">
              Upload a PDF/photo or take a picture — we'll match it automatically
            </span>
          </button>
          {addOpen && (
            <div className="border-t border-line p-4">
              <CcDropReceipts onDropped={load} />
            </div>
          )}
        </Card>
      </div>

      <div className="flex min-h-0 flex-1 gap-4 p-6">
        {/* Left: queue */}
        <Card className="flex w-[380px] shrink-0 flex-col overflow-hidden">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Inbox className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Needs filing
            </h2>
            {items.length > 0 && (
              <span className="ml-auto rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">
                {items.length}
              </span>
            )}
          </div>
          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              title="Inbox is clear"
              description="Receipts that can't be auto-matched will appear here."
            />
          ) : (
            <ul className="scroll-thin min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {items.map((it) => (
                <li
                  key={it.id}
                  className={cn(
                    "group relative border-l-2 transition-colors",
                    it.id === selectedId
                      ? "border-accent bg-selected-bg"
                      : "border-transparent hover:bg-surface-2",
                  )}
                >
                  <button
                    onClick={() => setSelectedId(it.id)}
                    className="w-full px-4 py-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="truncate text-sm font-medium text-ink"
                        title={it.cardholder_name || "Unknown cardholder"}
                      >
                        {it.cardholder_name || "Unknown cardholder"}
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">
                        {ageOf(it.created_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span
                        className="truncate text-xs text-ink-muted"
                        title={it.ocr_extracted_data?.merchant_name || it.file_name}
                      >
                        {it.ocr_extracted_data?.merchant_name || it.file_name}
                      </span>
                      {typeof it.ocr_extracted_data?.total === "number" && (
                        <span className="shrink-0 text-xs tabular-nums text-ink">
                          {formatCurrency(it.ocr_extracted_data.total)}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-subtle">
                      {it.ocr_extracted_data?.transaction_date
                        ? formatDate(it.ocr_extracted_data.transaction_date)
                        : "No date"}{" "}
                      · {it.file_name}
                    </p>
                  </button>
                  {isManager && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(it);
                      }}
                      disabled={busy}
                      title="Delete dropped receipt"
                      aria-label="Delete dropped receipt"
                      className="absolute bottom-2 right-2 rounded-md p-1.5 text-ink-subtle opacity-0 transition-opacity hover:bg-danger/10 hover:text-danger focus:opacity-100 group-hover:opacity-100 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* Right: preview + controls */}
        <div className="flex min-h-0 flex-1 gap-4">
          {selected ? (
            <>
              <Card className="flex min-w-0 flex-1 flex-col overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line px-4 py-3">
                  <ReceiptText className="h-4 w-4 text-ink-subtle" />
                  <h2
                    className="truncate font-display text-sm font-semibold text-ink"
                    title={selected.file_name}
                  >
                    {selected.file_name}
                  </h2>
                </div>
                <div className="min-h-0 flex-1">
                  <CcInboxReceiptPane
                    inboxId={selected.id}
                    fileType={selected.file_type}
                    fileName={selected.file_name}
                  />
                </div>
              </Card>

              <Card className="flex w-[360px] shrink-0 flex-col overflow-hidden">
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <CcInboxPane
                    item={selected}
                    busy={busy}
                    onAssign={handleAssign}
                    onReturn={handleReturn}
                    onDelete={
                      isManager ? () => handleDelete(selected) : undefined
                    }
                  />
                </div>
              </Card>
            </>
          ) : (
            <Card className="flex flex-1 items-center justify-center">
              <EmptyState
                title="Nothing selected"
                description="Pick a receipt from the queue to file it."
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
