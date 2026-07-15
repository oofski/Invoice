import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CopyCheck, Trash2, AlertTriangle, ExternalLink } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { StatusBadge } from "@/components/ui/Badges";
import { toast } from "@/components/ui/Toast";
import { api, ApiError, type DuplicateGroup, type DuplicateInvoice } from "@/lib/api";
import { cn, formatCurrency, formatDate } from "@/lib/utils";

/**
 * v1.9.6 — the admin/accountant "Review scan". Runs the server-side duplicate
 * scan (same vendor + invoice#, or same vendor + amount when un-numbered),
 * shows each cluster with the OLDEST invoice tagged as the keeper, lets the
 * user tick the extras, and hard-deletes the selection. The delete goes through
 * the api client's mutating path, which fires the invoice-refresh bus, so the
 * list + dashboard update on their own.
 */
export function ReviewScanModal({
  open,
  onClose,
  onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [scanned, setScanned] = useState(0);
  const [capped, setCapped] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.scanDuplicates();
      setGroups(res.groups);
      setScanned(res.scanned);
      setCapped(res.capped);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)run the scan each time the modal opens.
  useEffect(() => {
    if (open) void runScan();
  }, [open, runScan]);

  /** The extras in a group = every invoice except the oldest (index 0), and
   *  never an already-exported one (those are protected from a one-click sweep). */
  function extrasOf(group: DuplicateGroup): string[] {
    return group.invoices.slice(1).filter((i) => !i.exported_at).map((i) => i.id);
  }

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectExtras = (group: DuplicateGroup) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of extrasOf(group)) next.add(id);
      return next;
    });

  const selectAllExtras = () =>
    setSelected(() => {
      const next = new Set<string>();
      for (const g of groups) for (const id of extrasOf(g)) next.add(id);
      return next;
    });

  const totalInvoices = useMemo(
    () => groups.reduce((n, g) => n + g.count, 0),
    [groups],
  );

  // How many of the selected ids are already exported to QuickBooks (a warning,
  // not a block — the single-invoice delete has never blocked on this).
  const exportedSelected = useMemo(() => {
    const byId = new Map<string, DuplicateInvoice>();
    for (const g of groups) for (const i of g.invoices) byId.set(i.id, i);
    let n = 0;
    for (const id of selected) if (byId.get(id)?.exported_at) n++;
    return n;
  }, [groups, selected]);

  async function handleDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const msg =
      `Delete ${ids.length} invoice${ids.length === 1 ? "" : "s"} permanently?` +
      (exportedSelected > 0
        ? `\n\n${exportedSelected} of them ${exportedSelected === 1 ? "is" : "are"} already exported to QuickBooks — deleting removes the record here.`
        : "") +
      "\n\nThis removes their PDFs, line items and approvals. This cannot be undone.";
    if (!window.confirm(msg)) return;
    setDeleting(true);
    try {
      const res = await api.bulkDeleteInvoices(ids);
      toast.success(
        `Deleted ${res.deleted} invoice${res.deleted === 1 ? "" : "s"}` +
          (res.skipped > 0 ? ` · ${res.skipped} already gone` : ""),
      );
      onDeleted?.();
      await runScan(); // re-scan so the groups reflect what's left
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Review scan — duplicate invoices"
      className="h-[88vh] w-[95vw] max-w-[1000px]"
      fill
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Intro / summary bar */}
        <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">
            Invoices that look like duplicates — grouped by{" "}
            <span className="font-medium text-ink">vendor + invoice #</span>, or by{" "}
            <span className="font-medium text-ink">vendor + amount</span> when a
            number is missing. The oldest in each group is kept; tick the extras to
            delete.
          </p>
          {!loading && groups.length > 0 && (
            <div className="flex shrink-0 items-center gap-3 text-xs">
              <button
                type="button"
                onClick={selectAllExtras}
                className="font-medium text-accent hover:underline"
              >
                Select extras in all groups
              </button>
              {selected.size > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="font-medium text-ink-muted hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div className="scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {loading ? (
            <div className="flex h-full items-center justify-center py-16">
              <Spinner />
              <span className="ml-2 text-sm text-ink-muted">Scanning invoices…</span>
            </div>
          ) : error ? (
            <div className="py-10 text-center">
              <p className="text-sm text-danger">{error}</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={runScan}>
                Try again
              </Button>
            </div>
          ) : groups.length === 0 ? (
            <EmptyState
              icon={<CopyCheck className="h-8 w-8" />}
              title="No likely duplicates found"
              description={`Scanned ${scanned} invoice${scanned === 1 ? "" : "s"} — nothing looks like a duplicate.`}
            />
          ) : (
            groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                selected={selected}
                onToggle={toggle}
                onSelectExtras={() => selectExtras(g)}
              />
            ))
          )}
        </div>

        {/* Footer */}
        <div className="mt-3 flex shrink-0 items-center justify-between gap-2 border-t border-line pt-3">
          <div className="text-xs text-ink-muted">
            {groups.length > 0 && (
              <>
                {groups.length} group{groups.length === 1 ? "" : "s"} ·{" "}
                {totalInvoices} invoices
                {capped && " · scan capped at 4,000"}
                {exportedSelected > 0 && (
                  <span className="ml-2 inline-flex items-center gap-1 text-warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {exportedSelected} exported selected
                  </span>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="danger"
              onClick={handleDelete}
              loading={deleting}
              disabled={selected.size === 0}
            >
              <Trash2 className="h-4 w-4" />
              Delete {selected.size > 0 ? `${selected.size} ` : ""}selected
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function GroupCard({
  group,
  selected,
  onToggle,
  onSelectExtras,
}: {
  group: DuplicateGroup;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectExtras: () => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              group.reason === "number"
                ? "bg-danger-soft-bg text-danger"
                : "bg-surface-2 text-ink-muted ring-1 ring-inset ring-line",
            )}
          >
            {group.reason === "number" ? "Same invoice #" : "Same amount"}
          </span>
          <span className="truncate text-sm font-medium text-ink" title={group.vendor}>
            {group.vendor}
          </span>
          <span className="shrink-0 text-xs text-ink-muted">
            {group.reason === "number"
              ? `#${group.invoice_number}`
              : formatCurrency(Number(group.total_amount))}{" "}
            · {group.count} copies
          </span>
        </div>
        <button
          type="button"
          onClick={onSelectExtras}
          className="shrink-0 text-xs font-medium text-accent hover:underline"
        >
          Select extras (keep oldest)
        </button>
      </div>
      <ul className="divide-y divide-line">
        {group.invoices.map((inv, i) => {
          const isKeeper = i === 0;
          const checked = selected.has(inv.id);
          return (
            <li
              key={inv.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2 text-sm",
                checked && "bg-danger-soft-bg/50",
              )}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(inv.id)}
                className="h-4 w-4 shrink-0 rounded border-line accent-accent"
                aria-label={`Select invoice ${inv.invoice_number}`}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-ink">#{inv.invoice_number}</span>
                  {isKeeper && (
                    <span className="shrink-0 rounded bg-success-soft-bg px-1.5 py-0.5 text-[10px] font-medium text-success">
                      Oldest — kept
                    </span>
                  )}
                  {inv.exported_at && (
                    <span className="shrink-0 rounded bg-warning-soft-bg px-1.5 py-0.5 text-[10px] font-medium text-warning">
                      Exported
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-ink-muted">
                  <span>{formatDate(inv.inv_date)}</span>
                  <span>·</span>
                  <span>{inv.business || "—"}</span>
                  {inv.class && inv.class !== "None" && (
                    <>
                      <span>·</span>
                      <span>{inv.class}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>added {formatDate(inv.created_at)}</span>
                </div>
              </div>
              <span className="shrink-0 tabular-nums text-ink">
                {formatCurrency(Number(inv.total_amount))}
              </span>
              <StatusBadge status={inv.status} />
              <Link
                to={`/invoices/${inv.id}`}
                className="shrink-0 text-ink-subtle hover:text-accent"
                title="Open invoice"
              >
                <ExternalLink className="h-4 w-4" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
