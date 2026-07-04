/**
 * Reusable, presentational chart components for the dashboard redesign.
 * Light-theme, token-driven, recharts-based. No API calls — pure props.
 */

// Components
export { KpiCard } from "./KpiCard";
export type { KpiCardProps, KpiTone } from "./KpiCard";

export { ComboBarLineChart } from "./ComboBarLineChart";
export type {
  ComboBarLineChartProps,
  ComboBarSeries,
  ComboLineSeries,
} from "./ComboBarLineChart";

export { TrendChart } from "./TrendChart";
export type { TrendChartProps, TrendSeries } from "./TrendChart";

export { DonutChart } from "./DonutChart";
export type { DonutChartProps, DonutDatum } from "./DonutChart";

export { HBarChart } from "./HBarChart";
export type { HBarChartProps, HBarDatum } from "./HBarChart";

// Shared frame helpers
export { ChartContainer, ChartTooltip, LegendChips } from "./ChartFrame";
export type { TooltipValueFormat } from "./ChartFrame";

// Theme, palette, and formatters
export {
  chartColors,
  donutSequence,
  AXIS_TICK,
  GRID_STROKE,
  CURSOR_FILL,
  EMPTY_MESSAGE,
  formatCompactCurrency,
  formatFullCurrency,
  formatPercent,
  formatCount,
} from "./chartTheme";
