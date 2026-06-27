import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ReceiptText,
  CheckCircle2,
  Clock,
  DollarSign,
  BellRing,
  Activity,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate, ageLabel } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { desktop } from "@/lib/desktop";
import {
  ccApi,
  sendCcReminders,
  type DashboardSummary,
  type DashboardCardholderRow,
} from "@/cc/ccApi";

function StatCard({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs uppercase tracking-wide text-ink-muted">
            {label}
          </p>
          <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">
            {value}
          </p>
          {sub && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
        </div>
        <div className="text-ink-subtle">{icon}</div>
      </div>
    </Card>
  );
}

export default function CcDashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [remindingId, setRemindingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.dashboardSummary();
      setSummary(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }, []);

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

  if (loading) {
    return (
      <div>
        <PageHeader title="Credit Card Dashboard" />
        <CcSubNav />
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </div>
    );
  }

  const s = summary;
  const total = s?.total_transactions ?? 0;
  const received = s?.receipts_received ?? 0;
  const pct = total > 0 ? Math.round((received / total) * 100) : 0;

  return (
    <div>
      <PageHeader
        title="Credit Card Dashboard"
        subtitle="Receipt-collection progress for the current cycle"
      />
      <CcSubNav />

      <div className="space-y-6 p-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Open receipts"
            value={String(s?.receipts_pending ?? 0)}
            sub="awaiting submission"
            icon={<Clock className="h-5 w-5" />}
          />
          <StatCard
            label="Received"
            value={`${received}`}
            sub={`${pct}% of ${total}`}
            icon={<CheckCircle2 className="h-5 w-5" />}
          />
          <StatCard
            label="Transactions"
            value={String(total)}
            sub="this cycle"
            icon={<ReceiptText className="h-5 w-5" />}
          />
          <StatCard
            label="Total spend"
            value={formatCurrency(s?.total_spend ?? 0)}
            sub="non-payment charges"
            icon={<DollarSign className="h-5 w-5" />}
          />
        </div>

        {/* Per-cardholder progress */}
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="font-display text-sm font-semibold text-ink">
              Cardholder progress
            </h2>
            <Link
              to="/credit-cards/receipts"
              className="text-xs font-medium text-accent hover:underline"
            >
              Open receipt tracker
            </Link>
          </div>
          {!s?.cardholder_breakdown?.length ? (
            <EmptyState title="No cardholder activity this cycle" />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Card</th>
                    <th className="px-4 py-2.5 font-medium">Open</th>
                    <th className="px-4 py-2.5 font-medium">Received</th>
                    <th className="px-4 py-2.5 font-medium">%</th>
                    <th className="px-4 py-2.5 font-medium">Last notified</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {s.cardholder_breakdown.map((c) => {
                    const cpct = Math.round(c.pct_complete ?? 0);
                    return (
                      <tr
                        key={c.cardholder_id}
                        className="border-b border-line hover:bg-surface-2"
                      >
                        <td className="px-4 py-3 font-medium text-ink">
                          {c.name}
                        </td>
                        <td className="px-4 py-3 text-xs text-ink-muted">
                          {c.card}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-ink-muted">
                          {c.open}
                        </td>
                        <td className="px-4 py-3 tabular-nums text-ink-muted">
                          {c.received}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  cpct >= 100 ? "bg-success" : "bg-accent",
                                )}
                                style={{ width: `${Math.min(100, cpct)}%` }}
                              />
                            </div>
                            <span className="text-xs tabular-nums text-ink-muted">
                              {cpct}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-ink-muted">
                          {c.last_notified_at
                            ? `${ageLabel(c.last_notified_at)} ago`
                            : "—"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => remind(c)}
                            loading={remindingId === c.cardholder_id}
                            disabled={c.open === 0}
                          >
                            <BellRing className="h-3.5 w-3.5" />
                            Remind
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Recent activity */}
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Activity className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Recent activity
            </h2>
          </div>
          {!s?.recent_activity?.length ? (
            <EmptyState title="No recent activity" />
          ) : (
            <ul className="divide-y divide-line">
              {s.recent_activity.map((a, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="text-ink">{a.text}</span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {formatDate(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
