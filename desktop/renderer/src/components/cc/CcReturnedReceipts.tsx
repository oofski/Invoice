import { useCallback, useEffect, useState } from "react";
import { Undo2, Eye, RotateCcw } from "lucide-react";
import { Card, Button, Spinner } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { formatDate } from "@/lib/utils";
import { ccApi, type InboxItem } from "@/cc/ccApi";
import { CcInboxReceiptPane } from "@/components/cc/CcInboxPane";

/**
 * Cardholder "Returned receipts" list (design §4 — Feature A). Shows the items a
 * manager sent back (`status=RETURNED`) with the manager's `return_note`, a
 * preview of the original file, and a "Re-submit" action that re-opens the drop
 * flow. `onResubmit` hands control back to the parent (which owns the drop zone)
 * so the cardholder can re-pick the right file.
 *
 * `refreshKey` lets the parent force a reload (e.g. after a fresh drop).
 */
export function CcReturnedReceipts({
  refreshKey,
  onCount,
  onResubmit,
}: {
  refreshKey?: number;
  onCount?: (n: number) => void;
  onResubmit?: () => void;
}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>("Receipt");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.myInbox({ status: "RETURNED" });
      const list = res.items ?? [];
      setItems(list);
      onCount?.(list.length);
    } catch {
      // The endpoint 404s for non-CC users / 503 un-migrated — degrade quietly.
      setItems([]);
      onCount?.(0);
    } finally {
      setLoading(false);
    }
  }, [onCount]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  if (!loading && items.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Undo2 className="h-4 w-4 text-ink-subtle" />
        <h2 className="font-display text-sm font-semibold text-ink">
          Returned receipts
        </h2>
        {items.length > 0 && (
          <span className="ml-1 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">
            {items.length}
          </span>
        )}
        <span className="ml-auto text-xs text-ink-muted">
          Your manager couldn't file these — please re-submit
        </span>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {it.ocr_extracted_data?.merchant_name || it.file_name}
                  </p>
                  <p className="text-xs text-ink-muted">
                    {it.file_name} · {formatDate(it.created_at)}
                  </p>
                  {it.return_note && (
                    <p className="mt-1 rounded-md bg-danger/5 px-2 py-1 text-xs text-danger">
                      “{it.return_note}”
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setPreviewId(it.id);
                      setPreviewName(it.file_name);
                    }}
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </Button>
                  <Button size="sm" onClick={() => onResubmit?.()}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Re-submit
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={!!previewId}
        onClose={() => setPreviewId(null)}
        title={previewName}
        className="h-[88vh] w-[90vw] max-w-[1100px]"
        fill
      >
        <div className="h-full">
          <CcInboxReceiptPane inboxId={previewId} />
        </div>
      </Modal>
    </Card>
  );
}
