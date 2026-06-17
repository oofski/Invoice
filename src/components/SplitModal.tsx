"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Input } from "@/components/ui/primitives";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { api, ApiClientError } from "@/lib/api-client";
import { toast } from "@/components/ui/Toast";
import { formatCurrency } from "@/lib/utils";
import type { LineItemRow } from "@/lib/types";

interface Row {
  amount: string;
  gl_category: string;
}

export function SplitModal({
  lineItem,
  open,
  onClose,
  onSplit,
}: {
  lineItem: LineItemRow | null;
  open: boolean;
  onClose: () => void;
  onSplit: () => void;
}) {
  const parentAmount = Number(lineItem?.amount ?? 0);
  const [rows, setRows] = useState<Row[]>([
    { amount: "", gl_category: "" },
    { amount: "", gl_category: "" },
  ]);
  const [saving, setSaving] = useState(false);

  const sum = rows.reduce((acc, r) => acc + (parseFloat(r.amount) || 0), 0);
  const remaining = parentAmount - sum;
  const balanced = Math.abs(remaining) < 0.005;
  const allCategorized = rows.every((r) => r.gl_category);

  function reset() {
    setRows([
      { amount: "", gl_category: "" },
      { amount: "", gl_category: "" },
    ]);
  }

  async function submit() {
    if (!lineItem) return;
    if (!balanced) {
      toast.error("Split amounts must equal the line total");
      return;
    }
    if (!allCategorized) {
      toast.error("Choose a GL category for each split");
      return;
    }
    setSaving(true);
    try {
      await api.post(`/api/line-items/${lineItem.id}/split`, {
        allocations: rows.map((r) => ({
          amount: parseFloat(r.amount),
          gl_category: r.gl_category,
        })),
      });
      toast.success("Line item split");
      reset();
      onSplit();
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiClientError ? err.message : "Failed to split",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Split line item"
      className="max-w-2xl"
    >
      {lineItem && (
        <div className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <p className="font-medium text-slate-900">{lineItem.description}</p>
            <p className="text-slate-500">
              Total to allocate: {formatCurrency(parentAmount)}
            </p>
          </div>

          <div className="space-y-2">
            {rows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={row.amount}
                  onChange={(e) =>
                    setRows((prev) =>
                      prev.map((r, idx) =>
                        idx === i ? { ...r, amount: e.target.value } : r,
                      ),
                    )
                  }
                  className="w-32"
                />
                <div className="flex-1">
                  <GLCategorySelect
                    value={row.gl_category || null}
                    includeReview={false}
                    onChange={(v) =>
                      setRows((prev) =>
                        prev.map((r, idx) =>
                          idx === i ? { ...r, gl_category: v } : r,
                        ),
                      )
                    }
                  />
                </div>
                <button
                  onClick={() =>
                    setRows((prev) =>
                      prev.length > 2
                        ? prev.filter((_, idx) => idx !== i)
                        : prev,
                    )
                  }
                  disabled={rows.length <= 2}
                  className="text-slate-400 hover:text-red-500 disabled:opacity-30"
                  aria-label="Remove split"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setRows((prev) => [...prev, { amount: "", gl_category: "" }])
            }
          >
            <Plus className="h-4 w-4" />
            Add split
          </Button>

          <div
            className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm ${
              balanced
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-700"
            }`}
          >
            <span>Allocated: {formatCurrency(sum)}</span>
            <span>
              {balanced
                ? "Balanced ✓"
                : `Remaining: ${formatCurrency(remaining)}`}
            </span>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              loading={saving}
              disabled={!balanced || !allCategorized}
            >
              Save split
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
