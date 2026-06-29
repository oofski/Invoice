import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { Loader2, Check, Search, Undo2, Trash2 } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import {
  ccApi,
  type CandidateTx,
  type CcTransaction,
  type InboxItem,
} from "@/cc/ccApi";

// react-pdf is heavy and browser-only — load it lazily (mirrors CcReceiptPane).
const PdfViewer = lazy(() => import("@/components/PdfViewer"));

/**
 * Inbox receipt preview. A thin mirror of `CcReceiptPane` that fetches the
 * dropped bytes from `/api/cc/receipts/inbox/:id/file` (auth header required, no
 * signed URL) via `ccApi.getInboxBlob`. `CcReceiptPane` itself is hardcoded to
 * the `/receipts/:id/file` endpoint (and is read-only for this slice), so we
 * reuse its exact rendering shape here against the inbox file URL instead.
 */
export function CcInboxReceiptPane({
  inboxId,
  fileType,
}: {
  inboxId: string | null;
  fileType?: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setError(false);

    if (!inboxId) return;

    setLoading(true);
    ccApi
      .getInboxBlob(inboxId)
      .then((blob) => {
        if (!active) return;
        const ct = (blob.type || fileType || "").toLowerCase();
        setIsImage(ct.startsWith("image/"));
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [inboxId, fileType]);

  if (!inboxId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-subtle">
        No receipt selected
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        Unable to load receipt.
      </div>
    );
  }
  if (loading || !objectUrl) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
      </div>
    );
  }
  if (isImage) {
    return (
      <div className="scroll-thin flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
        <img
          src={objectUrl}
          alt="Receipt"
          className="max-h-full max-w-full rounded shadow"
        />
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
        </div>
      }
    >
      <PdfViewer url={objectUrl} />
    </Suspense>
  );
}

/**
 * The manager's resolve controls for one queued inbox item (design §4):
 *   - candidate suggestions (the joined `candidates`), each a one-click Assign;
 *   - an "Assign to transaction" searchable picker, scoped to the resolved
 *     cardholder, falling back to all open transactions;
 *   - a "Send back" note textarea.
 *
 * Persistence is owned by the parent via `onAssign` / `onReturn` / `onDelete` so
 * the page can update its queue + toast once. `busy` disables the controls
 * during a save. `onDelete` is only passed for managers (the page gates it), so
 * the Delete button renders only when discard is permitted.
 */
export function CcInboxPane({
  item,
  busy,
  onAssign,
  onReturn,
  onDelete,
}: {
  item: InboxItem;
  busy?: boolean;
  onAssign: (transactionId: string) => void | Promise<void>;
  onReturn: (note: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [picker, setPicker] = useState<CcTransaction[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // Reset the per-item state whenever the selected item changes.
  useEffect(() => {
    setNote("");
    setSearch("");
    setPicker([]);
  }, [item.id]);

  // Lazily load the assign picker (scoped to the resolved cardholder when known,
  // else all). Triggered the first time the manager focuses the search box.
  async function ensurePicker() {
    if (picker.length > 0 || pickerLoading) return;
    setPickerLoading(true);
    try {
      const res = await ccApi.listTransactions(
        item.cardholder_id
          ? { cardholder_id: item.cardholder_id, per_page: 200 }
          : { per_page: 200 },
      );
      setPicker((res.transactions ?? []).filter((t) => !t.is_payment));
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to load transactions",
      );
    } finally {
      setPickerLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const open = picker.filter(
      (t) => t.receipt_status === "PENDING" || t.receipt_status === "UPLOADED",
    );
    if (!q) return open.slice(0, 25);
    return open
      .filter(
        (t) =>
          t.vendor.toLowerCase().includes(q) ||
          formatCurrency(t.amount).includes(q) ||
          (t.transaction_date ?? "").includes(q),
      )
      .slice(0, 25);
  }, [picker, search]);

  return (
    <div className="flex h-full flex-col gap-3">
      {/* OCR summary */}
      <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-ink">
            {item.ocr_extracted_data?.merchant_name || item.file_name}
          </span>
          {typeof item.ocr_extracted_data?.total === "number" && (
            <span className="tabular-nums text-ink">
              {formatCurrency(item.ocr_extracted_data.total)}
            </span>
          )}
        </div>
        <p className="text-xs text-ink-muted">
          {item.cardholder_name ? `${item.cardholder_name} · ` : ""}
          {item.ocr_extracted_data?.transaction_date
            ? formatDate(item.ocr_extracted_data.transaction_date)
            : "No receipt date"}
        </p>
      </div>

      {/* Candidate suggestions */}
      <div className="min-h-0 space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          Suggested transactions
        </p>
        {item.candidates && item.candidates.length > 0 ? (
          <ul className="space-y-1.5">
            {item.candidates.map((c) => (
              <CandidateRow
                key={c.id}
                candidate={c}
                disabled={busy}
                onAssign={() => onAssign(c.id)}
              />
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-xs text-ink-muted">
            No automatic suggestions. Use the picker below to file it.
          </p>
        )}
      </div>

      {/* Assign-to-transaction picker */}
      <div className="min-h-0 flex-1 space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          Assign to transaction
          {item.cardholder_name ? ` · ${item.cardholder_name}` : ""}
        </p>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={ensurePicker}
            placeholder="Search vendor, amount, or date…"
            className="pl-8"
          />
        </div>
        <div className="scroll-thin max-h-48 space-y-1 overflow-y-auto">
          {pickerLoading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-2 text-xs text-ink-muted">
              {picker.length === 0
                ? "Click the box to load open transactions."
                : "No open transactions match."}
            </p>
          ) : (
            filtered.map((t) => (
              <button
                key={t.id}
                disabled={busy}
                onClick={() => onAssign(t.id)}
                className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-ink">
                    {t.vendor}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {formatDate(t.transaction_date)}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block tabular-nums text-ink">
                    {formatCurrency(t.amount)}
                  </span>
                  <CcStatusBadge status={t.receipt_status} />
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Send back */}
      <div className="space-y-1.5 border-t border-line pt-3">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          Send back to cardholder
        </p>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Optional note (e.g. wrong card, illegible total)…"
          rows={2}
          className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle outline-none focus:border-accent focus:ring-1 focus:ring-ring"
        />
        <div className="flex items-center justify-between gap-2">
          {onDelete ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => onDelete()}
              className="text-ink-subtle hover:text-danger"
              title="Delete this dropped receipt"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            disabled={busy}
            onClick={() => onReturn(note.trim())}
          >
            <Undo2 className="h-3.5 w-3.5" />
            Send back
          </Button>
        </div>
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  disabled,
  onAssign,
}: {
  candidate: CandidateTx;
  disabled?: boolean;
  onAssign: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm",
      )}
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{candidate.vendor}</p>
        <p className="text-xs text-ink-muted">
          {formatDate(candidate.transaction_date)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="tabular-nums text-ink">
          {formatCurrency(candidate.amount)}
        </span>
        <Button size="sm" disabled={disabled} onClick={onAssign}>
          <Check className="h-3.5 w-3.5" />
          Assign
        </Button>
      </div>
    </li>
  );
}
