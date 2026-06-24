import { useMemo, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Spinner, Input } from "@/components/ui/primitives";
import { InvoiceTable, type QueueInvoice } from "@/components/InvoiceTable";
import { useApi } from "@/hooks/useApi";
import { INVOICE_STATUS, BUSINESS_ENTITIES } from "@/lib/constants";

const STATUSES = [
  "ALL",
  INVOICE_STATUS.PROCESSING,
  INVOICE_STATUS.PENDING_APPROVAL,
  INVOICE_STATUS.NEEDS_REVIEW,
  INVOICE_STATUS.APPROVED,
  INVOICE_STATUS.REJECTED,
  INVOICE_STATUS.EXPORTED,
];

export default function InvoicesPage() {
  const { data, loading } = useApi<{ invoices: QueueInvoice[] }>(
    "/api/invoices?limit=500",
  );
  const [status, setStatus] = useState("ALL");
  const [entity, setEntity] = useState("");
  const [search, setSearch] = useState("");

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

  return (
    <div>
      <PageHeader title="Invoices" subtitle="All invoices you can access" />
      <div className="p-6">
        <Card>
          <div className="flex flex-wrap gap-2 border-b border-line p-4">
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
          </div>
          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : (
            <InvoiceTable invoices={filtered} />
          )}
        </Card>
      </div>
    </div>
  );
}
