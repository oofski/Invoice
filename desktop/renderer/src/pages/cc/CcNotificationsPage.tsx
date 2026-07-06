import { useCallback, useEffect, useState } from "react";
import { Mail, Bell, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { downloadSheet, exportDateStamp } from "@/cc/ccExport";
import {
  ccApi,
  notificationTxIds,
  type Notification,
  type NotificationDelivery,
} from "@/cc/ccApi";

const DELIVERY_STYLE: Record<NotificationDelivery, string> = {
  SENT: "bg-success-soft-bg text-success-soft-fg ring-1 ring-inset ring-success-soft-fg/15",
  MAILTO: "bg-info-soft-bg text-info-soft-fg ring-1 ring-inset ring-info-soft-fg/15",
  NOT_CONFIGURED:
    "bg-warning-soft-bg text-warning-soft-fg ring-1 ring-inset ring-warning-soft-fg/15",
  FAILED: "bg-danger-soft-bg text-danger-soft-fg ring-1 ring-inset ring-danger-soft-fg/15",
};

const DELIVERY_LABEL: Record<NotificationDelivery, string> = {
  SENT: "Sent",
  MAILTO: "Mailto",
  NOT_CONFIGURED: "Not configured",
  FAILED: "Failed",
};

function txCount(n: Notification): number {
  if (typeof n.tx_count === "number") return n.tx_count;
  return notificationTxIds(n).length;
}

export default function CcNotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Notification | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.listNotifications();
      setNotifications(res.notifications ?? []);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function exportExcel() {
    if (notifications.length === 0) {
      toast.info("Nothing to export.");
      return;
    }
    const header = ["Date", "To", "Subject", "# Tx", "Follow-up", "Delivery"];
    const rows = notifications.map((n) => [
      formatDate(n.created_at),
      n.cardholder_name ?? n.email_to,
      n.subject,
      txCount(n),
      n.is_followup ? "Yes" : "No",
      DELIVERY_LABEL[n.delivery] ?? n.delivery,
    ]);
    downloadSheet(
      `CC_Notifications_${exportDateStamp()}.xlsx`,
      "Notifications",
      header,
      rows,
    );
  }

  async function openDetail(n: Notification) {
    setSelected(n);
    setDetailLoading(true);
    try {
      const res = await ccApi.getNotification(n.id);
      setSelected(res.notification);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load notification");
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Notifications"
        subtitle="History of receipt-reminder emails sent to cardholders"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={exportExcel}
            disabled={notifications.length === 0}
          >
            <Download className="h-4 w-4" />
            Export Excel
          </Button>
        }
      />
      <CcSubNav />

      <div className="p-6">
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Bell className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Sent reminders ({notifications.length})
            </h2>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : notifications.length === 0 ? (
            <EmptyState
              title="No notifications yet"
              description="Reminders sent from the Dashboard or Receipt Tracker appear here."
              icon={<Mail className="h-8 w-8" />}
            />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">To</th>
                    <th className="px-4 py-2.5 font-medium">Subject</th>
                    <th className="px-4 py-2.5 font-medium"># Tx</th>
                    <th className="px-4 py-2.5 font-medium">Delivery</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((n) => (
                    <tr
                      key={n.id}
                      className="cursor-pointer border-b border-line transition-colors hover:bg-surface-2"
                      onClick={() => openDetail(n)}
                    >
                      <td className="px-4 py-3 text-ink-muted">
                        {formatDate(n.created_at)}
                      </td>
                      <td className="px-4 py-3 font-medium text-ink">
                        {n.cardholder_name ?? n.email_to}
                        {n.is_followup ? (
                          <span className="ml-2 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-muted">
                            follow-up
                          </span>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        <span className="line-clamp-1">{n.subject}</span>
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {txCount(n)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                            DELIVERY_STYLE[n.delivery] ??
                              "bg-surface-2 text-ink-muted ring-1 ring-inset ring-line",
                          )}
                        >
                          {DELIVERY_LABEL[n.delivery] ?? n.delivery}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs font-medium text-accent">
                          View
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.subject ?? "Notification"}
        className="max-w-2xl"
      >
        {detailLoading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : selected ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-ink-muted">To</p>
                <p className="text-ink">{selected.email_to}</p>
              </div>
              <div>
                <p className="text-xs text-ink-muted">Sent</p>
                <p className="text-ink">{formatDate(selected.created_at)}</p>
              </div>
              <div>
                <p className="text-xs text-ink-muted">Delivery</p>
                <p className="text-ink">
                  {DELIVERY_LABEL[selected.delivery] ?? selected.delivery}
                </p>
              </div>
              <div>
                <p className="text-xs text-ink-muted">Transactions</p>
                <p className="text-ink">{txCount(selected)}</p>
              </div>
            </div>
            <div className="rounded-lg border border-line bg-surface p-4">
              {selected.body_html ? (
                <div
                  className="cc-email-body text-sm text-ink"
                  // The body is our own server-generated reminder HTML.
                  dangerouslySetInnerHTML={{ __html: selected.body_html }}
                />
              ) : (
                <p className="text-sm text-ink-muted">
                  Body unavailable for this notification.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
