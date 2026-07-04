/**
 * TrendChart — a line (or area) trend over time on a single shared y-axis.
 * Used for "monthly AP spend" and other change-over-time series. Pure props.
 */
import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartContainer, ChartTooltip, LegendChips } from "./ChartFrame";
import {
  AXIS_TICK,
  CURSOR_FILL,
  GRID_STROKE,
  formatCompactCurrency,
} from "./chartTheme";

export interface TrendSeries {
  key: string;
  name: string;
  color: string;
}

export interface TrendChartProps {
  data: Array<Record<string, string | number>>;
  /** Field on each row used for the x categories (e.g. "month"). */
  xKey: string;
  /** One or more series to draw. */
  series: TrendSeries[];
  height?: number;
  /** Render as filled areas instead of plain lines. */
  area?: boolean;
  /** Y-axis + tooltip value formatter. Defaults to compact currency. */
  valueFormat?: (n: number) => string;
}

export function TrendChart({
  data,
  xKey,
  series,
  height = 280,
  area = false,
  valueFormat = formatCompactCurrency,
}: TrendChartProps) {
  const gradientId = useId();
  const tooltipFormat = (value: number) => valueFormat(value);
  const showLegend = series.length > 1;

  const grid = (
    <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
  );
  const xAxis = (
    <XAxis
      dataKey={xKey}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={{ stroke: GRID_STROKE }}
    />
  );
  const yAxis = (
    <YAxis
      width={52}
      tick={AXIS_TICK}
      tickLine={false}
      axisLine={false}
      tickFormatter={(v) => valueFormat(Number(v))}
    />
  );
  const tooltip = (
    <Tooltip
      cursor={{ stroke: GRID_STROKE, strokeWidth: 1, fill: CURSOR_FILL }}
      content={(p) => <ChartTooltip {...p} format={tooltipFormat} />}
    />
  );
  const legend = showLegend ? (
    <Legend content={(p) => <LegendChips payload={p.payload} />} />
  ) : null;

  return (
    <ChartContainer height={height} isEmpty={data.length === 0}>
      {area ? (
        <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          <defs>
            {series.map((s) => (
              <linearGradient
                key={s.key}
                id={`${gradientId}-${s.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor={s.color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#${gradientId}-${s.key})`}
              dot={false}
              activeDot={{ r: 5 }}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              strokeWidth={2}
              dot={{ r: 2.5, fill: s.color, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
