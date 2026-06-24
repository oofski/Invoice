import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { type ReactNode } from "react";

const TONES = {
  slate: "border-line-strong",
  amber: "border-warning",
  red: "border-danger",
  emerald: "border-success",
  blue: "border-accent",
} as const;

const VALUE_TONES = {
  slate: "text-ink",
  amber: "text-warning",
  red: "text-danger",
  emerald: "text-success",
  blue: "text-accent",
} as const;

export function StatCard({
  label,
  value,
  tone = "slate",
  icon,
  href,
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONES;
  icon?: ReactNode;
  href?: string;
}) {
  const inner = (
    <div
      className={cn(
        "rounded-xl border-l-4 bg-surface p-4 shadow-sm transition-shadow",
        TONES[tone],
        href && "hover:shadow-md",
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          {label}
        </p>
        {icon && <span className="text-ink-subtle">{icon}</span>}
      </div>
      <p
        className={cn(
          "mt-1 text-2xl font-bold tabular-nums",
          VALUE_TONES[tone],
        )}
      >
        {value}
      </p>
    </div>
  );
  return href ? <Link to={href}>{inner}</Link> : inner;
}
