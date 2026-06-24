import { cn } from "@/lib/utils";
import {
  INVOICE_STATUS,
  CONFIDENCE_LEVEL,
  type InvoiceStatus,
  type ConfidenceLevel,
} from "@/lib/constants";

const STATUS_STYLES: Record<string, string> = {
  [INVOICE_STATUS.PROCESSING]: "bg-surface-2 text-ink-muted",
  [INVOICE_STATUS.PENDING_APPROVAL]: "bg-warning-soft-bg text-warning-soft-fg",
  [INVOICE_STATUS.NEEDS_REVIEW]: "bg-warning-soft-bg text-warning-soft-fg",
  [INVOICE_STATUS.APPROVED]: "bg-success-soft-bg text-success-soft-fg",
  [INVOICE_STATUS.REJECTED]: "bg-danger-soft-bg text-danger-soft-fg",
  [INVOICE_STATUS.EXPORTED]: "bg-info-soft-bg text-info-soft-fg",
};

const STATUS_LABELS: Record<string, string> = {
  [INVOICE_STATUS.PROCESSING]: "Processing",
  [INVOICE_STATUS.PENDING_APPROVAL]: "Awaiting Approval",
  [INVOICE_STATUS.NEEDS_REVIEW]: "Needs Routing Review",
  [INVOICE_STATUS.APPROVED]: "Approved",
  [INVOICE_STATUS.REJECTED]: "Rejected",
  [INVOICE_STATUS.EXPORTED]: "Exported",
};

export function StatusBadge({ status }: { status: InvoiceStatus | string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_STYLES[status] ?? "bg-surface-2 text-ink-muted",
      )}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

// Confidence badges — Brief §08: HIGH (gray), MEDIUM (amber), LOW (red),
// MANUAL_REVIEW (red pulse).
const CONF_STYLES: Record<string, string> = {
  [CONFIDENCE_LEVEL.HIGH]: "bg-surface-2 text-ink-muted",
  [CONFIDENCE_LEVEL.MEDIUM]: "bg-warning-soft-bg text-warning-soft-fg",
  [CONFIDENCE_LEVEL.LOW]: "bg-danger-soft-bg text-danger-soft-fg",
  [CONFIDENCE_LEVEL.MANUAL_REVIEW]: "bg-review text-white animate-review-pulse",
};

export function ConfidenceBadge({
  level,
}: {
  level: ConfidenceLevel | string | null;
}) {
  if (!level) return <span className="text-xs text-ink-subtle">—</span>;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        CONF_STYLES[level] ?? "bg-surface-2 text-ink-muted",
      )}
    >
      {level === CONFIDENCE_LEVEL.MANUAL_REVIEW ? "Review" : level}
    </span>
  );
}
