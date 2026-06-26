import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Eraser } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  Button,
  Spinner,
  EmptyState,
  Select,
} from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { downloadBlob, formatDate } from "@/lib/utils";
import { buildSheet, buildWorkbook } from "@/lib/workbook";
import { AUDIT_ACTION, ROLES } from "@/lib/constants";
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

const PAGE_LIMIT = 500;
const EXCEL_HEADER = ["Timestamp", "User", "Action", "Vendor", "Note"];

export default function AuditPage() {
  const profile = useProfile();
  const isAdmin = profile.role === ROLES.ADMIN;

  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [clearing, setClearing] = useState(false);

  const query = new URLSearchParams();
  if (action) query.set("action", action);
  if (userId) query.set("userId", userId);
  if (from) query.set("from", new Date(from).toISOString());
  if (to) query.set("to", new Date(to + "T23:59:59").toISOString());
  if (showAll) query.set("showAll", "1");

  const { data, loading, refetch } = useApi<{ entries: GlobalAuditEntry[] }>(
    `/api/audit?${query.toString()}`,
  );
  const { data: usersData } = useApi<{ users: UserRow[] }>("/api/users");

  const entries = data?.entries ?? [];
  const atCap = entries.length >= PAGE_LIMIT;

  // Projects the loaded entries into an .xlsx Blob. Shared by "Download Excel"
  // AND the export-before-clear safety step.
  function buildExcel(): Blob {
    const rows = entries.map((e) => [
      new Date(e.created_at).toISOString(),
      e.user_name,
      e.action,
      e.vendor ?? "",
      e.note ?? "",
    ]);
    const sheet = buildSheet("Audit", EXCEL_HEADER, rows);
    return buildWorkbook([sheet]);
  }

  function downloadExcel() {
    if (entries.length === 0) {
      toast.info("No audit entries to export.");
      return;
    }
    try {
      const blob = buildExcel();
      downloadBlob(
        blob,
        `InvoiceIQ_Audit_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
      if (atCap) {
        toast.info(
          `Exported the first ${PAGE_LIMIT} rows — more may exist beyond the cap.`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Excel export failed");
    }
  }

  // F3b: "Clear" sets a per-user view cutoff — it NEVER deletes audit rows.
  // EXPORT the Excel FIRST (locked safety); if it throws, abort the clear.
  async function clearAudit() {
    if (
      !window.confirm(
        "Clear your audit view? This hides older entries from your view only (no rows are ever deleted; everyone else's view is unaffected). An Excel copy downloads first.",
      )
    )
      return;

    setClearing(true);
    try {
      // STEP 1 (locked): export must succeed before the cutoff is set.
      const blob = buildExcel();
      downloadBlob(
        blob,
        `InvoiceIQ_Audit_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (err) {
      // Export failed → ABORT. Do NOT set the cutoff.
      toast.error(
        err instanceof Error
          ? `Export failed — nothing cleared: ${err.message}`
          : "Export failed — nothing cleared.",
      );
      setClearing(false);
      return;
    }

    try {
      // STEP 2: set the cutoff only after the Excel is safely downloaded.
      await api.clearAudit();
      toast.success("Audit view cleared");
      setShowAll(false);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Audit Trail"
        subtitle="Every state change, chronologically"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadExcel}
              disabled={entries.length === 0}
            >
              <Download className="h-4 w-4" /> Download Excel
            </Button>
            {isAdmin && (
              <Button
                variant="danger"
                size="sm"
                onClick={clearAudit}
                loading={clearing}
                title="Export the audit log to Excel, then hide older entries from your view (rows are never deleted)."
              >
                <Eraser className="h-4 w-4" /> Clear
              </Button>
            )}
          </div>
        }
      />

      <div className="p-6">
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
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
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
              />
              Show all
            </label>
          </div>

          {atCap && (
            <div className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-muted">
              Showing the first {PAGE_LIMIT} entries — more may exist. Narrow the
              filters to refine.
            </div>
          )}

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
