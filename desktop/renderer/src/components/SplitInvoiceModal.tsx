import { useMemo, useState, useCallback } from "react";
import { Plus, Trash2, CheckSquare } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Input } from "@/components/ui/primitives";
import { BusinessClassSelect } from "@/components/BusinessClassSelect";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency, cn } from "@/lib/utils";
import { BUSINESS_CLASSES, ITEM_TYPES } from "@/lib/constants";

const ITEM_TYPE_SET = new Set<string>(ITEM_TYPES);
import type {
  InvoiceWithRelations,
  SplitAllocationInput,
  SplitAllocationsResponse,
  SplitLineInput,
} from "@/lib/types";

type Mode = "even" | "lines";

const TOTAL_TOLERANCE = 0.05;

interface AllocationRow {
  business: string;
  class: string;
  /** Raw text of the percent input so the field can be edited freely. */
  percent: string;
}

interface LineState {
  business: string;
  class: string;
  type: string;
  customType: string;
}

/**
 * Invoice-level split modal. Two modes:
 *  - "even": a flexible cross-entity % builder. The user adds allocation rows
 *    (any entity + class, e.g. a Chicago slice on an IBW invoice) with explicit
 *    percentages that must total 100, saved via POST /:id/split-allocations.
 *  - "lines": assign each line item its own business/class + item type via
 *    POST /:id/split-lines.
 * A Clear split action (DELETE /:id/split) is shown once a split exists.
 */
export function SplitInvoiceModal({
  invoice,
  open,
  onClose,
  onDone,
}: {
  invoice: InvoiceWithRelations;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("even");
  const [busy, setBusy] = useState(false);

  const [rows, setRows] = useState<AllocationRow[]>(() => seedRows(invoice));
  const [lineState, setLineState] = useState<Record<string, LineState>>(() =>
    seedLineState(invoice),
  );

  // Per-line multi-select state for bulk apply
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusiness, setBulkBusiness] = useState("");
  const [bulkClass, setBulkClass] = useState("");
  const [bulkType, setBulkType] = useState("");
  const [bulkCustomType, setBulkCustomType] = useState("");

  const lineItems = useMemo(
    () => invoice.line_items.filter((li) => !li.split_parent_id),
    [invoice.line_items],
  );

  const allSelected =
    lineItems.length > 0 && lineItems.every((li) => selectedIds.has(li.id));
  const someSelected = selectedIds.size > 0;

  const toggleLine = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === lineItems.length
        ? new Set()
        : new Set(lineItems.map((li) => li.id)),
    );
  }, [lineItems]);

  function applyBulk() {
    if (selectedIds.size === 0) return;
    setLineState((prev) => {
      const next = { ...prev };
      for (const id of selectedIds) {
        const cur = next[id] ?? { business: "", class: "", type: "", customType: "" };
        next[id] = {
          business: bulkBusiness || cur.business,
          class: bulkClass || cur.class,
          type: bulkType || cur.type,
          customType:
            (bulkType === "Other" ? bulkCustomType : undefined) ?? cur.customType,
        };
      }
      return next;
    });
    setSelectedIds(new Set());
    setBulkBusiness("");
    setBulkClass("");
    setBulkType("");
    setBulkCustomType("");
  }

  // ----------------------------------------------------- allocation builder
  const total = useMemo(
    () => rows.reduce((sum, r) => sum + (parseFloat(r.percent) || 0), 0),
    [rows],
  );
  const totalOk = Math.abs(total - 100) <= TOTAL_TOLERANCE;
  const rowsComplete = rows.every((r) => r.business && r.class);
  const canSaveAllocations = rows.length > 0 && totalOk && rowsComplete;

  function setRow(idx: number, patch: Partial<AllocationRow>) {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    );
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      { business: invoice.business ?? "", class: "", percent: "0" },
    ]);
  }

  function removeRow(idx: number) {
    setRows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function saveAllocations() {
    if (!canSaveAllocations) return;
    const allocations: SplitAllocationInput[] = rows.map((r) => ({
      business: r.business,
      class: r.class,
      percentage: parseFloat(r.percent) || 0,
    }));
    setBusy(true);
    try {
      await api.post<SplitAllocationsResponse>(
        `/api/invoices/${invoice.id}/split-allocations`,
        { allocations },
      );
      toast.success("Invoice split across targets");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Split failed");
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------- per-line helpers
  function setLine(id: string, patch: Partial<LineState>) {
    setLineState((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] ?? { business: "", class: "", type: "", customType: "" }),
        ...patch,
      },
    }));
  }

  async function splitLines() {
    const lines: SplitLineInput[] = lineItems
      .map((li) => {
        const state = lineState[li.id];
        const business = state?.business || invoice.business || "";
        const klass = state?.class || invoice.class || "";
        const line: SplitLineInput = {
          lineItemId: li.id,
          business,
          class: klass,
        };
        if (state?.type) {
          line.type = state.type;
          if (state.type === "Other" && state.customType.trim()) {
            line.customType = state.customType.trim();
          }
        }
        return line;
      })
      .filter((l) => l.business && l.class);

    if (lines.length === 0) {
      toast.error("Assign a business and class to at least one line");
      return;
    }
    setBusy(true);
    try {
      await api.post<{ ok: true }>(`/api/invoices/${invoice.id}/split-lines`, {
        lines,
      });
      toast.success("Per-line split saved");
      onDone();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Split failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearSplit() {
    setBusy(true);
    try {
      await api.del<{ ok: true }>(`/api/invoices/${invoice.id}/split`);
      toast.success("Split cleared");
      onDone();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to clear split",
      );
    } finally {
      setBusy(false);
    }
  }

  // Per-line mode gets a tall, near-fullscreen modal whose table fills the
  // available height (footer stays pinned, table is the only scroll region) so
  // the whole sheet is visible without scrolling the dialog. Quick split keeps
  // the classic auto-height modal.
  const isLines = mode === "lines";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split invoice"
      className={cn(isLines ? "h-[90vh] w-[95vw] max-w-[1600px]" : "max-w-6xl")}
      fill={isLines}
    >
      <div className={isLines ? "flex min-h-0 flex-1 flex-col gap-4" : "space-y-4"}>
        {/* Mode toggle */}
        <div className="inline-flex shrink-0 rounded-lg border border-line bg-surface-2 p-0.5 text-sm">
          <button
            onClick={() => setMode("even")}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              mode === "even"
                ? "bg-surface text-ink shadow-sm"
                : "text-ink-muted hover:text-ink",
            )}
          >
            Quick split
          </button>
          <button
            onClick={() => setMode("lines")}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              mode === "lines"
                ? "bg-surface text-ink shadow-sm"
                : "text-ink-muted hover:text-ink",
            )}
          >
            Per-line split
          </button>
        </div>

        {/* ----------------------------------------- Flexible % allocation */}
        {mode === "even" && (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Split this invoice by percentage across any entities and classes.
              Add a target for each slice — totals must add up to 100%.
            </p>

            <div className="space-y-2">
              {rows.map((row, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <BusinessClassSelect
                    className="flex-1"
                    business={row.business || null}
                    class={row.class || null}
                    disabled={busy}
                    onChange={(b, c) => setRow(idx, { business: b, class: c })}
                  />
                  <div className="relative w-24 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step="any"
                      inputMode="decimal"
                      value={row.percent}
                      disabled={busy}
                      onChange={(e) => setRow(idx, { percent: e.target.value })}
                      className="pr-6 text-right tabular-nums"
                      aria-label="Percentage"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-sm text-ink-subtle">
                      %
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(idx)}
                    disabled={busy}
                    aria-label="Remove target"
                    className="shrink-0 rounded-md p-2 text-ink-subtle transition-colors hover:bg-danger-soft-bg hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between">
              <Button
                variant="secondary"
                size="sm"
                onClick={addRow}
                disabled={busy}
              >
                <Plus className="h-3.5 w-3.5" />
                Add target
              </Button>

              <div
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium tabular-nums",
                  totalOk
                    ? "bg-success-soft-bg text-success-soft-fg"
                    : "bg-warning-soft-bg text-warning-soft-fg",
                )}
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    totalOk ? "bg-success" : "bg-warning",
                  )}
                />
                Total {total.toFixed(2)}%
                {!totalOk && (
                  <span className="font-normal text-warning">
                    (must be 100%)
                  </span>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={saveAllocations}
                loading={busy}
                disabled={!canSaveAllocations}
              >
                Save split
              </Button>
            </div>
          </div>
        )}

        {/* ------------------------------------------------- Per-line split */}
        {mode === "lines" && (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <p className="shrink-0 text-sm text-ink-muted">
              Assign a business, class and type to each line item. Lines left
              unset default to the invoice&apos;s business/class. Select
              multiple rows to bulk-apply settings.
            </p>

            {/* Bulk-apply bar — visible when ≥1 row is checked */}
            {someSelected && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-selected-border bg-selected-bg px-3 py-2">
                <span className="text-xs font-semibold text-accent">
                  <CheckSquare className="mr-1 inline h-3.5 w-3.5" />
                  {selectedIds.size} selected — apply to all:
                </span>
                <BusinessClassSelect
                  className="shrink-0"
                  business={bulkBusiness || null}
                  class={bulkClass || null}
                  disabled={busy}
                  onChange={(b, c) => {
                    setBulkBusiness(b);
                    setBulkClass(c);
                  }}
                />
                <select
                  value={bulkType}
                  disabled={busy}
                  onChange={(e) => setBulkType(e.target.value)}
                  className="rounded-lg border border-line bg-surface text-ink placeholder:text-ink-subtle px-2 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-ring disabled:bg-surface-2"
                >
                  <option value="">Type…</option>
                  {ITEM_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {bulkType === "Other" && (
                  <Input
                    placeholder="Custom type"
                    value={bulkCustomType}
                    disabled={busy}
                    onChange={(e) => setBulkCustomType(e.target.value)}
                    className="w-32"
                  />
                )}
                <Button size="sm" onClick={applyBulk} disabled={busy}>
                  Apply to {selectedIds.size}
                </Button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="ml-auto text-xs text-accent hover:text-accent-hover"
                >
                  Clear selection
                </button>
              </div>
            )}

            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-lg border border-line">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-surface-2">
                  <tr className="border-b border-line text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    {/* Select-all checkbox */}
                    <th className="w-8 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        className="h-4 w-4 cursor-pointer rounded border-line accent-accent"
                        aria-label="Select all lines"
                      />
                    </th>
                    <th className="px-3 py-2 font-medium">Description</th>
                    <th className="px-3 py-2 text-right font-medium">Amount</th>
                    <th className="px-3 py-2 font-medium">Business / Class</th>
                    <th className="px-3 py-2 font-medium">Type</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => {
                    const state = lineState[li.id] ?? {
                      business: "",
                      class: "",
                      type: "",
                      customType: "",
                    };
                    const isChecked = selectedIds.has(li.id);
                    return (
                      <tr
                        key={li.id}
                        className={cn(
                          "border-b border-line",
                          isChecked && "bg-selected-bg",
                        )}
                      >
                        {/* Row checkbox */}
                        <td className="px-3 py-2 align-top">
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleLine(li.id)}
                            className="h-4 w-4 cursor-pointer rounded border-line accent-accent"
                            aria-label={`Select ${li.description ?? "line"}`}
                          />
                        </td>
                        <td className="px-3 py-2 align-top text-ink-muted">
                          {li.description ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right align-top font-medium text-ink tabular-nums">
                          {formatCurrency(Number(li.amount ?? 0))}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <BusinessClassSelect
                            business={state.business || null}
                            class={state.class || null}
                            disabled={busy}
                            onChange={(b, c) =>
                              setLine(li.id, { business: b, class: c })
                            }
                          />
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex items-center gap-2">
                            <select
                              value={state.type}
                              disabled={busy}
                              onChange={(e) =>
                                setLine(li.id, { type: e.target.value })
                              }
                              className="rounded-lg border border-line bg-surface text-ink placeholder:text-ink-subtle px-2 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-ring disabled:bg-surface-2"
                            >
                              <option value="">Type…</option>
                              {ITEM_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                            {state.type === "Other" && (
                              <Input
                                placeholder="Custom type"
                                value={state.customType}
                                disabled={busy}
                                onChange={(e) =>
                                  setLine(li.id, {
                                    customType: e.target.value,
                                  })
                                }
                                className="w-32"
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex shrink-0 justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={splitLines} loading={busy}>
                Save split
              </Button>
            </div>
          </div>
        )}

        {/* Clear split — shown when a split already exists */}
        {invoice.split_type && (
          <div className="flex shrink-0 items-center justify-between rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
            <span className="text-ink-muted">
              This invoice already has a split.
            </span>
            <Button
              variant="danger"
              size="sm"
              onClick={clearSplit}
              loading={busy}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear split
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Seed the flexible allocation builder from the invoice's business classes,
 * split evenly. The remainder is carried on the last row so the percentages
 * total exactly 100. Falls back to a single empty row.
 */
function seedRows(invoice: InvoiceWithRelations): AllocationRow[] {
  const business = invoice.business ?? "";
  const classes = business ? (BUSINESS_CLASSES[business] ?? []) : [];
  if (classes.length === 0) {
    return [{ business, class: invoice.class ?? "", percent: "100" }];
  }
  const base = Math.round(100 / classes.length);
  return classes.map((klass, i) => {
    const isLast = i === classes.length - 1;
    const pct = isLast ? 100 - base * (classes.length - 1) : base;
    return { business, class: klass, percent: String(pct) };
  });
}

function seedLineState(
  invoice: InvoiceWithRelations,
): Record<string, LineState> {
  const seed: Record<string, LineState> = {};
  for (const li of invoice.line_items) {
    if (li.split_parent_id) continue;
    // A stored type that isn't one of the standard options is treated as a
    // custom "Other" value so the dropdown + free-text input round-trip.
    const stored = li.item_type ?? "";
    const known = ITEM_TYPE_SET.has(stored);
    seed[li.id] = {
      business: li.business ?? invoice.business ?? "",
      class: li.class ?? invoice.class ?? "",
      type: stored ? (known ? stored : "Other") : "",
      customType: stored && !known ? stored : "",
    };
  }
  return seed;
}
