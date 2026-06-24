import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Download,
  AlertTriangle,
  FileDown,
  History,
  FileSpreadsheet,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency, formatDate, cn } from "@/lib/utils";
import { INVOICE_STATUS } from "@/lib/constants";
import { buildBillWorkbook } from "@/lib/workbook";
import type { QueueInvoice } from "@/components/InvoiceTable";
import type { ExportRow, FactorResponse } from "@/lib/types";

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsv(csv: string, fileName: string) {
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), fileName);
}

export default function ExportPage() {
  const { data, loading, refetch } = useApi<{ invoices: QueueInvoice[] }>(
    `/api/invoices?status=${INVOICE_STATUS.APPROVED}&limit=500`,
  );
  const { data: historyData, refetch: refetchHistory } = useApi<{
    exports: (ExportRow & { exported_by_name: string })[];
  }>("/api/export");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const [factoring, setFactoring] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const invoices = data?.invoices ?? [];
  const ready = invoices.filter((i) => (i.review_count ?? 0) === 0);
  const blocked = invoices.filter((i) => (i.review_count ?? 0) > 0);

  const allReadySelected =
    ready.length > 0 && ready.every((i) => selected.has(i.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allReadySelected ? new Set() : new Set(ready.map((i) => i.id)));
  }

  const selectedTotal = useMemo(
    () =>
      ready
        .filter((i) => selected.has(i.id))
        .reduce((sum, i) => sum + Number(i.total_amount), 0),
    [ready, selected],
  );

  async function runExport() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const res = await api.post<{
        csv: string;
        fileName: string;
        rowCount: number;
        invoiceCount: number;
      }>("/api/export", { invoiceIds: ids });
      downloadCsv(res.csv, res.fileName);
      toast.success(
        `Exported ${res.invoiceCount} invoices (${res.rowCount} lines)`,
      );
      setSelected(new Set());
      refetch();
      refetchHistory();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  async function runFactor() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setFactoring(true);
    try {
      const res = await api.post<FactorResponse>("/api/export/factor", {
        invoiceIds: ids,
      });
      const blob = buildBillWorkbook(res.entities, res.header);
      downloadBlob(blob, res.fileName);
      toast.success(
        `Factored ${res.invoiceCount} invoices into ${res.entities.length} entity tab(s)`,
      );
      setSelected(new Set());
      refetch();
      refetchHistory();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Factoring failed");
    } finally {
      setFactoring(false);
    }
  }

  async function reDownload(row: ExportRow) {
    setDownloadingId(row.id);
    try {
      const blob = await api.getBlob(`/api/export/${row.id}`);
      downloadBlob(blob, row.file_name);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Batch Export"
        subtitle="Generate a QuickBooks Bills import file for approved invoices"
        actions={
          <div className="flex items-center gap-2">
            <Button
              onClick={runExport}
              loading={exporting}
              disabled={selected.size === 0}
            >
              <Download className="h-4 w-4" />
              Export {selected.size > 0 ? `(${selected.size})` : ""}
            </Button>
            <Button
              variant="secondary"
              onClick={runFactor}
              loading={factoring}
              disabled={selected.size === 0}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Factor invoices for bill import
            </Button>
          </div>
        }
      />

      <div className="space-y-6 p-6">
        {selected.size > 0 && (
          <div className="flex items-center justify-between rounded-lg bg-selected-bg px-4 py-2.5 text-sm text-accent">
            <span>
              {selected.size} invoice{selected.size === 1 ? "" : "s"} selected
            </span>
            <span className="font-semibold tabular-nums">
              {formatCurrency(selectedTotal)}
            </span>
          </div>
        )}

        {/* Export-ready table */}
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <FileDown className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Export Ready ({ready.length})
            </h2>
          </div>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : ready.length === 0 ? (
            <EmptyState
              title="Nothing ready to export"
              description="Approved invoices with no manual-review items will appear here."
            />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={allReadySelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </th>
                    <th className="px-4 py-2.5 font-medium">Vendor</th>
                    <th className="px-4 py-2.5 font-medium">Entity</th>
                    <th className="px-4 py-2.5 font-medium">Class</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      Amount
                    </th>
                    <th className="px-4 py-2.5 font-medium">Approver</th>
                  </tr>
                </thead>
                <tbody>
                  {ready.map((inv) => (
                    <tr
                      key={inv.id}
                      className={cn(
                        "border-b border-line hover:bg-surface-2",
                        selected.has(inv.id) && "bg-selected-bg",
                      )}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(inv.id)}
                          onChange={() => toggle(inv.id)}
                          aria-label={`Select ${inv.vendor}`}
                        />
                      </td>
                      <td className="px-4 py-3 font-medium text-ink">
                        {inv.vendor}
                        <span className="ml-1 text-xs text-ink-subtle">
                          #{inv.invoice_number}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {inv.business}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {inv.class && inv.class !== "None" ? inv.class : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {formatCurrency(Number(inv.total_amount))}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {inv.approved_by}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Blocked */}
        {blocked.length > 0 && (
          <Card className="border-danger-soft-fg/30">
            <div className="flex items-center gap-2 border-b border-line bg-danger-soft-bg px-4 py-3">
              <AlertTriangle className="h-4 w-4 text-danger" />
              <h2 className="font-display text-sm font-semibold text-danger-soft-fg">
                Blocked — Manual review required ({blocked.length})
              </h2>
            </div>
            <ul className="divide-y divide-line">
              {blocked.map((inv) => (
                <li
                  key={inv.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="text-ink-muted">
                    {inv.vendor}{" "}
                    <span className="text-xs text-danger">
                      ({inv.review_count} item
                      {inv.review_count === 1 ? "" : "s"} need review)
                    </span>
                  </span>
                  <Link
                    to={`/invoices/${inv.id}`}
                    className="font-medium text-accent hover:underline"
                  >
                    Resolve
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* Export history */}
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <History className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              Export History
            </h2>
          </div>
          {!historyData?.exports?.length ? (
            <EmptyState title="No exports yet" />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">File</th>
                    <th className="px-4 py-2.5 font-medium">Invoices</th>
                    <th className="px-4 py-2.5 font-medium">Rows</th>
                    <th className="px-4 py-2.5 font-medium">By</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {historyData.exports.map((e) => (
                    <tr key={e.id} className="border-b border-line">
                      <td className="px-4 py-3 text-ink-muted">
                        {formatDate(e.exported_at)}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-ink-muted">
                        {e.file_name}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {e.invoice_ids?.length ?? 0}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">{e.row_count}</td>
                      <td className="px-4 py-3 text-ink-muted">
                        {e.exported_by_name}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => reDownload(e)}
                          disabled={downloadingId === e.id}
                          className="font-medium text-accent hover:underline disabled:opacity-50"
                        >
                          {downloadingId === e.id ? "Downloading…" : "Download"}
                        </button>
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
