import { Link } from "react-router-dom";
import { AlertTriangle, ArchiveRestore, MapPin, Download } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badges";
import { EmptyState } from "@/components/ui/primitives";
import { formatCurrency, ageLabel, cn } from "@/lib/utils";
import type { InvoiceRow } from "@/lib/types";

export type QueueInvoice = InvoiceRow & { review_count?: number };

export function InvoiceTable({
  invoices,
  basePath = "/invoices",
  emptyTitle = "No invoices",
  emptyDescription,
  onUnarchive,
  unarchivingId,
  onDownload,
  downloadingId,
}: {
  invoices: QueueInvoice[];
  basePath?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  /** When provided, renders an Archived/Unarchive column (admin only). */
  onUnarchive?: (id: string) => void;
  /** Id currently being unarchived (disables its button). */
  unarchivingId?: string | null;
  /**
   * When provided, renders a per-row "Download PDF" action (rows with a PDF).
   * Read-only convenience — the parent owns the fetch/save; nothing is mutated.
   */
  onDownload?: (inv: QueueInvoice) => void;
  /** Id currently being downloaded (disables its button). */
  downloadingId?: string | null;
}) {
  if (invoices.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
            <th className="px-4 py-2.5 font-medium">Vendor</th>
            <th className="px-4 py-2.5 font-medium">Entity</th>
            <th className="px-4 py-2.5 font-medium">Class</th>
            <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            <th className="px-4 py-2.5 font-medium">Approver</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Age</th>
            {onDownload && <th className="px-4 py-2.5 font-medium" />}
            {onUnarchive && <th className="px-4 py-2.5 font-medium" />}
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const needsReview = (inv.review_count ?? 0) > 0;
            return (
              <tr
                key={inv.id}
                className={cn(
                  "border-b border-line transition-colors hover:bg-surface-2",
                  needsReview && "bg-danger-soft-bg/70 hover:bg-danger-soft-bg",
                )}
              >
                <td className="px-4 py-3">
                  <Link
                    to={`${basePath}/${inv.id}`}
                    className="font-medium text-ink hover:text-accent"
                  >
                    {inv.vendor}
                  </Link>
                  <div className="flex items-center gap-1.5 text-xs text-ink-subtle">
                    #{inv.invoice_number}
                    {needsReview && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-danger">
                        <AlertTriangle className="h-3 w-3" />
                        {inv.review_count} review
                      </span>
                    )}
                    {inv.location_ambiguous && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-warning">
                        <MapPin className="h-3 w-3" />
                        Location?
                      </span>
                    )}
                    {inv.reconciliation_delta != null && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-danger">
                        Σ≠Total
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {inv.business ?? "—"}
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {inv.class && inv.class !== "None" ? inv.class : "—"}
                </td>
                <td className="px-4 py-3 text-right font-medium text-ink tabular-nums">
                  {formatCurrency(Number(inv.total_amount))}
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {inv.approved_by ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="px-4 py-3 text-ink-muted">
                  {ageLabel(inv.created_at)}
                </td>
                {onDownload && (
                  <td className="px-4 py-3 text-right">
                    {inv.has_pdf ? (
                      <button
                        type="button"
                        onClick={() => onDownload(inv)}
                        disabled={downloadingId === inv.id}
                        title="Download the invoice PDF"
                        className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-50"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {downloadingId === inv.id ? "…" : "PDF"}
                      </button>
                    ) : (
                      <span className="text-xs text-ink-subtle">—</span>
                    )}
                  </td>
                )}
                {onUnarchive && (
                  <td className="px-4 py-3 text-right">
                    {inv.archived_at ? (
                      <button
                        type="button"
                        onClick={() => onUnarchive(inv.id)}
                        disabled={unarchivingId === inv.id}
                        className="inline-flex items-center gap-1 font-medium text-accent hover:underline disabled:opacity-50"
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                        {unarchivingId === inv.id ? "Unarchiving…" : "Unarchive"}
                      </button>
                    ) : (
                      <span className="text-xs text-ink-subtle">—</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
