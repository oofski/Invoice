import { StatusBadge } from "@/components/ui/Badges";
import { formatCurrency, formatDate } from "@/lib/utils";
import { APPROVAL_STATUS } from "@/lib/constants";
import type { InvoiceWithRelations } from "@/lib/types";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-400">
        {label}
      </dt>
      <dd className="text-sm font-medium text-slate-800">{value ?? "—"}</dd>
    </div>
  );
}

export function InvoiceDataPanel({
  invoice,
}: {
  invoice: InvoiceWithRelations;
}) {
  const approval = invoice.approval;
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">{invoice.vendor}</h2>
          <p className="text-sm text-slate-500">#{invoice.invoice_number}</p>
        </div>
        <StatusBadge status={invoice.status} />
      </div>

      <div className="rounded-lg bg-slate-50 p-3 text-center">
        <p className="text-xs uppercase tracking-wide text-slate-400">
          Total Amount
        </p>
        <p className="text-3xl font-bold text-slate-900">
          {formatCurrency(Number(invoice.total_amount))}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Field
          label="Subtotal"
          value={formatCurrency(Number(invoice.subtotal ?? 0))}
        />
        <Field
          label="Sales Tax"
          value={formatCurrency(Number(invoice.sales_tax ?? 0))}
        />
        <Field label="Invoice Date" value={formatDate(invoice.inv_date)} />
        <Field label="Due Date" value={formatDate(invoice.due_date)} />
        <Field label="Entity" value={invoice.business} />
        <Field
          label="Class"
          value={invoice.class && invoice.class !== "None" ? invoice.class : "—"}
        />
        <Field label="Approver" value={invoice.approved_by} />
        <Field
          label="Submission"
          value={
            <span className="capitalize">
              {invoice.submission_type?.toLowerCase()}
            </span>
          }
        />
      </dl>

      {approval && approval.status !== APPROVAL_STATUS.PENDING && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            approval.status === APPROVAL_STATUS.APPROVED
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          <p className="font-medium">
            {approval.status === APPROVAL_STATUS.APPROVED
              ? "Approved"
              : "Rejected"}{" "}
            {approval.decided_at && `· ${formatDate(approval.decided_at)}`}
          </p>
          {approval.decision_note && (
            <p className="mt-1 italic">“{approval.decision_note}”</p>
          )}
        </div>
      )}
    </div>
  );
}
