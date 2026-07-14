import { Split, Check } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { APPROVAL_STATUS } from "@/lib/constants";
import type { InvoiceWithRelations } from "@/lib/types";

/**
 * v1.9.3 (Feature E) — approval provenance. When an invoice carries a split, a
 * reviewer (accountant/admin) needs to see WHAT the split was, not just that one
 * exists. Renders the per-target breakdown for every split shape:
 *   QUICK_EVEN / CUSTOM → the `invoice_allocations` slices (business · class → $)
 *   PER_LINE            → a rollup of the line items by business/class
 * and, when the invoice has been decided, who approved it and when (plus any
 * approval comment). Renders nothing when the invoice is unsplit.
 */

interface SplitRow {
  business: string;
  cls: string;
  amount: number;
  percentage?: number | null;
}

function splitTypeLabel(t: string | null): string {
  switch (t) {
    case "QUICK_EVEN":
      return "Even split";
    case "CUSTOM":
      return "Custom split";
    case "PER_LINE":
      return "Per-line split";
    default:
      return "Split";
  }
}

/** Roll the (non-child) line items up into business/class buckets — the shape a
 *  PER_LINE split produces, which has no `invoice_allocations` rows of its own. */
function perLineBuckets(invoice: InvoiceWithRelations): SplitRow[] {
  const map = new Map<string, SplitRow>();
  for (const li of invoice.line_items) {
    if (li.split_parent_id) continue; // skip synthetic split children
    if (!li.business) continue;
    const cls = li.class ?? "";
    const key = `${li.business}|${cls}`;
    const amt = Number(li.amount ?? 0);
    const cur = map.get(key);
    if (cur) cur.amount += amt;
    else map.set(key, { business: li.business, cls, amount: amt });
  }
  return [...map.values()];
}

export function SplitSummary({ invoice }: { invoice: InvoiceWithRelations }) {
  if (!invoice.split_type) return null;

  const rows: SplitRow[] =
    invoice.split_type === "PER_LINE"
      ? perLineBuckets(invoice)
      : (invoice.allocations ?? []).map((a) => ({
          business: a.business,
          cls: a.class,
          amount: a.amount,
          percentage: a.percentage,
        }));

  const approval = invoice.approval;
  const decided = approval?.status === APPROVAL_STATUS.APPROVED && approval.decided_at;

  return (
    <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3 text-left">
      <div className="flex items-center gap-1.5 text-sm font-semibold text-ink">
        <Split className="h-4 w-4 text-accent" />
        {splitTypeLabel(invoice.split_type)}
      </div>

      {rows.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {rows.map((r, i) => (
            <li
              key={`${r.business}-${r.cls}-${i}`}
              className="flex items-center justify-between gap-2 text-sm"
            >
              <span className="min-w-0 truncate text-ink-muted">
                {r.business}
                {r.cls && r.cls !== "None" ? ` · ${r.cls}` : ""}
              </span>
              <span className="shrink-0 tabular-nums text-ink">
                {formatCurrency(Number(r.amount))}
                {typeof r.percentage === "number" ? (
                  <span className="ml-1 text-xs text-ink-subtle">
                    ({Math.round(r.percentage)}%)
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-subtle">
          Split applied — per-line coding is in the line-by-line detail below.
        </p>
      )}

      {decided && (
        <div className="mt-3 flex items-start gap-1.5 border-t border-line pt-2 text-xs text-ink-muted">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
          <span>
            Approved
            {invoice.approved_by ? ` by ${invoice.approved_by}` : ""} ·{" "}
            {formatDate(approval!.decided_at)}
            {approval!.decision_note ? (
              <span className="mt-0.5 block italic text-ink-subtle">
                “{approval!.decision_note}”
              </span>
            ) : null}
          </span>
        </div>
      )}
    </div>
  );
}
