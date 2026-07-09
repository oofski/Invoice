import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Download,
  AlertTriangle,
  FileDown,
  History,
  FileSpreadsheet,
  FileArchive,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { formatCurrency, formatDate, cn, downloadBlob } from "@/lib/utils";
import { INVOICE_STATUS } from "@/lib/constants";
import { buildBillWorkbook } from "@/lib/workbook";
import { zipPdfs } from "@/lib/zip";
import type { QueueInvoice } from "@/components/InvoiceTable";
import type { ExportRow, FactorResponse, EntitySheet } from "@/lib/types";

function downloadCsv(csv: string, fileName: string) {
  downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8;" }), fileName);
}

/** YYYYMMDD for download file names. */
function yyyymmdd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * The 409 body the export/factor routes return when selected invoices carry
 * review flags and the request omitted `acknowledgeWarnings` (FIX-11).
 */
interface ReviewWarning {
  warning: "REVIEW_FLAGS";
  flaggedLines: Record<string, number>;
  locationAmbiguous: string[];
  reconciliation: Record<string, number>;
}

/** Narrows a thrown error to the export "review flags" 409 warning. */
function isReviewWarning(
  err: unknown,
): err is ApiError & { body: ReviewWarning } {
  return (
    err instanceof ApiError &&
    err.status === 409 &&
    typeof err.body === "object" &&
    err.body !== null &&
    (err.body as { warning?: string }).warning === "REVIEW_FLAGS"
  );
}

/** Human-readable confirm summary of the flags blocking a warned export. */
function reviewWarningMessage(w: ReviewWarning): string {
  const lines = ["Some selected invoices have review flags:", ""];
  const flagged = w.flaggedLines ?? {};
  const invoiceCount = Object.keys(flagged).length;
  const lineCount = Object.values(flagged).reduce((a, b) => a + b, 0);
  if (invoiceCount > 0) {
    lines.push(
      `• ${lineCount} flagged line item${lineCount === 1 ? "" : "s"} across ${invoiceCount} invoice${invoiceCount === 1 ? "" : "s"}`,
    );
  }
  const ambiguous = w.locationAmbiguous ?? [];
  if (ambiguous.length > 0) {
    lines.push(
      `• ${ambiguous.length} invoice${ambiguous.length === 1 ? "" : "s"} with an unconfirmed location`,
    );
  }
  const recon = Object.keys(w.reconciliation ?? {}).length;
  if (recon > 0) {
    lines.push(
      `• ${recon} invoice${recon === 1 ? "" : "s"} with a reconciliation gap`,
    );
  }
  lines.push("", "Export anyway?");
  return lines.join("\n");
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
  // The last Factor result, kept so the per-entity download buttons can rebuild
  // one entity's sheet on demand (view-only — no re-export, no server call).
  const [factorResult, setFactorResult] = useState<FactorResponse | null>(null);
  const [zipping, setZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const invoices = data?.invoices ?? [];
  // v1.6.0: only sentinel (REQUIRES_MANUAL_REVIEW) lines hard-block export.
  // Flagged-but-coded invoices are selectable (they export with a warning).
  const ready = invoices.filter((i) => (i.blocking_count ?? 0) === 0);
  const blocked = invoices.filter((i) => (i.blocking_count ?? 0) > 0);

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

  // Fires the CSV export. `acknowledge` threads FIX-11's acknowledgeWarnings
  // through the existing open request body (no api.ts change needed).
  async function doExport(ids: string[], acknowledge: boolean) {
    const res = await api.post<{
      csv: string;
      fileName: string;
      rowCount: number;
      invoiceCount: number;
    }>("/api/export", {
      invoiceIds: ids,
      ...(acknowledge ? { acknowledgeWarnings: true } : {}),
    });
    downloadCsv(res.csv, res.fileName);
    toast.success(
      `Exported ${res.invoiceCount} invoices (${res.rowCount} lines)`,
    );
    setSelected(new Set());
    refetch();
    refetchHistory();
  }

  async function runExport() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      await doExport(ids, false);
    } catch (err) {
      // 409 REVIEW_FLAGS → confirm, then retry acknowledged.
      if (isReviewWarning(err)) {
        if (window.confirm(reviewWarningMessage(err.body))) {
          try {
            await doExport(ids, true);
          } catch (err2) {
            toast.error(
              err2 instanceof ApiError ? err2.message : "Export failed",
            );
          }
        }
      } else {
        toast.error(err instanceof ApiError ? err.message : "Export failed");
      }
    } finally {
      setExporting(false);
    }
  }

  async function doFactor(ids: string[], acknowledge: boolean) {
    const res = await api.post<FactorResponse>("/api/export/factor", {
      invoiceIds: ids,
      ...(acknowledge ? { acknowledgeWarnings: true } : {}),
    });
    const blob = buildBillWorkbook(res.entities, res.header);
    downloadBlob(blob, res.fileName);
    // Keep the result so the user can also grab any single entity's sheet.
    setFactorResult(res);
    toast.success(
      `Factored ${res.invoiceCount} invoices into ${res.entities.length} entity tab(s)`,
    );
    setSelected(new Set());
    refetch();
    refetchHistory();
  }

  /** Rebuild + download ONE entity's sheet as its own .xlsx (from the last Factor). */
  function downloadEntitySheet(entity: EntitySheet) {
    if (!factorResult) return;
    const blob = buildBillWorkbook([entity], factorResult.header);
    downloadBlob(blob, `${entity.entity}_bills_${yyyymmdd()}.xlsx`);
  }

  async function runFactor() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setFactoring(true);
    try {
      await doFactor(ids, false);
    } catch (err) {
      if (isReviewWarning(err)) {
        if (window.confirm(reviewWarningMessage(err.body))) {
          try {
            await doFactor(ids, true);
          } catch (err2) {
            toast.error(
              err2 instanceof ApiError ? err2.message : "Factoring failed",
            );
          }
        }
      } else {
        toast.error(err instanceof ApiError ? err.message : "Factoring failed");
      }
    } finally {
      setFactoring(false);
    }
  }

  // F1: zip every export-ready approved invoice that has a PDF. Pulls each PDF
  // from the existing /pdf endpoint (so APPROVED files arrive stamped), zips
  // client-side, and downloads a single .zip. Invoices without a PDF are skipped.
  const zipScope = ready.filter((i) => i.has_pdf !== false);

  async function downloadZip() {
    const items = zipScope.map((i) => ({
      id: i.id,
      fileName: `${i.vendor}_${i.invoice_number}`,
    }));
    if (items.length === 0) {
      toast.info("No approved invoices with a PDF to download.");
      return;
    }
    setZipping(true);
    setZipProgress({ done: 0, total: items.length });
    try {
      const blob = await zipPdfs(items, (done, total) =>
        setZipProgress({ done, total }),
      );
      downloadBlob(blob, `InvoiceIQ_Approved_PDFs_${yyyymmdd()}.zip`);
      toast.success(`Zipped ${items.length} approved PDF(s)`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Zip download failed");
    } finally {
      setZipping(false);
      setZipProgress(null);
    }
  }

  async function reDownload(row: ExportRow) {
    setDownloadingId(row.id);
    try {
      if (row.file_name.toLowerCase().endsWith(".xlsx")) {
        // Factor exports store the structured `{entities,header,...}` JSON
        // payload as their `content`; rebuild the .xlsx workbook client-side
        // (same path as the initial Factor export) instead of streaming the
        // raw JSON bytes under an .xlsx name, which Excel can't open.
        const res = await api.get<FactorResponse>(`/api/export/${row.id}`);
        const blob = buildBillWorkbook(res.entities, res.header);
        downloadBlob(blob, row.file_name);
      } else {
        // CSV exports: the worker already serves valid CSV bytes verbatim.
        const blob = await api.getBlob(`/api/export/${row.id}`);
        downloadBlob(blob, row.file_name);
      }
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
            <Button
              variant="secondary"
              onClick={downloadZip}
              loading={zipping}
              disabled={zipScope.length === 0}
              title="Download every export-ready approved invoice's PDF as a single .zip"
            >
              <FileArchive className="h-4 w-4" />
              {zipping && zipProgress
                ? `Zipping ${zipProgress.done} of ${zipProgress.total}…`
                : "Download approved PDFs (.zip)"}
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

        {/* Per-entity downloads from the last Factor (the combined all-tabs
            workbook already downloaded; this adds one file per entity). */}
        {factorResult && factorResult.entities.length > 0 && (
          <Card>
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <FileSpreadsheet className="h-4 w-4 text-ink-subtle" />
              <h2 className="font-display text-sm font-semibold text-ink">
                Download by entity
              </h2>
              <span className="ml-auto text-xs text-ink-subtle">
                from your last factor · {factorResult.invoiceCount} invoice
                {factorResult.invoiceCount === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-wrap gap-2 p-4">
              {factorResult.entities.map((e) => (
                <Button
                  key={e.entity}
                  variant="secondary"
                  size="sm"
                  onClick={() => downloadEntitySheet(e)}
                  title={`Download just ${e.entity}'s bills as its own .xlsx`}
                >
                  <Download className="h-4 w-4" />
                  {e.entity}
                </Button>
              ))}
            </div>
            <p className="px-4 pb-4 text-xs text-ink-subtle">
              Each button saves only that entity’s sheet as its own file. The
              combined all-tabs workbook already downloaded above.
            </p>
          </Card>
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
              description="Approved invoices appear here. Those with a manual-review sentinel line stay in the Blocked section below."
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
                  {ready.map((inv) => {
                    // Selectable but flag it: warns on export until acknowledged.
                    const flags: string[] = [];
                    if ((inv.review_count ?? 0) > 0)
                      flags.push(`${inv.review_count} to review`);
                    if (inv.location_ambiguous) flags.push("Location?");
                    if (inv.reconciliation_delta != null) flags.push("Σ≠Total");
                    const flagged = flags.length > 0;
                    return (
                    <tr
                      key={inv.id}
                      className={cn(
                        "border-b border-line hover:bg-surface-2",
                        flagged && "bg-warning-soft-bg/40",
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
                        {flagged && (
                          <span className="ml-2 inline-flex items-center gap-0.5 text-xs font-medium text-warning">
                            <AlertTriangle className="h-3 w-3" />
                            {flags.join(" · ")}
                          </span>
                        )}
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
                    );
                  })}
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
                      ({inv.blocking_count} item
                      {inv.blocking_count === 1 ? "" : "s"} need review)
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
