import { useMemo, useState } from "react";
import { Split, PencilLine, Plus, Trash2 } from "lucide-react";
import { ConfidenceBadge } from "@/components/ui/Badges";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { SplitModal } from "@/components/SplitModal";
import { Button, Input } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency, cn } from "@/lib/utils";
import type { LineItemRow } from "@/lib/types";

/**
 * Line items table — doubles as the GL Coding Editor (Brief §08). When
 * `editable`, each row exposes the 47-category dropdown and a split button;
 * REQUIRES_MANUAL_REVIEW rows are highlighted red.
 */
export function LineItemsTable({
  lineItems,
  editable,
  onChange,
  invoiceBusiness,
  canAdd = false,
  canDelete = false,
  invoiceId,
}: {
  lineItems: LineItemRow[];
  editable: boolean;
  onChange: () => void;
  /** Invoice's business entity; used as a fallback for a line's GL number. */
  invoiceBusiness?: string | null;
  /**
   * Accountant/admin only — when true (and a non-exported invoice), an
   * "+ Add line item" affordance is shown below the table. Executives /
   * ApprovalView never pass this (GL is never theirs to add).
   */
  canAdd?: boolean;
  /**
   * Accountant/admin only — when true (and a non-exported invoice), each root
   * line shows a delete affordance. Kept separate from `editable` so the
   * ApprovalView's exec editing never exposes destructive line deletes.
   */
  canDelete?: boolean;
  /** Required when `canAdd` — target invoice for the add-line POST. */
  invoiceId?: string;
}) {
  const [splitTarget, setSplitTarget] = useState<LineItemRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Group split children beneath their parent for display.
  const { roots, childrenByParent } = useMemo(() => {
    const childrenByParent = new Map<string, LineItemRow[]>();
    const roots: LineItemRow[] = [];
    for (const li of lineItems) {
      if (li.split_parent_id) {
        const arr = childrenByParent.get(li.split_parent_id) ?? [];
        arr.push(li);
        childrenByParent.set(li.split_parent_id, arr);
      } else {
        roots.push(li);
      }
    }
    return { roots, childrenByParent };
  }, [lineItems]);

  async function updateCategory(li: LineItemRow, category: string) {
    setSavingId(li.id);
    try {
      await api.patch(`/api/line-items/${li.id}`, { gl_category: category });
      toast.success("GL category updated");
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update");
    } finally {
      setSavingId(null);
    }
  }

  async function deleteLine(li: LineItemRow) {
    const label = li.description ? `"${li.description}"` : "this line item";
    if (
      !window.confirm(
        `Delete ${label}? This removes it from the invoice and updates the total. This cannot be undone.`,
      )
    )
      return;
    setDeletingId(li.id);
    try {
      await api.del(`/api/line-items/${li.id}`);
      toast.success("Line item deleted");
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete line");
    } finally {
      setDeletingId(null);
    }
  }

  function renderRow(li: LineItemRow, isChild = false) {
    const isSplitParent = childrenByParent.has(li.id);
    const review = li.requires_review;
    return (
      <tr
        key={li.id}
        className={cn(
          "border-b border-line align-top",
          review && "bg-danger-soft-bg",
          isChild && "bg-surface-2/70",
        )}
      >
        <td className={cn("px-4 py-3", isChild && "pl-8")}>
          <div className="text-sm text-ink">
            {isChild && <span className="mr-1 text-ink-subtle">↳</span>}
            {li.description}
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-subtle">
            {li.logic_path && <span>{li.logic_path}</span>}
            {li.manually_overridden && (
              <span className="inline-flex items-center gap-0.5 text-accent">
                <PencilLine className="h-3 w-3" /> overridden
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 text-right text-sm font-medium text-ink tabular-nums">
          {formatCurrency(Number(li.amount ?? 0))}
        </td>
        <td className="min-w-[220px] px-4 py-3">
          {editable && !isSplitParent ? (
            <GLCategorySelect
              value={li.gl_category}
              disabled={savingId === li.id}
              entity={li.business ?? invoiceBusiness}
              onChange={(v) => updateCategory(li, v)}
            />
          ) : (
            <span
              className={cn(
                "text-sm",
                review ? "font-medium text-danger" : "text-ink-muted",
              )}
            >
              {isSplitParent
                ? "— split —"
                : li.gl_category
                  ? `${li.gl_account_number ? `${li.gl_account_number} · ` : ""}${li.gl_category}`
                  : "—"}
            </span>
          )}
        </td>
        <td className="px-4 py-3">
          <ConfidenceBadge level={li.confidence_level} />
        </td>
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1">
            {editable && !isChild && !isSplitParent && (
              <Button variant="ghost" size="sm" onClick={() => setSplitTarget(li)}>
                <Split className="h-3.5 w-3.5" />
                Split
              </Button>
            )}
            {canDelete && !isChild && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteLine(li)}
                loading={deletingId === li.id}
                disabled={deletingId === li.id}
                title="Delete this line item"
                className="text-ink-subtle hover:text-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
              <th className="px-4 py-2.5 font-medium">Description</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 font-medium">GL Category</th>
              <th className="px-4 py-2.5 font-medium">Confidence</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {roots.map((li) => (
              <FragmentRows
                key={li.id}
                parent={li}
                childRows={childrenByParent.get(li.id) ?? []}
                renderRow={renderRow}
              />
            ))}
          </tbody>
        </table>
      </div>

      {canAdd && invoiceId && (
        <div className="border-t border-line px-4 py-3">
          <Button variant="ghost" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            Add line item
          </Button>
        </div>
      )}

      <SplitModal
        lineItem={splitTarget}
        open={!!splitTarget}
        onClose={() => setSplitTarget(null)}
        onSplit={onChange}
      />

      {canAdd && invoiceId && (
        <AddLineItemModal
          open={addOpen}
          onClose={() => setAddOpen(false)}
          invoiceId={invoiceId}
          invoiceBusiness={invoiceBusiness}
          onAdded={onChange}
        />
      )}
    </>
  );
}

/**
 * Modal for an accountant/admin to add a missing line item (e.g. a line the
 * extractor missed, surfaced by the reconciliation banner). Amount may be
 * negative (a discount/credit). Leaving the GL category blank lets the server
 * auto-suggest one. Accountant/admin only; the server returns 409 if the
 * invoice has already been exported.
 */
function AddLineItemModal({
  open,
  onClose,
  invoiceId,
  invoiceBusiness,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  invoiceBusiness?: string | null;
  onAdded: () => void;
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [glCategory, setGlCategory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const parsedAmount = Number(amount);
  const amountValid = amount.trim() !== "" && Number.isFinite(parsedAmount);

  function reset() {
    setDescription("");
    setAmount("");
    setGlCategory(null);
  }

  async function submit() {
    if (!amountValid) return;
    setSaving(true);
    try {
      await api.post(`/api/invoices/${invoiceId}/line-items`, {
        description: description.trim() || undefined,
        amount: parsedAmount,
        gl_category: glCategory || undefined,
      });
      toast.success("Line item added");
      reset();
      onClose();
      onAdded();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add line");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add line item"
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Description
          </label>
          <Input
            autoFocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Shipping, missed product line…"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Amount
          </label>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00 (negative for a discount/credit)"
          />
          <p className="mt-1 text-xs text-ink-subtle">
            Use a negative amount for a discount or credit.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            GL category{" "}
            <span className="font-normal text-ink-subtle">
              (optional — leave blank to let the system suggest one)
            </span>
          </label>
          <GLCategorySelect
            value={glCategory}
            entity={invoiceBusiness}
            includeReview={false}
            onChange={(v) => setGlCategory(v)}
          />
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => {
            reset();
            onClose();
          }}
        >
          Cancel
        </Button>
        <Button onClick={submit} loading={saving} disabled={!amountValid}>
          Add line item
        </Button>
      </div>
    </Modal>
  );
}

function FragmentRows({
  parent,
  childRows,
  renderRow,
}: {
  parent: LineItemRow;
  childRows: LineItemRow[];
  renderRow: (li: LineItemRow, isChild?: boolean) => React.ReactNode;
}) {
  return (
    <>
      {renderRow(parent)}
      {childRows.map((c) => renderRow(c, true))}
    </>
  );
}
