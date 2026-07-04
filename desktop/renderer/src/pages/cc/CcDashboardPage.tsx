import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ReceiptText,
  CheckCircle2,
  Clock,
  DollarSign,
  BellRing,
  Activity,
  Download,
  BadgeCheck,
  AlertTriangle,
  SlidersHorizontal,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Input, Spinner, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { formatDate, ageLabel } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import { downloadSheet, exportDateStamp } from "@/cc/ccExport";
import {
  ccApi,
  sendCcReminders,
  type DashboardSummary,
  type DashboardCardholderRow,
  type CcDashboardAnalytics,
} from "@/cc/ccApi";
import {
  KpiCard,
  ComboBarLineChart,
  HBarChart,
  DonutChart,
  chartColors,
  formatCompactCurrency,
  formatPercent,
  formatCount,
} from "@/components/charts";

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** "2025-07" → "Jul ’25" for a compact x-axis label. */
function monthLabel(ym: string): string {
  const [year, month] = ym.split("-");
  const idx = Number(month) - 1;
  const name = MONTH_ABBR[idx] ?? month ?? ym;
  return `${name} ’${(year ?? "").slice(2)}`;
}

/** Titled card frame matching the app's card-with-header pattern. */
function SectionCard({
  title,
  action,
  icon,
  children,
  className,
}: {
  title: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="font-display text-sm font-semibold text-ink">{title}</h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </Card>
  );
}

export default function CcDashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [analytics, setAnalytics] = useState<CcDashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [remindingId, setRemindingId] = useState<string | null>(null);
  const [cycleStart, setCycleStart] = useState("");
  const [cycleEnd, setCycleEnd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const query = {
      cycle_start: cycleStart || undefined,
      cycle_end: cycleEnd || undefined,
    };
    // Load both endpoints in parallel; a partial failure still renders whatever
    // succeeded (e.g. analytics 503s pre-migration but /summary still works).
    const [summaryRes, analyticsRes] = await Promise.allSettled([
      ccApi.dashboardSummary(query),
      ccApi.dashboardAnalytics({ ...query, months: 12 }),
    ]);

    if (summaryRes.status === "fulfilled") setSummary(summaryRes.value);
    if (analyticsRes.status === "fulfilled") setAnalytics(analyticsRes.value);

    const failure = [summaryRes, analyticsRes].find(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failure) {
      const err = failure.reason;
      if (err instanceof ApiError && err.status === 503) {
        toast.error(
          "Credit-card analytics aren’t ready yet — finish the database migration and try again.",
        );
      } else {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to load dashboard",
        );
      }
    }
    setLoading(false);
  }, [cycleStart, cycleEnd]);

  useEffect(() => {
    load();
  }, [load]);

  async function remind(row: DashboardCardholderRow) {
    setRemindingId(row.cardholder_id);
    try {
      const { result, openedMailto } = await sendCcReminders(
        { cardholder_ids: [row.cardholder_id] },
        desktop()?.openExternal,
      );
      if (openedMailto) {
        toast.success("Opened a reminder draft in your mail app");
      } else if (result.sent_count > 0) {
        toast.success(`Reminder sent to ${row.name}`);
      } else if (result.not_configured_count > 0) {
        toast.error(
          "Email isn't configured and no mail client is available to draft a reminder.",
        );
      } else {
        toast.info("Nothing pending to remind about.");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send reminder");
    } finally {
      setRemindingId(null);
    }
  }

  function exportExcel() {
    const rows = summary?.cardholder_breakdown ?? [];
    if (rows.length === 0) {
      toast.info("Nothing to export.");
      return;
    }
    const header = ["Name", "Card", "Open", "Received", "% Complete", "Last notified"];
    const data = rows.map((c) => [
      c.name,
      c.card,
      c.open,
      c.received,
      Math.round(c.pct_complete ?? 0),
      c.last_notified_at ? formatDate(c.last_notified_at) : "",
    ]);
    downloadSheet(
      `CC_Dashboard_${exportDateStamp()}.xlsx`,
      "Cardholders",
      header,
      data,
    );
  }

  function resetCycle() {
    setCycleStart("");
    setCycleEnd("");
  }

  // First paint only: show the page spinner. Later refetches (filter changes)
  // keep the existing content on screen and swap in the new data when it lands.
  if (loading && !summary && !analytics) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <CcSubNav />
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </div>
    );
  }

  const s = summary;
  const a = analytics;

  // ---- KPI values (summary + analytics reconcile on the same cycle universe) --
  const totalSpend = s?.total_spend ?? 0;
  const received = s?.receipts_received ?? 0;
  const pending = s?.receipts_pending ?? 0;
  const receiptTotal = received + pending;
  const receiptPct = receiptTotal > 0 ? (received / receiptTotal) * 100 : 0;
  const totalTx = a?.kpis.total_transactions ?? s?.total_transactions ?? 0;
  const inQb = a?.kpis.in_qb_count ?? 0;
  const unmatched = a?.kpis.unmatched_count ?? 0;
  const inQbPct = totalTx > 0 ? (inQb / totalTx) * 100 : 0;

  // ---- Chart data ------------------------------------------------------------
  const comboData = (a?.monthly ?? []).map((p) => ({
    month: monthLabel(p.month),
    spend: p.spend,
    completion_pct: p.completion_pct,
  }));

  const cardholders = s?.cardholder_breakdown ?? [];
  const cardholderBars = cardholders.map((c) => ({
    name: c.name,
    value: c.received,
    secondary: c.open,
  }));
  const pendingCardholders = cardholders
    .filter((c) => c.open > 0)
    .sort((x, y) => y.open - x.open);

  const entityData = (a?.by_entity ?? []).map((e) => ({
    name: e.label,
    value: e.spend,
  }));
  const categoryData = (a?.by_category ?? []).map((c) => ({
    name: c.category,
    value: c.spend,
  }));
  // Prefer the entity donut; fall back to category when no entity splits exist.
  const useEntity = entityData.length > 0;
  const donutData = useEntity ? entityData : categoryData;
  const donutTitle = useEntity ? "Spend by entity" : "Spend by category";

  const activity = s?.recent_activity ?? [];

  const cycleWindow =
    a?.cycle_start && a?.cycle_end
      ? `${formatDate(a.cycle_start)} – ${formatDate(a.cycle_end)}`
      : null;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Credit-card spend and receipt collection for the selected cycle"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={exportExcel}
            disabled={!s?.cardholder_breakdown?.length}
          >
            <Download className="h-4 w-4" />
            Export Excel
          </Button>
        }
      />
      <CcSubNav />

      {/* Cycle date-range Filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-6 py-3 text-sm">
        <SlidersHorizontal className="h-4 w-4 text-ink-subtle" />
        <span className="font-medium text-ink-muted">Cycle</span>
        <Input
          type="date"
          aria-label="Cycle start"
          value={cycleStart}
          max={cycleEnd || undefined}
          onChange={(e) => setCycleStart(e.target.value)}
          className="w-40"
        />
        <span className="text-ink-subtle">to</span>
        <Input
          type="date"
          aria-label="Cycle end"
          value={cycleEnd}
          min={cycleStart || undefined}
          onChange={(e) => setCycleEnd(e.target.value)}
          className="w-40"
        />
        {(cycleStart || cycleEnd) && (
          <Button variant="ghost" size="sm" onClick={resetCycle}>
            Reset
          </Button>
        )}
        {cycleWindow && (
          <span className="ml-auto text-xs text-ink-subtle">
            Showing {cycleWindow}
          </span>
        )}
      </div>

      <div className="space-y-6 p-6">
        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <KpiCard
            label="Total Spend"
            value={formatCompactCurrency(totalSpend)}
            sublabel="Non-payment charges"
            icon={<DollarSign className="h-5 w-5" />}
          />
          <KpiCard
            label="Transactions"
            value={formatCount(totalTx)}
            sublabel="This cycle"
            icon={<ReceiptText className="h-5 w-5" />}
          />
          <KpiCard
            label="Receipts Received"
            value={formatPercent(receiptPct)}
            sublabel={`${formatCount(received)} of ${formatCount(receiptTotal)}`}
            tone={
              receiptTotal > 0 && received >= receiptTotal ? "positive" : "default"
            }
            icon={<CheckCircle2 className="h-5 w-5" />}
          />
          <KpiCard
            label="Open Receipts"
            value={formatCount(pending)}
            sublabel="Awaiting submission"
            icon={<Clock className="h-5 w-5" />}
          />
          <KpiCard
            label="In QuickBooks"
            value={formatCount(inQb)}
            sublabel={`${formatPercent(inQbPct)} of ${formatCount(totalTx)}`}
            icon={<BadgeCheck className="h-5 w-5" />}
          />
          <KpiCard
            label="Unmatched"
            value={formatCount(unmatched)}
            sublabel="No cardholder"
            tone={unmatched > 0 ? "warning" : "default"}
            icon={<AlertTriangle className="h-5 w-5" />}
          />
        </div>

        {/* Monthly spend + receipt completion combo */}
        <SectionCard title="Spend & receipt completion — past 12 months">
          <ComboBarLineChart
            data={comboData}
            xKey="month"
            bars={[{ key: "spend", name: "Spend", color: chartColors.info }]}
            line={{
              key: "completion_pct",
              name: "Receipts %",
              color: chartColors.warning,
              unit: "%",
            }}
            height={300}
          />
        </SectionCard>

        {/* Cardholder progress + Spend by entity */}
        <div className="grid gap-6 lg:grid-cols-2">
          <SectionCard
            title="Cardholder progress"
            action={
              <Link
                to="/credit-cards/receipts"
                className="text-xs font-medium text-accent hover:underline"
              >
                Open receipt tracker
              </Link>
            }
          >
            {cardholderBars.length === 0 ? (
              <EmptyState title="No cardholder activity this cycle" />
            ) : (
              <>
                <HBarChart
                  data={cardholderBars}
                  color={chartColors.info}
                  secondaryColor={chartColors.grid}
                  primaryName="Received"
                  secondaryName="Open"
                  valueFormat={formatCount}
                  yWidth={130}
                />
                {pendingCardholders.length > 0 && (
                  <div className="mt-3 space-y-1.5 border-t border-line pt-3">
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-subtle">
                      Awaiting receipts
                    </p>
                    {pendingCardholders.map((c) => (
                      <div
                        key={c.cardholder_id}
                        className="flex items-center gap-3 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {c.name}
                        </span>
                        <span className="shrink-0 tabular-nums text-ink-muted">
                          {c.open} open
                        </span>
                        <span className="hidden shrink-0 text-xs text-ink-subtle sm:inline">
                          {c.last_notified_at
                            ? `notified ${ageLabel(c.last_notified_at)} ago`
                            : "not notified"}
                        </span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => remind(c)}
                          loading={remindingId === c.cardholder_id}
                        >
                          <BellRing className="h-3.5 w-3.5" />
                          Remind
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard title={donutTitle}>
            <DonutChart
              data={donutData}
              valueFormat={formatCompactCurrency}
              emptyMessage="No spend to break down this cycle"
            />
          </SectionCard>
        </div>

        {/* Recent activity */}
        <SectionCard
          title="Recent activity"
          icon={<Activity className="h-4 w-4 text-ink-subtle" />}
        >
          {activity.length === 0 ? (
            <EmptyState title="No recent activity" />
          ) : (
            <ul className="-mx-4 -my-4 divide-y divide-line">
              {activity.map((item, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm"
                >
                  <span className="text-ink">{item.text}</span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {formatDate(item.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
