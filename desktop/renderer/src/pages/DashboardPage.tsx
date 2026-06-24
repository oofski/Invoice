import { useEffect, useMemo, useState } from "react";
import {
  Clock,
  CheckSquare,
  AlertTriangle,
  Download,
  XCircle,
  FileCheck,
  BellRing,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { Card, Button, Spinner, Input } from "@/components/ui/primitives";
import { InvoiceTable, type QueueInvoice } from "@/components/InvoiceTable";
import { RemindApproversModal } from "@/components/RemindApproversModal";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { useProfile } from "@/components/ProfileProvider";
import { formatCurrency } from "@/lib/utils";
import {
  BUSINESS_ENTITIES,
  APPROVERS,
  INVOICE_STATUS,
  ROLES,
} from "@/lib/constants";
import type { DashboardStats } from "@/lib/types";

const STATUS_TABS = [
  { key: "ALL", label: "All" },
  { key: INVOICE_STATUS.PROCESSING, label: "Processing" },
  { key: INVOICE_STATUS.PENDING_APPROVAL, label: "Awaiting Approval" },
  { key: "REVIEW", label: "Needs Review" },
  { key: INVOICE_STATUS.APPROVED, label: "Export Ready" },
  { key: INVOICE_STATUS.REJECTED, label: "Rejected" },
  { key: INVOICE_STATUS.EXPORTED, label: "Exported" },
];

export default function DashboardPage() {
  const profile = useProfile();
  const canRemind =
    profile.role === ROLES.EXECUTIVE || profile.role === ROLES.ADMIN;
  const { data: stats, refetch: refetchStats } =
    useApi<DashboardStats>("/api/dashboard/stats");
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
      refetchOverdue();
    }, 15000);
    return () => clearInterval(id);
  }, [refetch, refetchStats, refetchOverdue]);

  const invoices = useMemo(() => invData?.invoices ?? [], [invData]);

  const filtered = useMemo(() => {
    return invoices.filter((i) => {
      if (tab === "REVIEW" && (i.review_count ?? 0) === 0) return false;
      else if (tab !== "ALL" && tab !== "REVIEW" && i.status !== tab)
        return false;
      if (entity && i.business !== entity) return false;
      if (approver && i.approved_by !== approver) return false;
      if (search && !i.vendor.toLowerCase().includes(search.toLowerCase()))
        return false;
      return true;
    });
  }, [invoices, tab, entity, approver, search]);

  const reviewInvoices = invoices.filter((i) => (i.review_count ?? 0) > 0);
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
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
          <StatCard
            label="Total Pending"
            value={stats?.totalPending ?? "—"}
            tone="slate"
            icon={<Clock className="h-4 w-4" />}
          />
          <StatCard
            label="Awaiting Approval"
            value={stats?.awaitingApproval ?? "—"}
            tone="amber"
            icon={<CheckSquare className="h-4 w-4" />}
          />
          <StatCard
            label="Needs Review"
            value={stats?.needsReview ?? "—"}
            tone="red"
            icon={<AlertTriangle className="h-4 w-4" />}
          />
          <StatCard
            label="Export Ready"
            value={stats?.exportReady ?? "—"}
            tone="emerald"
            icon={<FileCheck className="h-4 w-4" />}
            href="/export"
          />
          <StatCard
            label="Rejected"
            value={stats?.rejected ?? "—"}
            tone="red"
            icon={<XCircle className="h-4 w-4" />}
          />
          <StatCard
            label="Exported (Month)"
            value={stats?.exportedThisMonth ?? "—"}
            tone="blue"
            icon={<Download className="h-4 w-4" />}
          />
        </div>

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

        {/* Entity totals */}
        {stats?.byEntity && stats.byEntity.length > 0 && (
          <Card className="p-4">
            <h2 className="mb-3 font-display text-sm font-semibold text-ink">
              Spend by Entity
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {stats.byEntity.map((e) => (
                <div key={e.entity} className="rounded-lg bg-surface-2 p-3">
                  <p className="text-xs text-ink-muted">{e.entity}</p>
                  <p className="text-lg font-bold text-ink tabular-nums">
                    {formatCurrency(e.total)}
                  </p>
                  <p className="text-xs text-ink-subtle">{e.count} invoices</p>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
