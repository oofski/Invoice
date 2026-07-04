/**
 * KpiCard — a clean stat card (QuickBooks-style): small muted label on top, a
 * large preformatted value below, and an optional sub-line (delta / context).
 * Purely presentational — the caller formats `value` and `sublabel`.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type KpiTone = "default" | "accent" | "positive" | "warning";

const VALUE_TONE: Record<KpiTone, string> = {
  default: "text-ink",
  accent: "text-accent",
  positive: "text-success",
  warning: "text-warning",
};

const ICON_TONE: Record<KpiTone, string> = {
  default: "text-ink-subtle",
  accent: "text-accent",
  positive: "text-success",
  warning: "text-warning",
};

export interface KpiCardProps {
  /** Small uppercase label above the value. */
  label: string;
  /** Preformatted headline value (e.g. "$12.4k", "1,204", "87%"). */
  value: string;
  /** Optional secondary line under the value (delta, share, context). */
  sublabel?: ReactNode;
  /** Color accent for the value + icon. */
  tone?: KpiTone;
  /** Optional leading/trailing icon (e.g. a lucide-react icon). */
  icon?: ReactNode;
  className?: string;
}

export function KpiCard({
  label,
  value,
  sublabel,
  tone = "default",
  icon,
  className,
}: KpiCardProps) {
  return (
    <Card className={cn("p-4", className)}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          {label}
        </p>
        {icon && <span className={cn("shrink-0", ICON_TONE[tone])}>{icon}</span>}
      </div>
      <p
        className={cn(
          "mt-2 text-2xl font-semibold leading-tight tabular-nums",
          VALUE_TONE[tone],
        )}
      >
        {value}
      </p>
      {sublabel && (
        <p className="mt-1 text-xs text-ink-subtle">{sublabel}</p>
      )}
    </Card>
  );
}
