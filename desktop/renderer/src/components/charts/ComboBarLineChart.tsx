/**
 * ComboBarLineChart — grouped/single bars (currency, left axis) with an overlaid
 * line on a secondary axis (percent or count, right axis). Used for
 * "monthly spend bars + completion% line" and "income/expenses + margin line".
 *
 * NOTE ON DUAL AXES: this component deliberately draws two y-scales ($ left,
 * % / count right) to match the requested QuickBooks-style combo chart. This is
 * the defensible dual-axis case (currency vs. a rate on the same periods); use a
 * single-axis TrendChart when both measures share a scale. Pure props, no data.
 */
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  formatCount,
  formatPercent,
} from "./chartTheme";

export interface ComboBarSeries {
  key: string;
  name: string;
  color: string;
}

export interface ComboLineSeries {
  key: string;
  name: string;
  color: string;
  /** Right-axis unit. "%" → percent axis, "$" → currency, else count. */
  unit?: "%" | "$" | "count";
}

export interface ComboBarLineChartProps {
  data: Array<Record<string, string | number>>;
  /** Field on each row used for the x categories (e.g. "month"). */
  xKey: string;
  /** One or more bar series (left / currency axis). */
  bars: ComboBarSeries[];
  /** The overlaid line series (right axis). */
  line: ComboLineSeries;
  height?: number;
  /** Left-axis + bar tooltip formatter. Defaults to compact currency. */
  currencyFormat?: (n: number) => string;
}

export function ComboBarLineChart({
  data,
  xKey,
  bars,
  line,
  height = 300,
  currencyFormat = formatCompactCurrency,
}: ComboBarLineChartProps) {
  const rightFormat =
    line.unit === "%"
      ? formatPercent
      : line.unit === "$"
        ? currencyFormat
        : formatCount;

  const tooltipFormat = (value: number, dataKey: string) =>
    dataKey === line.key ? rightFormat(value) : currencyFormat(value);

  return (
    <ChartContainer height={height} isEmpty={data.length === 0}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} stroke={GRID_STROKE} strokeDasharray="3 3" />
        <XAxis
          dataKey={xKey}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={{ stroke: GRID_STROKE }}
        />
        <YAxis
          yAxisId="left"
          width={52}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => currencyFormat(Number(v))}
        />
        <YAxis
          yAxisId="right"
          orientation="right"
          width={44}
          tick={AXIS_TICK}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => rightFormat(Number(v))}
        />
        <Tooltip
          cursor={{ fill: CURSOR_FILL }}
          content={(p) => <ChartTooltip {...p} format={tooltipFormat} />}
        />
        <Legend content={(p) => <LegendChips payload={p.payload} />} />
        {bars.map((b) => (
          <Bar
            key={b.key}
            yAxisId="left"
            dataKey={b.key}
            name={b.name}
            fill={b.color}
            radius={[4, 4, 0, 0]}
            maxBarSize={40}
          />
        ))}
        <Line
          yAxisId="right"
          type="monotone"
          dataKey={line.key}
          name={line.name}
          stroke={line.color}
          strokeWidth={2}
          dot={{ r: 3, fill: line.color, strokeWidth: 0 }}
          activeDot={{ r: 5 }}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
