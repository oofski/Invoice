import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2, Check, Search, Undo2, Trash2, Pencil } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { ReceiptDownloadFab } from "@/components/cc/ReceiptDownloadFab";
import { LineCodingModal } from "@/components/cc/LineCodingModal";
import {
  ccApi,
  ccEntityLabel,
  type CandidateTx,
  type CcTransaction,
  type InboxItem,
  type ReceiptLine,
} from "@/cc/ccApi";

/**
 * Whether the carried split can be faithfully edited in LineCodingModal, which
 * models ONE entity per line. A mobile quick-split can pack several entities into
 * a single "Receipt total" line — that can't round-trip (a location would bind to
 * the wrong entity), so such splits stay view-only.
 */
function splitEditableInLineModal(lines: ReceiptLine[] | undefined): boolean {
  if (!lines?.length) return false;
  for (const line of lines) {
    const entities = new Set((line.allocations ?? []).map((a) => a.entity_name));
    if (entities.size > 1) return false;
  }
  return true;
}

/** Flatten the executive's carried split into display rows (entity · location). */
function pendingSplitRows(
  ps: InboxItem["pending_split"],
): { label: string; amount: number }[] {
  if (!ps) return [];
  if (ps.lines?.length) {
    const rows: { label: string; amount: number }[] = [];
    for (const line of ps.lines) {
      for (const a of line.allocations ?? []) {
        const loc = a.location && a.location !== a.entity_name ? ` · ${a.location}` : "";
        rows.push({ label: `${ccEntityLabel(a.entity_name)}${loc}`, amount: a.amount });
      }
    }
    return rows;
  }
  if (ps.entity_splits?.length) {
    return ps.entity_splits.map((s) => ({
      label: ccEntityLabel(s.entity_name),
      amount: s.amount,
    }));
  }
  return [];
}

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
  fileName,
}: {
  inboxId: string | null;
  fileType?: string | null;
  /** Original file name, used only to name the downloaded copy. */
  fileName?: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [isImage, setIsImage] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setBlob(null);
    setError(false);

    if (!inboxId) return;

    setLoading(true);
    ccApi
      .getInboxBlob(inboxId)
      .then((blob) => {
        if (!active) return;
        const ct = (blob.type || fileType || "").toLowerCase();
        setIsImage(ct.startsWith("image/"));
        setBlob(blob);
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
  return (
    <div className="relative h-full">
      {isImage ? (
        <div className="scroll-thin flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
          <img
            src={objectUrl}
            alt="Receipt"
            className="max-h-full max-w-full rounded shadow"
          />
        </div>
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
            </div>
          }
        >
          <PdfViewer url={objectUrl} />
        </Suspense>
      )}
      <ReceiptDownloadFab blob={blob} fileName={fileName} />
    </div>
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
  onPendingSplitChanged,
}: {
  item: InboxItem;
  busy?: boolean;
  onAssign: (transactionId: string) => void | Promise<void>;
  onReturn: (note: string) => void | Promise<void>;
  onDelete?: () => void | Promise<void>;
  /** Called after the accountant edits the executive's carried split. */
  onPendingSplitChanged?: () => void;
}) {
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [splitOpen, setSplitOpen] = useState(false);
  // v1.9.1: when a receipt was mis-resolved (or belongs to another cardholder),
  // let the manager search across ALL cardholders instead of only the resolved
  // one — so any unmatched receipt can still be looked up and attached.
  const [allCardholders, setAllCardholders] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [picker, setPicker] = useState<CcTransaction[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  // Reset the per-item state whenever the selected item changes.
  useEffect(() => {
    setNote("");
    setSearch("");
    setPicker([]);
    setEngaged(false);
    setAllCardholders(false);
    setSplitOpen(false);
  }, [item.id]);

  // The executive's carried split (parsed by the worker) + whether it's editable.
  const splitRows = pendingSplitRows(item.pending_split);
  const ocrTotal = item.ocr_extracted_data?.total ?? null;
  const canEditSplit =
    !!item.pending_split?.lines?.length &&
    typeof ocrTotal === "number" &&
    ocrTotal > 0 &&
    splitEditableInLineModal(item.pending_split.lines);

  // v1.9.1: real server-side transaction search (mirrors CcTransactionsPage).
  // Runs once the picker is engaged (first focus). Searches vendor server-side
  // (q=), can drop the cardholder scope, and returns ANY status so a receipt can
  // be attached to a transaction the auto-matcher's window missed.
  useEffect(() => {
    if (!engaged) return;
    let active = true;
    const timer = setTimeout(async () => {
      setPickerLoading(true);
      try {
        const res = await ccApi.listTransactions({
          q: search.trim() || undefined,
          cardholder_id: allCardholders
            ? undefined
            : item.cardholder_id ?? undefined,
          per_page: 25,
        });
        if (active) setPicker((res.transactions ?? []).filter((t) => !t.is_payment));
      } catch (err) {
        if (active)
          toast.error(
            err instanceof ApiError ? err.message : "Failed to load transactions",
          );
      } finally {
        if (active) setPickerLoading(false);
      }
    }, search ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engaged, search, allCardholders, item.cardholder_id]);

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

      {/* Executive's carried split — view + edit (incl. location) before filing */}
      {splitRows.length > 0 && (
        <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
              Executive's split
            </p>
            {canEditSplit && (
              <button
                onClick={() => setSplitOpen(true)}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline disabled:opacity-50"
                title="Review / edit the split (including location) before filing"
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
            )}
          </div>
          <ul className="space-y-0.5">
            {splitRows.map((r, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-2 text-xs text-ink-muted"
              >
                <span className="truncate" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 tabular-nums text-ink">
                  {formatCurrency(r.amount)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-ink-subtle">
            Submitted from the app — applied automatically when you file it.
          </p>
        </div>
      )}

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

      {/* Assign-to-transaction picker (server-side search) */}
      <div className="min-h-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
            Assign to transaction
            {!allCardholders && item.cardholder_name
              ? ` · ${item.cardholder_name}`
              : ""}
          </p>
          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted"
            title="Search every cardholder, not just the one this receipt resolved to"
          >
            <input
              type="checkbox"
              checked={allCardholders}
              onChange={(e) => {
                setAllCardholders(e.target.checked);
                setEngaged(true);
              }}
              className="h-3.5 w-3.5 rounded border-line accent-accent"
            />
            All cardholders
          </label>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => setEngaged(true)}
            placeholder="Search any transaction by vendor…"
            className="pl-8"
          />
        </div>
        <div className="scroll-thin max-h-48 space-y-1 overflow-y-auto">
          {pickerLoading ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : picker.length === 0 ? (
            <p className="px-1 py-2 text-xs text-ink-muted">
              {!engaged
                ? "Click the box to look up a transaction to attach."
                : "No transactions match — try a different vendor or search all cardholders."}
            </p>
          ) : (
            picker.map((t) => (
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
                    {allCardholders && t.cardholder_name
                      ? ` · ${t.cardholder_name}`
                      : ""}
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

      {/* Edit the executive's carried split (incl. location) before filing.
          Reconciles to the receipt's OCR total; saved back to pending_splits. */}
      {canEditSplit && item.pending_split?.lines && (
        <LineCodingModal
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          amount={ocrTotal as number}
          vendor={item.ocr_extracted_data?.merchant_name || item.file_name}
          lines={item.pending_split.lines}
          onSubmit={async (lines: ReceiptLine[]) => {
            await ccApi.patchInboxPendingSplits(item.id, { lines });
            toast.success("Split updated");
            onPendingSplitChanged?.();
          }}
        />
      )}
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
