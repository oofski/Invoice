import { useState } from "react";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  Button,
  Spinner,
  EmptyState,
  Select,
} from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { formatDate } from "@/lib/utils";
import { AUDIT_ACTION } from "@/lib/constants";
import type { UserRow } from "@/lib/types";

interface GlobalAuditEntry {
  id: string;
  invoice_id: string | null;
  action: string;
  note: string | null;
  created_at: string;
  user_name: string;
  vendor: string | null;
}

function csvEscape(s: string) {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = new URLSearchParams();
  if (action) query.set("action", action);
  if (userId) query.set("userId", userId);
  if (from) query.set("from", new Date(from).toISOString());
  if (to) query.set("to", new Date(to + "T23:59:59").toISOString());

  const { data, loading } = useApi<{ entries: GlobalAuditEntry[] }>(
    `/api/audit?${query.toString()}`,
  );
  const { data: usersData } = useApi<{ users: UserRow[] }>("/api/users");

  const entries = data?.entries ?? [];

  function exportCsv() {
    const header = ["Timestamp", "User", "Action", "Vendor", "Note"];
    const rows = entries.map((e) =>
      [
        new Date(e.created_at).toISOString(),
        e.user_name,
        e.action,
        e.vendor ?? "",
        e.note ?? "",
      ]
        .map((x) => csvEscape(String(x)))
        .join(","),
    );
    const csv = [header.join(","), ...rows].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `InvoiceIQ_Audit_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        subtitle="Every state change, chronologically"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={exportCsv}
            disabled={entries.length === 0}
          >
            <Download className="h-4 w-4" /> Export CSV
          </Button>
        }
      />

      <div className="p-6">
        <Card>
          <div className="flex flex-wrap gap-2 border-b border-line p-4">
            <Select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="max-w-[200px]"
            >
              <option value="">All actions</option>
              {Object.values(AUDIT_ACTION).map((a) => (
                <option key={a} value={a}>
                  {a.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
            <Select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="max-w-[200px]"
            >
              <option value="">All users</option>
              {(usersData?.users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:ring-ring"
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:ring-ring"
            />
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState title="No audit entries match these filters" />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">When</th>
                    <th className="px-4 py-2.5 font-medium">User</th>
                    <th className="px-4 py-2.5 font-medium">Action</th>
                    <th className="px-4 py-2.5 font-medium">Invoice</th>
                    <th className="px-4 py-2.5 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} className="border-b border-line">
                      <td className="whitespace-nowrap px-4 py-2.5 text-ink-muted">
                        {formatDate(e.created_at)}{" "}
                        {new Date(e.created_at).toLocaleTimeString("en-US", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">
                        {e.user_name}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-muted">
                          {e.action.replace(/_/g, " ")}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        {e.invoice_id ? (
                          <Link
                            to={`/invoices/${e.invoice_id}`}
                            className="text-accent hover:underline"
                          >
                            {e.vendor ?? "View"}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">
                        {e.note ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
