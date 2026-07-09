/**
 * HBarChart — horizontal bars for ranked / progress data (top vendors,
 * per-cardholder progress). Optionally stacks a muted `secondary` segment beside
 * the primary value (e.g. received vs. open).
 *
 * By default the category names are TRUNCATED with an ellipsis to fit the reserved
 * axis width so they never clip, overlap, or leave the card. Pass
 * `hideCategoryLabels` to drop the name axis entirely and make the chart fully
 * hover-driven (used for "Top vendors"). Either way the hover tooltip carries the
 * full name, the amount, and the percent of total. No always-on value labels.
 * Pure props, no data.
 */
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { TooltipContentProps } from "recharts";
import { ChartContainer } from "./ChartFrame";
import {
  AXIS_TICK,
  CURSOR_FILL,
  GRID_STROKE,
  chartColors,
  formatCompactCurrency,
  formatPercent,
} from "./chartTheme";

export interface HBarDatum {
  name: string;
  value: number;
  /** Optional muted second segment stacked after `value` (e.g. remaining/open). */
  secondary?: number;
}

export interface HBarChartProps {
  data: HBarDatum[];
  /** Primary bar color. */
  color: string;
  /** Color for the optional stacked `secondary` segment. */
  secondaryColor?: string;
  /** Legend/tooltip name for the primary series. */
  primaryName?: string;
  /** Legend/tooltip name for the secondary series. */
  secondaryName?: string;
  /** Value formatter for axis ticks and tooltip. */
  valueFormat?: (n: number) => string;
  height?: number;
  /** Fixed x-axis max (e.g. 100 for percent bars). */
  max?: number;
  /** Width reserved for the category (name) labels. */
  yWidth?: number;
  /**
   * Hide the Y-axis category (name) labels entirely so the chart is fully
   * hover-driven — the names live in the tooltip only (used for "Top vendors").
   * Default false: the labeled axis is kept, which is required where the name IS
   * the identity of each row (e.g. per-cardholder progress bars).
   */
  hideCategoryLabels?: boolean;
}

/**
 * Y-axis category tick that truncates long names to the reserved width so text
 * stays inside the plot. Recharts clones this element with the computed
 * `x`/`y`/`payload`; `axisWidth` is our own (uniquely named) prop.
 */
function CategoryTick({
  x = 0,
  y = 0,
  payload,
  axisWidth = 120,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string | number };
  axisWidth?: number;
}) {
  const text = String(payload?.value ?? "");
  const maxChars = Math.max(6, Math.floor((axisWidth - 10) / 6.2));
  const display =
    text.length > maxChars ? `${text.slice(0, maxChars - 1).trimEnd()}…` : text;
  return (
    <text
      x={x}
      y={y}
      dy={4}
      textAnchor="end"
      fill={chartColors.axisLabel}
      fontSize={12}
    >
      {display}
    </text>
  );
}

/** Hover card: full category name + each segment's amount and percent of total. */
function HBarTooltip({
  active,
  payload,
  label,
  valueFormat,
  totals,
}: TooltipContentProps & {
  valueFormat: (n: number) => string;
  totals: Record<string, number>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const hasLabel = label !== undefined && label !== null && label !== "";
  return (
    <div className="min-w-[11rem] max-w-[18rem] rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card">
      {hasLabel && (
        <p className="mb-1.5 break-words font-medium text-ink">{String(label)}</p>
      )}
      <div className="space-y-1">
        {payload.map((entry, i) => {
          const key = String(entry.dataKey ?? "");
          const name = String(entry.name ?? key);
          const raw = entry.value;
          const value = typeof raw === "number" ? raw : Number(raw ?? 0);
          const sum = totals[key] ?? 0;
          const pct = sum > 0 ? (value / sum) * 100 : 0;
          return (
            <div key={`${key}-${i}`} className="flex items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-ink-muted">{name}</span>
              <span className="ml-auto font-medium tabular-nums text-ink">
                {valueFormat(value)}
              </span>
              <span className="w-9 shrink-0 text-right tabular-nums text-ink-subtle">
                {formatPercent(pct)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function HBarChart({
  data,
  color,
  secondaryColor = chartColors.grid,
  primaryName = "Value",
  secondaryName = "Remaining",
  valueFormat = formatCompactCurrency,
  height,
  max,
  yWidth = 120,
  hideCategoryLabels = false,
}: HBarChartProps) {
  const hasSecondary = data.some((d) => typeof d.secondary === "number");
  const resolvedHeight = height ?? Math.max(data.length * 40 + 24, 120);
  const totals: Record<string, number> = {
    value: data.reduce((s, d) => s + (d.value || 0), 0),
    secondary: data.reduce((s, d) => s + (d.secondary || 0), 0),
  };

  return (
    <ChartContainer height={resolvedHeight} isEmpty={data.length === 0}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 12, bottom: 0, left: 4 }}
        barCategoryGap={hasSecondary ? "22%" : "30%"}
      >
        <CartesianGrid horizontal={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
        <XAxis
          type="number"
          domain={max != null ? [0, max] : undefined}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID_STROKE }}
          tickFormatter={(v) => valueFormat(Number(v))}
        />
        <YAxis
          type="category"
          dataKey="name"
          width={hideCategoryLabels ? 0 : yWidth}
          tick={hideCategoryLabels ? false : <CategoryTick axisWidth={yWidth} />}
          tickLine={false}
          axisLine={false}
          interval={0}
          hide={hideCategoryLabels}
        />
        <Tooltip
          cursor={{ fill: CURSOR_FILL }}
          content={(p) => (
            <HBarTooltip {...p} valueFormat={valueFormat} totals={totals} />
          )}
        />
        <Bar
          dataKey="value"
          name={primaryName}
          stackId={hasSecondary ? "a" : undefined}
          fill={color}
          radius={hasSecondary ? [0, 0, 0, 0] : [0, 4, 4, 0]}
          maxBarSize={22}
        />
        {hasSecondary && (
          <Bar
            dataKey="secondary"
            name={secondaryName}
            stackId="a"
            fill={secondaryColor}
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
          />
        )}
      </BarChart>
    </ChartContainer>
  );
}
