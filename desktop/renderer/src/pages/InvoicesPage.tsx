import { useMemo, useState } from "react";
import { Download, Archive } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Spinner, Input, Button } from "@/components/ui/primitives";
import { InvoiceTable, type QueueInvoice } from "@/components/InvoiceTable";
import { useApi } from "@/hooks/useApi";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { downloadBlob, formatCurrency, formatDate } from "@/lib/utils";
import { buildSheet, buildWorkbook } from "@/lib/workbook";
import { INVOICE_STATUS, BUSINESS_ENTITIES, ROLES } from "@/lib/constants";

const STATUSES = [
  "ALL",
  INVOICE_STATUS.PROCESSING,
  INVOICE_STATUS.PENDING_APPROVAL,
  INVOICE_STATUS.NEEDS_REVIEW,
  INVOICE_STATUS.APPROVED,
  INVOICE_STATUS.REJECTED,
  INVOICE_STATUS.EXPORTED,
];

const PAGE_LIMIT = 500;

const EXCEL_HEADER = [
  "Vendor",
  "Number",
  "Entity",
  "Class",
  "Status",
  "Approver",
  "Amount",
  "Date",
];

export default function InvoicesPage() {
  const profile = useProfile();
  const isAdmin = profile.role === ROLES.ADMIN;

  const [status, setStatus] = useState("ALL");
  const [entity, setEntity] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [unarchivingId, setUnarchivingId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data, loading, error, refetch } = useApi<{ invoices: QueueInvoice[] }>(
    `/api/invoices?limit=${PAGE_LIMIT}${showArchived ? "&includeArchived=1" : ""}`,
  );

  const invoices = useMemo(() => data?.invoices ?? [], [data]);
  const filtered = useMemo(
    () =>
      invoices.filter((i) => {
        if (status !== "ALL" && i.status !== status) return false;
        if (entity && i.business !== entity) return false;
        if (search && !i.vendor.toLowerCase().includes(search.toLowerCase()))
          return false;
        return true;
      }),
    [invoices, status, entity, search],
  );

  const atCap = invoices.length >= PAGE_LIMIT;

  // Empty-state diagnostics: distinguish "filtered to nothing" from "nothing to
  // show" so the user can recover (clear filters / reveal archived) instead of
  // staring at a silently-empty table.
  const hasFilters = status !== "ALL" || !!entity || !!search;
  const isPrivileged =
    profile.role === ROLES.ADMIN || profile.role === ROLES.ACCOUNTANT;
  function clearFilters() {
    setStatus("ALL");
    setEntity("");
    setSearch("");
  }

  // Projects the currently-filtered rows into an .xlsx Blob. Shared by the
  // "Download Excel" button AND the export-before-clear safety step.
  function buildFilteredExcel(): Blob {
    const rows = filtered.map((i) => [
      i.vendor,
      i.invoice_number,
      i.business ?? "",
      i.class && i.class !== "None" ? i.class : "",
      i.status,
      i.approved_by ?? "",
      formatCurrency(Number(i.total_amount)),
      formatDate(i.inv_date) === "—" ? "" : formatDate(i.inv_date),
    ]);
    const sheet = buildSheet("Invoices", EXCEL_HEADER, rows);
    return buildWorkbook([sheet]);
  }

  function downloadExcel() {
    if (filtered.length === 0) {
      toast.info("No invoices to export.");
      return;
    }
    try {
      const blob = buildFilteredExcel();
      downloadBlob(
        blob,
        `InvoiceIQ_Invoices_${new Date().toISOString().slice(0, 10)}.xlsx`,
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

  // F3b: "Clear" = SAFE ARCHIVE. EXPORT the Excel FIRST (locked safety), then
  // archive the currently-filtered rows. If the export throws, abort the clear.
  async function clearArchive() {
    const ids = filtered.map((i) => i.id);
    if (ids.length === 0) {
      toast.info("Nothing to clear.");
      return;
    }
    if (
      !window.confirm(
        `Archive ${ids.length} invoice(s)? They will be hidden from the default list (records, PDFs, and line items are preserved and reversible). An Excel copy downloads first.`,
      )
    )
      return;

    setClearing(true);
    try {
      // STEP 1 (locked): export must succeed before any row is archived.
      const blob = buildFilteredExcel();
      downloadBlob(
        blob,
        `InvoiceIQ_Invoices_${new Date().toISOString().slice(0, 10)}.xlsx`,
      );
    } catch (err) {
      // Export failed → ABORT. Do NOT archive.
      toast.error(
        err instanceof Error
          ? `Export failed — nothing archived: ${err.message}`
          : "Export failed — nothing archived.",
      );
      setClearing(false);
      return;
    }

    try {
      // STEP 2: archive only after the Excel is safely downloaded.
      const res = await api.archiveInvoices(ids);
      toast.success(`Archived ${res.archived} invoice(s)`);
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Archive failed");
    } finally {
      setClearing(false);
    }
  }

  // Row-level "Download PDF" — mirrors the invoice detail page's download
  // (same /pdf endpoint, so an approved/exported invoice arrives stamped).
  // Read-only: fetches the file and saves it; nothing about the invoice changes.
  async function downloadPdf(inv: QueueInvoice) {
    setDownloadingId(inv.id);
    try {
      const blob = await api.getBlob(`/api/invoices/${inv.id}/pdf`);
      downloadBlob(blob, `${inv.vendor}_${inv.invoice_number}.pdf`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Download failed");
    } finally {
      setDownloadingId(null);
    }
  }

  async function unarchive(id: string) {
    setUnarchivingId(id);
    try {
      await api.unarchiveInvoice(id);
      toast.success("Invoice unarchived");
      await refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Unarchive failed");
    } finally {
      setUnarchivingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="All invoices you can access"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={downloadExcel}
              disabled={filtered.length === 0}
            >
              <Download className="h-4 w-4" />
              Download Excel
            </Button>
            {isAdmin && (
              <Button
                variant="danger"
                size="sm"
                onClick={clearArchive}
                loading={clearing}
                disabled={filtered.length === 0}
                title="Export the filtered invoices to Excel, then archive (hide) them. Reversible."
              >
                <Archive className="h-4 w-4" />
                Clear
              </Button>
            )}
          </div>
        }
      />
      <div className="p-6">
        <Card>
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
            <Input
              placeholder="Search vendor…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48"
            />
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s === "ALL" ? "All statuses" : s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
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
            <label className="ml-auto inline-flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived
            </label>
          </div>
          {atCap && (
            <div className="border-b border-line bg-surface-2 px-4 py-2 text-xs text-ink-muted">
              Showing the first {PAGE_LIMIT} rows — more may exist. Narrow the
              filters to refine.
            </div>
          )}
          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : error ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-danger">
                Couldn't load invoices.
              </p>
              <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">
                {error}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-4"
                onClick={() => refetch()}
              >
                Retry
              </Button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-ink">
                No invoices to show.
              </p>
              {hasFilters ? (
                <>
                  <p className="mt-1 text-xs text-ink-muted">
                    No invoices match the current filters.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-4"
                    onClick={clearFilters}
                  >
                    Clear filters
                  </Button>
                </>
              ) : !showArchived ? (
                <>
                  <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">
                    {isPrivileged
                      ? "If invoices were archived (for example via “Clear”), they’re hidden from the default list. Records are preserved and reversible."
                      : "You only see invoices assigned to you. Any archived invoices are also hidden."}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-4"
                    onClick={() => setShowArchived(true)}
                  >
                    Show archived
                  </Button>
                </>
              ) : (
                <p className="mx-auto mt-1 max-w-md text-xs text-ink-muted">
                  {isPrivileged
                    ? "There are no invoices yet — upload one from the Upload tab."
                    : "No invoices are assigned to you."}
                </p>
              )}
            </div>
          ) : (
            <InvoiceTable
              invoices={filtered}
              onDownload={downloadPdf}
              downloadingId={downloadingId}
              onUnarchive={isAdmin && showArchived ? unarchive : undefined}
              unarchivingId={unarchivingId}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
