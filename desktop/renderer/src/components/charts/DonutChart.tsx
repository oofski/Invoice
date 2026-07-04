/**
 * DonutChart — category donut with a legend LIST (label + value + share %) beside
 * it and a centered total. Used for "spend by entity / category / GL". Pure props.
 */
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltip } from "./ChartFrame";
import {
  CURSOR_FILL,
  EMPTY_MESSAGE,
  chartColors,
  donutSequence,
  formatCompactCurrency,
} from "./chartTheme";

export interface DonutDatum {
  name: string;
  value: number;
}

export interface DonutChartProps {
  data: DonutDatum[];
  /** Slice colors, assigned in order (falls back to the token donut sequence). */
  colors?: string[];
  /** Value formatter for the total, legend list, and tooltip. */
  valueFormat?: (n: number) => string;
  /** Diameter of the donut (px). The legend list flexes beside it. */
  height?: number;
  /** Empty-state copy. */
  emptyMessage?: string;
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

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row">
      <div className="relative shrink-0" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
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
              {data.map((d, i) => (
                <Cell key={`${d.name}-${i}`} fill={colorAt(i)} />
              ))}
            </Pie>
            <Tooltip
              cursor={{ fill: CURSOR_FILL }}
              content={(p) => (
                <ChartTooltip {...p} format={(v) => valueFormat(v)} />
              )}
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

      <ul className="w-full flex-1 space-y-1.5">
        {data.map((d, i) => {
          const pct = total > 0 ? (d.value / total) * 100 : 0;
          return (
            <li
              key={`${d.name}-${i}`}
              className="flex items-start gap-2 text-sm"
            >
              <span
                className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[3px]"
                style={{ backgroundColor: colorAt(i) }}
              />
              <span className="min-w-0 flex-1 leading-snug text-ink-muted">
                {d.name}
              </span>
              <span className="shrink-0 tabular-nums text-ink">
                {valueFormat(d.value)}
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums text-ink-subtle">
                {Math.round(pct)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
