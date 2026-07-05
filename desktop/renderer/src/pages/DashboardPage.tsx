import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Clock,
  AlertTriangle,
  Download,
  FileCheck,
  FileText,
  Receipt,
  Wallet,
  BellRing,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button, Spinner, Input } from "@/components/ui/primitives";
import { InvoiceTable, type QueueInvoice } from "@/components/InvoiceTable";
import { RemindApproversModal } from "@/components/RemindApproversModal";
import {
  KpiCard,
  TrendChart,
  DonutChart,
  HBarChart,
  chartColors,
  formatCompactCurrency,
  formatFullCurrency,
  formatCount,
} from "@/components/charts";
import { useApi } from "@/hooks/useApi";
import { api, ApiError, type DashboardAnalytics } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { useProfile } from "@/components/ProfileProvider";
import { cn } from "@/lib/utils";
import {
  BUSINESS_ENTITIES,
  APPROVERS,
  INVOICE_STATUS,
  ROLES,
} from "@/lib/constants";
import type { DashboardStats } from "@/lib/types";

const MONTH_NAMES = [
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

/**
 * v1.6.0 review predicate — an invoice belongs in the Manual Review Queue / the
 * REVIEW tab when it has flagged lines, an unconfirmed location, or a
 * reconciliation gap.
 */
function needsReview(i: QueueInvoice): boolean {
  return (
    (i.review_count ?? 0) > 0 ||
    !!i.location_ambiguous ||
    i.reconciliation_delta != null
  );
}

/** "YYYY-MM" → "Mon ’YY" (e.g. "2025-07" → "Jul ’25"). */
function formatMonthLabel(ym: string): string {
  const [year, month] = ym.split("-");
  const idx = Number(month) - 1;
  const name = MONTH_NAMES[idx] ?? month;
  return `${name} ’${(year ?? "").slice(2)}`;
}

/** Card with a font-display heading — matches the app's card-section style. */
function SectionCard({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("p-4", className)}>
      <h2 className="mb-4 font-display text-base font-semibold text-ink">
        {title}
      </h2>
      {children}
    </Card>
  );
}

/** Pulsing placeholder shown while the analytics response is in flight. */
function ChartSkeleton({ height = 220 }: { height?: number }) {
  return (
    <div
      className="animate-pulse rounded-lg bg-surface-2"
      style={{ height }}
      aria-hidden
    />
  );
}

const STATUS_TABS = [
  { key: "ALL", label: "All" },
  { key: INVOICE_STATUS.PROCESSING, label: "Processing" },
  { key: INVOICE_STATUS.PENDING_APPROVAL, label: "Awaiting Approval" },
  { key: "REVIEW", label: "Needs Review" },
  { key: INVOICE_STATUS.NEEDS_REVIEW, label: "Routing Review" },
  { key: INVOICE_STATUS.APPROVED, label: "Export Ready" },
  { key: INVOICE_STATUS.REJECTED, label: "Rejected" },
  { key: INVOICE_STATUS.EXPORTED, label: "Exported" },
];

export default function DashboardPage() {
  const profile = useProfile();
  const canRemind =
    profile.role === ROLES.ACCOUNTANT ||
    profile.role === ROLES.EXECUTIVE ||
    profile.role === ROLES.ADMIN;
  const { data: stats, refetch: refetchStats } =
    useApi<DashboardStats>("/api/dashboard/stats");
  const {
    data: analytics,
    error: analyticsError,
    refetch: refetchAnalytics,
  } = useApi<DashboardAnalytics>("/api/dashboard/analytics?months=12");
  const {
    data: invData,
    loading,
    refetch,
  } = useApi<{ invoices: QueueInvoice[] }>("/api/invoices?limit=500");
  const { data: overdueData, refetch: refetchOverdue } = useApi<{
    invoices: (QueueInvoice & { hours_pending: number })[];
  }>("/api/invoices/overdue");

  const [tab, setTab] = useState("ALL");
  const [entity, setEntity] = useState("");
  const [approver, setApprover] = useState("");
  const [search, setSearch] = useState("");
  const [reminding, setReminding] = useState(false);
  const [remindOpen, setRemindOpen] = useState(false);

  // No realtime — poll every 15s (Brief §08 adapted for the desktop app).
  useEffect(() => {
    const id = setInterval(() => {
      refetch();
      refetchStats();
      refetchAnalytics();
      refetchOverdue();
    }, 15000);
    return () => clearInterval(id);
  }, [refetch, refetchStats, refetchAnalytics, refetchOverdue]);

  const invoices = useMemo(() => invData?.invoices ?? [], [invData]);

  // ----- Analytics-derived chart data (real server rollups, archived excluded)
  const analyticsReady = analytics != null;
  const trendData = useMemo(
    () =>
      (analytics?.monthly ?? []).map((m) => ({
        month: formatMonthLabel(m.month),
        spend: m.spend,
      })),
    [analytics],
  );
  const entityData = useMemo(
    () =>
      (analytics?.by_entity ?? []).map((e) => ({
        name: e.entity,
        value: e.spend,
      })),
    [analytics],
  );
  const vendorData = useMemo(
    () =>
      (analytics?.top_vendors ?? []).map((v) => ({
        name: v.vendor,
        value: v.spend,
      })),
    [analytics],
  );
  const categoryData = useMemo(
    () =>
      (analytics?.by_gl_category ?? []).map((c) => ({
        name: c.category,
        value: c.spend,
      })),
    [analytics],
  );

  const filtered = useMemo(() => {
    return invoices.filter((i) => {
      if (tab === "REVIEW" && !needsReview(i)) return false;
      else if (tab !== "ALL" && tab !== "REVIEW" && i.status !== tab)
        return false;
      if (entity && i.business !== entity) return false;
      if (approver && i.approved_by !== approver) return false;
      if (search && !i.vendor.toLowerCase().includes(search.toLowerCase()))
        return false;
      return true;
    });
  }, [invoices, tab, entity, approver, search]);

  const reviewInvoices = invoices.filter(needsReview);
  const overdue = overdueData?.invoices ?? [];

  async function bulkRemind() {
    setReminding(true);
    try {
      const res = await api.post<{ sent: number; totalOverdue: number }>(
        "/api/invoices/remind-bulk",
      );
      toast.success(
        `Sent ${res.sent} reminder${res.sent === 1 ? "" : "s"} to execs`,
      );
      refetchOverdue();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to send reminders",
      );
    } finally {
      setReminding(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Accounts payable overview"
        actions={
          canRemind ? (
            <Button
              variant="secondary"
              onClick={() => setRemindOpen(true)}
              title="Remind approvers with pending invoices"
            >
              <BellRing className="h-4 w-4" />
              Remind approvers
            </Button>
          ) : undefined
        }
      />

      {canRemind && (
        <RemindApproversModal
          open={remindOpen}
          onClose={() => setRemindOpen(false)}
        />
      )}

      <div className="space-y-6 p-6">
        {/* KPI row — period totals (analytics) + status counters (stats) */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <KpiCard
            label="Total AP"
            value={
              analytics ? formatFullCurrency(analytics.totals.total_spend) : "—"
            }
            sublabel="All time"
            tone="accent"
            icon={<Wallet className="h-4 w-4" />}
          />
          <KpiCard
            label="Invoices"
            value={
              analytics ? formatCount(analytics.totals.invoice_count) : "—"
            }
            icon={<FileText className="h-4 w-4" />}
          />
          <KpiCard
            label="Avg Invoice"
            value={
              analytics ? formatFullCurrency(analytics.totals.avg_amount) : "—"
            }
            icon={<Receipt className="h-4 w-4" />}
          />
          <KpiCard
            label="Awaiting Approval"
            value={stats ? formatCount(stats.awaitingApproval) : "—"}
            sublabel={
              overdue.length > 0
                ? `${overdue.length} overdue (72h+)`
                : undefined
            }
            tone={stats && stats.awaitingApproval > 0 ? "warning" : "default"}
            icon={<Clock className="h-4 w-4" />}
          />
          <KpiCard
            label="Export Ready"
            value={stats ? formatCount(stats.exportReady) : "—"}
            tone="positive"
            icon={<FileCheck className="h-4 w-4" />}
          />
          <KpiCard
            label="Exported (Month)"
            value={stats ? formatCount(stats.exportedThisMonth) : "—"}
            icon={<Download className="h-4 w-4" />}
          />
        </div>

        {/* Analytics charts band */}
        {analyticsError && !analytics ? (
          <Card className="border-danger-soft-fg/30 bg-danger-soft-bg/40 p-4">
            <p className="text-sm text-danger-soft-fg">
              Couldn’t load analytics: {analyticsError}
            </p>
          </Card>
        ) : (
          <>
            <SectionCard title="Accounts payable — past 12 months">
              {analyticsReady ? (
                <TrendChart
                  data={trendData}
                  xKey="month"
                  series={[
                    { key: "spend", name: "AP spend", color: chartColors.info },
                  ]}
                  area
                  valueFormat={formatCompactCurrency}
                />
              ) : (
                <ChartSkeleton height={280} />
              )}
            </SectionCard>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
              <SectionCard title="Spend by entity">
                {analyticsReady ? (
                  <DonutChart
                    data={entityData}
                    valueFormat={formatCompactCurrency}
                    emptyMessage="No entity spend yet"
                  />
                ) : (
                  <ChartSkeleton />
                )}
              </SectionCard>
              <SectionCard title="Top vendors">
                {analyticsReady ? (
                  <HBarChart
                    data={vendorData}
                    color={chartColors.info}
                    valueFormat={formatCompactCurrency}
                  />
                ) : (
                  <ChartSkeleton />
                )}
              </SectionCard>
              <SectionCard title="Spend by category">
                {analyticsReady ? (
                  <DonutChart
                    data={categoryData}
                    valueFormat={formatCompactCurrency}
                    emptyMessage="No categorized spend yet"
                  />
                ) : (
                  <ChartSkeleton />
                )}
              </SectionCard>
            </div>
          </>
        )}

        {/* Overdue section */}
        {overdue.length > 0 && (
          <Card className="border-warning-soft-fg/30 bg-warning-soft-bg/40 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BellRing className="h-5 w-5 text-warning" />
                <div>
                  <p className="font-semibold text-warning-soft-fg">
                    {overdue.length} invoice{overdue.length === 1 ? "" : "s"}{" "}
                    overdue (72h+)
                  </p>
                  <p className="text-sm text-warning-soft-fg">
                    Awaiting exec approval past the 72-hour threshold.
                  </p>
                </div>
              </div>
              <Button onClick={bulkRemind} loading={reminding} variant="primary">
                <BellRing className="h-4 w-4" />
                Remind all
              </Button>
            </div>
          </Card>
        )}

        {/* Manual review queue */}
        {reviewInvoices.length > 0 && (
          <Card className="border-danger-soft-fg/30">
            <div className="flex items-center gap-2 border-b border-line bg-danger-soft-bg px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-danger" />
              <h2 className="font-display text-sm font-semibold text-danger-soft-fg">
                Manual Review Queue ({reviewInvoices.length})
              </h2>
            </div>
            <InvoiceTable invoices={reviewInvoices} />
          </Card>
        )}

        {/* Invoice queue */}
        <Card>
          <div className="flex flex-col gap-3 border-b border-line p-4">
            <div className="flex flex-wrap gap-1">
              {STATUS_TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    tab === t.key
                      ? "bg-primary text-primary-fg"
                      : "text-ink-muted hover:bg-surface-2"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                placeholder="Search vendor…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-48"
              />
              <select
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">All entities</option>
                {BUSINESS_ENTITIES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
              <select
                value={approver}
                onChange={(e) => setApprover(e.target.value)}
                className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">All approvers</option>
                {APPROVERS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : (
            <InvoiceTable
              invoices={filtered}
              emptyTitle="No invoices match these filters"
            />
          )}
        </Card>
      </div>
    </div>
  );
}
