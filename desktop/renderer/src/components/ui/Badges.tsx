import { cn } from "@/lib/utils";
import {
  INVOICE_STATUS,
  CONFIDENCE_LEVEL,
  type InvoiceStatus,
  type ConfidenceLevel,
} from "@/lib/constants";

const STATUS_STYLES: Record<string, string> = {
  [INVOICE_STATUS.PROCESSING]: "bg-slate-100 text-slate-600",
  [INVOICE_STATUS.PENDING_APPROVAL]: "bg-amber-100 text-amber-700",
  [INVOICE_STATUS.APPROVED]: "bg-emerald-100 text-emerald-700",
  [INVOICE_STATUS.REJECTED]: "bg-red-100 text-red-700",
  [INVOICE_STATUS.EXPORTED]: "bg-blue-100 text-blue-700",
};

const STATUS_LABELS: Record<string, string> = {
  [INVOICE_STATUS.PROCESSING]: "Processing",
  [INVOICE_STATUS.PENDING_APPROVAL]: "Awaiting Approval",
  [INVOICE_STATUS.APPROVED]: "Approved",
  [INVOICE_STATUS.REJECTED]: "Rejected",
  [INVOICE_STATUS.EXPORTED]: "Exported",
};

export function StatusBadge({ status }: { status: InvoiceStatus | string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_STYLES[status] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// Confidence badges — Brief §08: HIGH (gray), MEDIUM (amber), LOW (red),
// MANUAL_REVIEW (red pulse).
const CONF_STYLES: Record<string, string> = {
  [CONFIDENCE_LEVEL.HIGH]: "bg-slate-100 text-slate-600",
  [CONFIDENCE_LEVEL.MEDIUM]: "bg-amber-100 text-amber-700",
  [CONFIDENCE_LEVEL.LOW]: "bg-red-100 text-red-700",
  [CONFIDENCE_LEVEL.MANUAL_REVIEW]:
    "bg-red-600 text-white animate-review-pulse",
};

export function ConfidenceBadge({
  level,
}: {
  level: ConfidenceLevel | string | null;
}) {
  if (!level) return <span className="text-xs text-slate-400">—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        CONF_STYLES[level] ?? "bg-slate-100 text-slate-600",
      )}
    >
      {level === CONFIDENCE_LEVEL.MANUAL_REVIEW ? "Review" : level}
    </span>
  );
}
