"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
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
}: {
  invoices: QueueInvoice[];
  basePath?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (invoices.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />;
  }

  return (
    <div className="overflow-x-auto scroll-thin">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-2.5 font-medium">Vendor</th>
            <th className="px-4 py-2.5 font-medium">Entity</th>
            <th className="px-4 py-2.5 font-medium">Class</th>
            <th className="px-4 py-2.5 text-right font-medium">Amount</th>
            <th className="px-4 py-2.5 font-medium">Approver</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Age</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const needsReview = (inv.review_count ?? 0) > 0;
            return (
              <tr
                key={inv.id}
                className={cn(
                  "border-b border-slate-100 transition-colors hover:bg-slate-50",
                  needsReview && "bg-red-50/60 hover:bg-red-50",
                )}
              >
                <td className="px-4 py-3">
                  <Link
                    href={`${basePath}/${inv.id}`}
                    className="font-medium text-slate-900 hover:text-blue-600"
                  >
                    {inv.vendor}
                  </Link>
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    #{inv.invoice_number}
                    {needsReview && (
                      <span className="inline-flex items-center gap-0.5 font-medium text-red-600">
                        <AlertTriangle className="h-3 w-3" />
                        {inv.review_count} review
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-slate-700">{inv.business ?? "—"}</td>
                <td className="px-4 py-3 text-slate-500">
                  {inv.class && inv.class !== "None" ? inv.class : "—"}
                </td>
                <td className="px-4 py-3 text-right font-medium text-slate-900">
                  {formatCurrency(Number(inv.total_amount))}
                </td>
                <td className="px-4 py-3 text-slate-700">
                  {inv.approved_by ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={inv.status} />
                </td>
                <td className="px-4 py-3 text-slate-500">
                  {ageLabel(inv.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
