import { useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/primitives";
import { BusinessClassSelect } from "@/components/BusinessClassSelect";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency, cn } from "@/lib/utils";
import { BUSINESS_CLASSES } from "@/lib/constants";
import type { InvoiceWithRelations, InvoiceAllocation } from "@/lib/types";

type Mode = "even" | "lines";

interface LineState {
  business: string;
  class: string;
}

/**
 * Invoice-level split modal. Two modes:
 *  - "even": fan the invoice evenly across the business's classes (server
 *    computes the allocations) via POST /:id/split-even.
 *  - "lines": assign each line item its own business/class via
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
  const [allocations, setAllocations] = useState<InvoiceAllocation[] | null>(
    null,
  );

  const classes = invoice.business
    ? (BUSINESS_CLASSES[invoice.business] ?? [])
    : [];
  const singleClass = classes.length < 2;
  const evenPct = classes.length > 0 ? 100 / classes.length : 0;

  // Per-line working state, seeded from each line's existing business/class or
  // the invoice's defaults.
  const [lineState, setLineState] = useState<Record<string, LineState>>(() =>
    seedLineState(invoice),
  );

  const lineItems = useMemo(
    () => invoice.line_items.filter((li) => !li.split_parent_id),
    [invoice.line_items],
  );

  function setLine(id: string, business: string, klass: string) {
    setLineState((prev) => ({ ...prev, [id]: { business, class: klass } }));
  }

  async function splitEven() {
    setBusy(true);
    try {
      const res = await api.post<{ allocations: InvoiceAllocation[] }>(
        `/api/invoices/${invoice.id}/split-even`,
      );
      setAllocations(res.allocations);
      toast.success("Invoice split evenly across classes");
      onDone();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Split failed");
    } finally {
      setBusy(false);
    }
  }

  async function splitLines() {
    const lines = lineItems
      .map((li) => {
        const state = lineState[li.id];
        const business = state?.business || invoice.business || "";
        const klass = state?.class || invoice.class || "";
        return { lineItemId: li.id, business, class: klass };
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
      setAllocations(null);
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split invoice"
      className="max-w-2xl"
    >
      <div className="space-y-4">
        {/* Mode toggle */}
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-sm">
          <button
            onClick={() => setMode("even")}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              mode === "even"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700",
            )}
          >
            Quick even split
          </button>
          <button
            onClick={() => setMode("lines")}
            className={cn(
              "rounded-md px-3 py-1.5 font-medium transition-colors",
              mode === "lines"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700",
            )}
          >
            Per-line split
          </button>
        </div>

        {/* ----------------------------------------------- Quick even split */}
        {mode === "even" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Splits this invoice evenly across all classes of{" "}
              <span className="font-medium text-slate-900">
                {invoice.business ?? "—"}
              </span>
              .
            </p>

            {singleClass ? (
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
                This business has a single class — nothing to split.
              </div>
            ) : allocations ? (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2 font-medium">Class</th>
                      <th className="px-4 py-2 text-right font-medium">%</th>
                      <th className="px-4 py-2 text-right font-medium">
                        Amount
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allocations.map((a) => (
                      <tr key={a.id} className="border-b border-slate-100">
                        <td className="px-4 py-2 text-slate-800">{a.class}</td>
                        <td className="px-4 py-2 text-right text-slate-600">
                          {a.percentage != null
                            ? `${a.percentage.toFixed(2)}%`
                            : "—"}
                        </td>
                        <td className="px-4 py-2 text-right font-medium text-slate-900">
                          {formatCurrency(Number(a.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="px-4 py-2 font-medium">Class</th>
                      <th className="px-4 py-2 text-right font-medium">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {classes.map((c) => (
                      <tr key={c} className="border-b border-slate-100">
                        <td className="px-4 py-2 text-slate-800">{c}</td>
                        <td className="px-4 py-2 text-right text-slate-600">
                          {evenPct.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              {!allocations && (
                <Button
                  onClick={splitEven}
                  loading={busy}
                  disabled={singleClass}
                >
                  Split evenly
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ------------------------------------------------- Per-line split */}
        {mode === "lines" && (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">
              Assign a business and class to each line item. Lines left unset
              default to the invoice&apos;s business/class.
            </p>

            <div className="scroll-thin overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2 font-medium">Description</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                    <th className="px-4 py-2 font-medium">Business / Class</th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((li) => {
                    const state = lineState[li.id] ?? {
                      business: "",
                      class: "",
                    };
                    return (
                      <tr key={li.id} className="border-b border-slate-100">
                        <td className="px-4 py-2 align-top text-slate-800">
                          {li.description ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right align-top font-medium text-slate-900">
                          {formatCurrency(Number(li.amount ?? 0))}
                        </td>
                        <td className="px-4 py-2">
                          <BusinessClassSelect
                            business={state.business || null}
                            class={state.class || null}
                            disabled={busy}
                            onChange={(b, c) => setLine(li.id, b, c)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-end gap-2">
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
          <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-600">
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

function seedLineState(
  invoice: InvoiceWithRelations,
): Record<string, LineState> {
  const seed: Record<string, LineState> = {};
  for (const li of invoice.line_items) {
    if (li.split_parent_id) continue;
    seed[li.id] = {
      business: li.business ?? invoice.business ?? "",
      class: li.class ?? invoice.class ?? "",
    };
  }
  return seed;
}
