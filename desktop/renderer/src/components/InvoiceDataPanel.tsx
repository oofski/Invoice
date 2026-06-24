import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { StatusBadge } from "@/components/ui/Badges";
import { BusinessClassSelect } from "@/components/BusinessClassSelect";
import { Button, Select } from "@/components/ui/primitives";
import { formatCurrency, formatDate } from "@/lib/utils";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import {
  APPROVAL_STATUS,
  APPROVERS,
  INVOICE_STATUS,
} from "@/lib/constants";
import type { InvoiceWithRelations } from "@/lib/types";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-muted">
        {label}
      </dt>
      <dd className="text-sm font-medium text-ink">{value ?? "—"}</dd>
    </div>
  );
}

interface RerouteResponse {
  invoice: InvoiceWithRelations;
  approver: string;
  emailed: boolean;
  emailConfigured: boolean;
}

interface SuggestResponse {
  approver: string;
  logic: string;
}

export function InvoiceDataPanel({
  invoice,
  canEditRouting = false,
  onRerouted,
}: {
  invoice: InvoiceWithRelations;
  /** Accountant/admin on a non-exported invoice may re-route (Feature A). */
  canEditRouting?: boolean;
  /** Called after a successful re-route so the parent can refetch. */
  onRerouted?: () => void;
}) {
  const approval = invoice.approval;

  // -- Inline edit-routing state -------------------------------------------
  const [editing, setEditing] = useState(false);
  const [business, setBusiness] = useState(invoice.business ?? "");
  const [klass, setKlass] = useState(invoice.class ?? "");
  const [approver, setApprover] = useState(invoice.approved_by ?? "");
  const [suggestion, setSuggestion] = useState<SuggestResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const suggestTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset the editor whenever the invoice changes (e.g. after a refetch) so the
  // form always reflects the persisted routing the next time it is opened.
  useEffect(() => {
    setBusiness(invoice.business ?? "");
    setKlass(invoice.class ?? "");
    setApprover(invoice.approved_by ?? "");
    setSuggestion(null);
  }, [invoice.id, invoice.business, invoice.class, invoice.approved_by]);

  // Debounced approver suggestion whenever business/class changes while editing.
  useEffect(() => {
    if (!editing || !business) return;
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    suggestTimer.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ business });
        if (klass) params.set("class", klass);
        const res = await api.get<SuggestResponse>(
          `/api/invoices/${invoice.id}/suggest-approver?${params.toString()}`,
        );
        setSuggestion(res);
        // Pre-fill the approver with the suggestion (still editable below).
        if (res.approver) setApprover(res.approver);
      } catch {
        // Suggestion is best-effort — leave the current approver untouched.
        setSuggestion(null);
      }
    }, 400);
    return () => {
      if (suggestTimer.current) clearTimeout(suggestTimer.current);
    };
  }, [editing, business, klass, invoice.id]);

  function startEdit() {
    setBusiness(invoice.business ?? "");
    setKlass(invoice.class ?? "");
    setApprover(invoice.approved_by ?? "");
    setSuggestion(null);
    setEditing(true);
  }

  function cancelEdit() {
    setBusiness(invoice.business ?? "");
    setKlass(invoice.class ?? "");
    setApprover(invoice.approved_by ?? "");
    setSuggestion(null);
    setEditing(false);
  }

  async function save() {
    if (!business || !approver) {
      toast.error("Pick a business and an approver before saving.");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<RerouteResponse>(
        `/api/invoices/${invoice.id}/reroute`,
        { business, class: klass || undefined, approved_by: approver },
      );
      const who = res.approver;
      if (!res.emailConfigured) {
        toast.success(`Re-routed to ${who} (email not configured)`);
      } else if (res.emailed) {
        toast.success(`Re-routed to ${who}, notified by email`);
      } else {
        toast.success(`Re-routed to ${who} (couldn't email)`);
      }
      setEditing(false);
      onRerouted?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Re-route failed");
    } finally {
      setSaving(false);
    }
  }

  const needsRouting = invoice.status === INVOICE_STATUS.NEEDS_REVIEW;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-ink">{invoice.vendor}</h2>
          <p className="text-sm text-ink-muted">#{invoice.invoice_number}</p>
        </div>
        <StatusBadge status={invoice.status} />
      </div>

      <div className="rounded-lg bg-surface-2 p-3 text-center">
        <p className="text-xs uppercase tracking-wide text-ink-muted">
          Total Amount
        </p>
        <p className="text-3xl font-bold text-ink tabular-nums">
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

      {/* Edit routing (accountant/admin, non-exported) ----------------------- */}
      {canEditRouting && !editing && (
        <Button variant="secondary" size="sm" onClick={startEdit}>
          <Pencil className="h-4 w-4" />
          Edit routing
        </Button>
      )}

      {canEditRouting && editing && (
        <div className="space-y-3 rounded-lg border border-line bg-surface-2 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Re-route invoice
          </p>
          <div>
            <p className="mb-1 text-xs text-ink-muted">Business / Class</p>
            <BusinessClassSelect
              business={business || null}
              class={klass || null}
              onChange={(b, k) => {
                setBusiness(b);
                setKlass(k);
              }}
              disabled={saving}
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-ink-muted">Approver</p>
            <Select
              value={approver}
              disabled={saving}
              onChange={(e) => setApprover(e.target.value)}
            >
              <option value="" disabled>
                Approver…
              </option>
              {APPROVERS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            {suggestion?.approver && (
              <p className="mt-1 text-xs text-accent">
                Suggested: {suggestion.approver}
                {suggestion.logic ? ` (${suggestion.logic})` : ""}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={cancelEdit}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={save}
              loading={saving}
              disabled={!business || !approver}
            >
              Save routing
            </Button>
          </div>
        </div>
      )}

      {/* Manual-review note from the exec (NEEDS_REVIEW) --------------------- */}
      {needsRouting && approval?.decision_note && (
        <div className="rounded-lg border border-warning-soft-fg/30 bg-warning-soft-bg p-3 text-sm text-warning-soft-fg">
          <p className="font-medium">Sent for manual review</p>
          <p className="mt-1 italic">“{approval.decision_note}”</p>
        </div>
      )}

      {approval && approval.status !== APPROVAL_STATUS.PENDING && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            approval.status === APPROVAL_STATUS.APPROVED
              ? "border-success bg-success-soft-bg text-success-soft-fg"
              : "border-danger bg-danger-soft-bg text-danger-soft-fg"
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
