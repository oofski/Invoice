import { useMemo, useState } from "react";
import { Split, PencilLine } from "lucide-react";
import { ConfidenceBadge } from "@/components/ui/Badges";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { SplitModal } from "@/components/SplitModal";
import { Button } from "@/components/ui/primitives";
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
}: {
  lineItems: LineItemRow[];
  editable: boolean;
  onChange: () => void;
  /** Invoice's business entity; used as a fallback for a line's GL number. */
  invoiceBusiness?: string | null;
}) {
  const [splitTarget, setSplitTarget] = useState<LineItemRow | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

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
          {editable && !isChild && !isSplitParent && (
            <Button variant="ghost" size="sm" onClick={() => setSplitTarget(li)}>
              <Split className="h-3.5 w-3.5" />
              Split
            </Button>
          )}
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

      <SplitModal
        lineItem={splitTarget}
        open={!!splitTarget}
        onClose={() => setSplitTarget(null)}
        onSplit={onChange}
      />
    </>
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
