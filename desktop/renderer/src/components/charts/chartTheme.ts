/**
 * Shared chart theme — token-derived palette, formatters, and axis/grid styling.
 *
 * LIGHT THEME ONLY (the app has no dark mode). All hex values mirror the Neroli
 * palette in `tailwind.config.ts` / `index.css` so the charts read as one system
 * with the rest of the app. Nothing here is business data — pure presentation.
 *
 * "Blue/gold" QuickBooks-style accents are adapted from the app's OWN muted
 * tokens rather than importing new colors:
 *   info    #5B6E6E  teal-blue   → primary bars / first series
 *   warning #9A6B1E  gold        → overlaid line / second series
 *   accent  #9A6F62  terracotta  → tertiary series
 */

export const chartColors = {
  // Series accents (token hex)
  info: "#5B6E6E", // teal-blue  (tailwind `info`)
  warning: "#9A6B1E", // gold      (tailwind `warning`)
  accent: "#9A6F62", // terracotta (tailwind `accent`)
  primary: "#424445", // slate     (tailwind `primary`)
  success: "#3F6F57", // green     (tailwind `success`)
  danger: "#A23B32", // red        (tailwind `danger`)
  accentSoft: "#AC9089", // soft terracotta (tailwind `accent-soft`)
  warningDeep: "#7A521A", // deep gold  (tailwind `warning-soft-fg`)

  // Chart chrome
  grid: "#E3DED7", // line
  axis: "#857F78", // ink-subtle
  axisLabel: "#5B5650", // ink-muted
  ink: "#2E2F30", // ink
  surface: "#FFFFFF", // surface (slice ring / gaps)
} as const;

/**
 * Categorical donut sequence. Ordered so the two brand accents (teal-blue, gold)
 * and terracotta lead, with status colors (green/red) last, and so that adjacent
 * slices stay separable under color-vision deficiency (validated: worst adjacent
 * pair ΔE ≈ 13 protan — above the 12 target — with slice labels + gaps as the
 * required secondary encoding). Colors follow the entity, assigned in fixed order.
 */
export const donutSequence: string[] = [
  chartColors.info, // teal-blue
  chartColors.warning, // gold
  chartColors.accent, // terracotta
  chartColors.primary, // slate
  chartColors.success, // green
  chartColors.danger, // red
  chartColors.accentSoft, // soft terracotta
  chartColors.warningDeep, // deep gold
];

// ---------------------------------------------------------------- Axis / grid
/** Muted axis tick text — used for both x and y ticks across every chart. */
export const AXIS_TICK = { fill: chartColors.axisLabel, fontSize: 12 } as const;
/** Light dashed gridline stroke (drawn horizontal-only on vertical charts). */
export const GRID_STROKE = chartColors.grid;
/** Faint hover cursor band shared by bar/combo tooltips. */
export const CURSOR_FILL = "rgba(46,47,48,0.04)";

// ---------------------------------------------------------------- Formatters
function trimTrailingZero(s: string): string {
  return s.replace(/\.0$/, "");
}

/** Compact currency: `$1.2k` / `$1.2M`. Default for axis ticks + tooltips. */
export function formatCompactCurrency(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000)
    return `${sign}$${trimTrailingZero((abs / 1_000_000).toFixed(1))}M`;
  if (abs >= 1_000)
    return `${sign}$${trimTrailingZero((abs / 1_000).toFixed(1))}k`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/** Full currency: `$1,234.56`. Inject where exact amounts matter (legend lists). */
export function formatFullCurrency(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Whole percent: `42%`. */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "0%";
  return `${Math.round(n)}%`;
}

/** Grouped integer count: `1,204`. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/** Default empty-state copy for a chart with no rows in the selected window. */
export const EMPTY_MESSAGE = "No data for this period";
