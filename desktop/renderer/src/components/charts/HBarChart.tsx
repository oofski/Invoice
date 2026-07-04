/**
 * HBarChart — horizontal bars for ranked / progress data (top vendors,
 * per-cardholder progress). Optionally stacks a muted `secondary` segment beside
 * the primary value (e.g. received vs. open). Pure props, no data.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip } from "./ChartFrame";
import {
  AXIS_TICK,
  CURSOR_FILL,
  GRID_STROKE,
  chartColors,
  formatCompactCurrency,
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
  /** Value formatter for axis ticks, bar labels, and tooltip. */
  valueFormat?: (n: number) => string;
  height?: number;
  /** Fixed x-axis max (e.g. 100 for percent bars). */
  max?: number;
  /** Width reserved for the category (name) labels. */
  yWidth?: number;
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
}: HBarChartProps) {
  const hasSecondary = data.some((d) => typeof d.secondary === "number");
  const resolvedHeight =
    height ?? Math.max(data.length * 40 + 24, 120);

  return (
    <ChartContainer height={resolvedHeight} isEmpty={data.length === 0}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 52, bottom: 0, left: 4 }}
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
          width={yWidth}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: CURSOR_FILL }}
          content={(p) => <ChartTooltip {...p} format={(v) => valueFormat(v)} />}
        />
        <Bar
          dataKey="value"
          name={primaryName}
          stackId={hasSecondary ? "a" : undefined}
          fill={color}
          radius={hasSecondary ? [0, 0, 0, 0] : [0, 4, 4, 0]}
          maxBarSize={22}
        >
          {!hasSecondary && (
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v) => valueFormat(Number(v))}
              fill={chartColors.axisLabel}
              fontSize={12}
            />
          )}
        </Bar>
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
