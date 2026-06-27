import { cn } from "@/lib/utils";
import type { ReceiptStatus } from "@/cc/ccApi";

/**
 * Receipt-status badge (ccrms-plan §8.4 color contract):
 *   PENDING       -> red
 *   UPLOADED      -> yellow
 *   RECEIVED      -> green
 *   NOT_REQUIRED  -> gray
 *   WAIVED        -> gray
 * Uses the app's soft semantic tokens so it matches the existing badge style.
 */
const STYLES: Record<ReceiptStatus, string> = {
  PENDING: "bg-danger-soft-bg text-danger-soft-fg",
  UPLOADED: "bg-warning-soft-bg text-warning-soft-fg",
  RECEIVED: "bg-success-soft-bg text-success-soft-fg",
  NOT_REQUIRED: "bg-surface-2 text-ink-muted",
  WAIVED: "bg-surface-2 text-ink-muted",
};

const LABELS: Record<ReceiptStatus, string> = {
  PENDING: "Pending",
  UPLOADED: "Uploaded",
  RECEIVED: "Received",
  NOT_REQUIRED: "Not required",
  WAIVED: "Waived",
};

export function CcStatusBadge({
  status,
  className,
}: {
  status: ReceiptStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        STYLES[status] ?? "bg-surface-2 text-ink-muted",
        className,
      )}
    >
      {LABELS[status] ?? status}
    </span>
  );
}
