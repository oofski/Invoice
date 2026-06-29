import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, ReceiptText } from "lucide-react";
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
import { ccApi, type InboxItem } from "@/cc/ccApi";

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
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Inbox"
        subtitle="Unmatched receipts dropped by cardholders"
      />
      <CcSubNav />

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
                <li key={it.id}>
                  <button
                    onClick={() => setSelectedId(it.id)}
                    className={cn(
                      "w-full px-4 py-3 text-left transition-colors",
                      it.id === selectedId
                        ? "bg-selected-bg"
                        : "hover:bg-surface-2",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-ink">
                        {it.cardholder_name || "Unknown cardholder"}
                      </span>
                      <span className="shrink-0 text-xs text-ink-subtle">
                        {ageOf(it.created_at)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-ink-muted">
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
                  <h2 className="truncate font-display text-sm font-semibold text-ink">
                    {selected.file_name}
                  </h2>
                </div>
                <div className="min-h-0 flex-1">
                  <CcInboxReceiptPane
                    inboxId={selected.id}
                    fileType={selected.file_type}
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
