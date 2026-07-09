/**
 * DonutChart — category donut with a centered total and a compact, wrapping
 * legend beneath it. Slice detail (name + amount + percent of total) lives in the
 * hover tooltip ONLY — there are no baked-in slice labels or leader lines to
 * overlap or spill off the card. Used for "spend by entity / category / GL".
 * Pure props, no data.
 */
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { TooltipContentProps } from "recharts";
import {
  CURSOR_FILL,
  EMPTY_MESSAGE,
  chartColors,
  donutSequence,
  formatCompactCurrency,
  formatPercent,
} from "./chartTheme";

export interface DonutDatum {
  name: string;
  value: number;
}

/** Internal row enriched with its resolved color + share so the tooltip is pure. */
interface DonutRow extends DonutDatum {
  __color: string;
  __pct: number;
}

export interface DonutChartProps {
  data: DonutDatum[];
  /** Slice colors, assigned in order (falls back to the token donut sequence). */
  colors?: string[];
  /** Value formatter for the total and tooltip amount. */
  valueFormat?: (n: number) => string;
  /** Diameter of the donut (px). Caps the width; the donut shrinks on narrow cards. */
  height?: number;
  /** Empty-state copy. */
  emptyMessage?: string;
}

/** Hover card: slice name, formatted amount, and its percent of the total. */
function DonutTooltip({
  active,
  payload,
  valueFormat,
}: TooltipContentProps & { valueFormat: (n: number) => string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload as DonutRow | undefined;
  if (!row) return null;
  return (
    <div className="min-w-[9.5rem] max-w-[16rem] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
          style={{ backgroundColor: row.__color }}
        />
        <span className="min-w-0 break-words font-medium text-ink">
          {row.name}
        </span>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-ink-muted">Amount</span>
        <span className="font-medium tabular-nums text-ink">
          {valueFormat(row.value)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-6">
        <span className="text-ink-muted">Share</span>
        <span className="font-medium tabular-nums text-ink">
          {formatPercent(row.__pct)}
        </span>
      </div>
    </div>
  );
}

export function DonutChart({
  data,
  colors = donutSequence,
  valueFormat = formatCompactCurrency,
  height = 220,
  emptyMessage = EMPTY_MESSAGE,
}: DonutChartProps) {
  if (data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-sm text-ink-subtle"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + (d.value || 0), 0);
  const colorAt = (i: number) => colors[i % colors.length];
  const rows: DonutRow[] = data.map((d, i) => ({
    ...d,
    __color: colorAt(i),
    __pct: total > 0 ? ((d.value || 0) / total) * 100 : 0,
  }));

  return (
    <div className="flex flex-col items-center gap-4">
      <div
        className="relative"
        style={{ width: height, height, maxWidth: "100%" }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={2}
              stroke={chartColors.surface}
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
            >
              {rows.map((d, i) => (
                <Cell key={`${d.name}-${i}`} fill={d.__color} />
              ))}
            </Pie>
            <Tooltip
              cursor={{ fill: CURSOR_FILL }}
              content={(p) => <DonutTooltip {...p} valueFormat={valueFormat} />}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-subtle">
            Total
          </span>
          <span className="text-lg font-semibold tabular-nums text-ink">
            {valueFormat(total)}
          </span>
        </div>
      </div>

      {/* Compact legend — swatch + (truncated) name + share. Wraps, never overflows;
          exact amounts live in the hover tooltip. */}
      <ul className="flex max-w-full flex-wrap justify-center gap-x-4 gap-y-1.5">
        {rows.map((d, i) => (
          <li
            key={`${d.name}-${i}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-xs"
            title={`${d.name} · ${valueFormat(d.value)} · ${formatPercent(d.__pct)}`}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: d.__color }}
            />
            <span className="max-w-[9rem] truncate text-ink-muted">{d.name}</span>
            <span className="shrink-0 tabular-nums text-ink-subtle">
              {formatPercent(d.__pct)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
