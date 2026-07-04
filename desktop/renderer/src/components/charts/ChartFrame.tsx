/**
 * Shared, presentational chart chrome: an empty-state-aware responsive wrapper,
 * a consistent tooltip card, and small legend "chips". Used by every chart in
 * this folder so they stay visually consistent. No data or API here.
 */
import type { ReactElement } from "react";
import { ResponsiveContainer } from "recharts";
import type { LegendPayload, TooltipContentProps } from "recharts";
import { cn } from "@/lib/utils";
import { EMPTY_MESSAGE } from "./chartTheme";

/** Per-entry value formatter for the shared tooltip. */
export type TooltipValueFormat = (
  value: number,
  dataKey: string,
  name: string,
) => string;

// ------------------------------------------------------------- ChartContainer
/**
 * Wraps a recharts chart in a `ResponsiveContainer`, or renders a centered
 * empty-state at the same height when there is no data.
 */
export function ChartContainer({
  height = 260,
  isEmpty,
  emptyMessage = EMPTY_MESSAGE,
  children,
  className,
}: {
  height?: number;
  isEmpty: boolean;
  emptyMessage?: string;
  children: ReactElement;
  className?: string;
}) {
  if (isEmpty) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-sm text-ink-subtle",
          className,
        )}
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={height} className={className}>
      {children}
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------- ChartTooltip
/** Consistent tooltip card. Pass `format` to control per-series value display. */
export function ChartTooltip({
  active,
  payload,
  label,
  format,
}: TooltipContentProps & { format: TooltipValueFormat }) {
  if (!active || !payload || payload.length === 0) return null;
  const hasLabel = label !== undefined && label !== null && label !== "";
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-[0_1px_2px_rgba(46,47,48,0.04),0_4px_16px_-8px_rgba(46,47,48,0.10)]">
      {hasLabel && (
        <p className="mb-1 font-medium text-ink">{String(label)}</p>
      )}
      <div className="space-y-0.5">
        {payload.map((entry, i) => {
          const dataKey = String(entry.dataKey ?? "");
          const name = String(entry.name ?? dataKey);
          const raw = entry.value;
          const value = typeof raw === "number" ? raw : Number(raw ?? 0);
          return (
            <div key={`${dataKey}-${i}`} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-ink-muted">{name}</span>
              <span className="ml-auto font-medium tabular-nums text-ink">
                {format(value, dataKey, name)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- LegendChips
/** Small chip legend (colored swatch + label) shared by combo/trend charts. */
export function LegendChips({
  payload,
}: {
  payload?: readonly LegendPayload[];
}) {
  if (!payload || payload.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-1">
      {payload.map((entry, i) => (
        <span
          key={`${entry.value}-${i}`}
          className="inline-flex items-center gap-1.5 text-xs text-ink-muted"
        >
          <span
            className="h-2.5 w-2.5 rounded-[3px]"
            style={{ backgroundColor: entry.color }}
          />
          {entry.value}
        </span>
      ))}
    </div>
  );
}
