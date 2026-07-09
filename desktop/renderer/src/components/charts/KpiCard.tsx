/**
 * KpiCard — a polished, SaaS-style stat card: a small muted uppercase label, a
 * prominent preformatted value, an optional sub-line (delta / context), and a
 * subtle tinted icon chip. Tone drives a restrained accent on the value + chip.
 * Purely presentational — the caller formats `value` and `sublabel`. All colors
 * are existing app tokens.
 */
import type { ReactNode } from "react";
import { Card } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type KpiTone = "default" | "accent" | "positive" | "warning";

/** Restrained accent applied to the headline value. */
const VALUE_TONE: Record<KpiTone, string> = {
  default: "text-ink",
  accent: "text-accent",
  positive: "text-success",
  warning: "text-warning",
};

/** Soft, token-only icon chip per tone (background + border + foreground). */
const CHIP_TONE: Record<KpiTone, string> = {
  default: "border-line bg-surface-2 text-ink-subtle",
  accent: "border-selected-border bg-selected-bg text-accent",
  positive: "border-success-soft-fg/20 bg-success-soft-bg text-success-soft-fg",
  warning: "border-warning-soft-fg/25 bg-warning-soft-bg text-warning-soft-fg",
};

export interface KpiCardProps {
  /** Small uppercase label above the value. */
  label: string;
  /** Preformatted headline value (e.g. "$12.4k", "1,204", "87%"). */
  value: string;
  /** Optional secondary line under the value (delta, share, context). */
  sublabel?: ReactNode;
  /** Color accent for the value + icon chip. */
  tone?: KpiTone;
  /** Optional icon rendered inside the tinted chip (e.g. a lucide-react icon). */
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
    <Card
      className={cn(
        "flex min-h-[7rem] flex-col justify-between gap-3 p-5 transition-shadow hover:shadow-[0_1px_2px_rgba(46,47,48,0.05),0_10px_28px_-12px_rgba(46,47,48,0.18)]",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold uppercase leading-tight tracking-[0.14em] text-ink-subtle">
          {label}
        </p>
        {icon && (
          <span
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
              CHIP_TONE[tone],
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p
          className={cn(
            "text-2xl font-semibold leading-tight tracking-tight tabular-nums",
            VALUE_TONE[tone],
          )}
        >
          {value}
        </p>
        {sublabel && (
          <p className="mt-1.5 text-xs leading-snug text-ink-muted">{sublabel}</p>
        )}
      </div>
    </Card>
  );
}
