import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookOpen, Download, SlidersHorizontal, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Input, Spinner, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, downloadBlob, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { buildSheet, buildWorkbook, type SheetSpec } from "@/lib/workbook";
import { exportDateStamp } from "@/cc/ccExport";
import { ccApi, type CcLedgerResponse } from "@/cc/ccApi";

// Rows/cardholders/columns derived from the pinned backend contract so the
// component tracks the response shape without re-declaring it.
type LedgerCardholder = CcLedgerResponse["cardholders"][number];
type LedgerRow = LedgerCardholder["rows"][number];

// ---------------------------------------------------------------------------
// Formatting helpers (client + export agree exact-to-cent; negatives in accounting
// parens; blank entity allocations stay blank, never "$0.00").
// ---------------------------------------------------------------------------

/** Round to cents, matching the server's `roundCents`. */
function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Accounting money string: `1,234.56`, negatives in parens `(89.15)`. No `$`. */
function fmtMoney(n: number): string {
  const v = roundCents(n);
  const abs = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return v < 0 ? `(${abs})` : abs;
}

/** `YYYY-MM-DD` → `M/D/YY` (matches the manual workbook). */
function fmtDateMDY(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m) return iso ?? "";
  return `${Number(m[2])}/${Number(m[3])}/${m[1].slice(2)}`;
}

/**
 * Entity allocation for `name`, or undefined when absent. The contract omits
 * blank entities, so a missing key renders/exports blank (not 0). Guarded lookup
 * keeps TS happy without `noUncheckedIndexedAccess`.
 */
function getEntity(map: Record<string, number>, name: string): number | undefined {
  return name in map ? map[name] : undefined;
}

/** A Difference is a "review signal" only when it isn't reconciled to the cent. */
function isUnreconciled(n: number): boolean {
  return Math.abs(n) >= 0.005;
}

/** Excel sheet names are capped at 31 chars; ensure uniqueness within that cap. */
function uniqueSheetName(base: string, used: Set<string>): string {
  const name = (base?.trim() || "Sheet").slice(0, 31);
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let i = 2; ; i++) {
    const suffix = ` (${i})`;
    const candidate = name.slice(0, 31 - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Centered check when true, blank when false (HAVE RECEIPT / IN QB). */
function FlagCell({ on }: { on: boolean }) {
  return (
    <td className="px-3 py-2 text-center">
      {on ? (
        <Check className="mx-auto h-3.5 w-3.5 text-success" aria-label="yes" />
      ) : null}
    </td>
  );
}

/** Right-aligned money; blank when the allocation is absent. */
function MoneyCell({
  value,
  className,
}: {
  value: number | undefined;
  className?: string;
}) {
  return (
    <td className={cn("px-3 py-2 text-right tabular-nums whitespace-nowrap", className)}>
      {value === undefined ? "" : fmtMoney(value)}
    </td>
  );
}

/** Difference: blank/"—" when reconciled, emphasized amber when not. */
function DifferenceCell({ value, footer }: { value: number; footer?: boolean }) {
  const flag = isUnreconciled(value);
  return (
    <td
      className={cn(
        "px-3 py-2 text-right tabular-nums whitespace-nowrap",
        footer && "font-semibold",
      )}
    >
      {flag ? (
        <span className="font-semibold text-warning-soft-fg">{fmtMoney(value)}</span>
      ) : (
        <span className="text-ink-subtle">—</span>
      )}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Cardholder section
// ---------------------------------------------------------------------------

function CardholderSection({
  cardholder,
  columns,
  onRowClick,
}: {
  cardholder: LedgerCardholder;
  columns: CcLedgerResponse["entity_columns"];
  onRowClick: (row: LedgerRow) => void;
}) {
  const chargeSum = roundCents(
    cardholder.rows.reduce((s, r) => s + (r.charge || 0), 0),
  );
  const rowCount = cardholder.rows.length;

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <BookOpen className="h-4 w-4 shrink-0 text-ink-subtle" />
        <h2
          className={cn(
            "font-display text-sm font-semibold",
            cardholder.cardholder_id ? "text-ink" : "text-danger",
          )}
        >
          {cardholder.tab_name}
        </h2>
        {cardholder.card && (
          <span className="text-xs text-ink-muted">{cardholder.card}</span>
        )}
        <span className="ml-auto text-xs text-ink-subtle">
          {rowCount} {rowCount === 1 ? "charge" : "charges"}
        </span>
      </div>

      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[1080px] text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.1em] text-ink-muted">
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-center font-medium">
                Receipt
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-center font-medium">
                QB
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 font-medium">
                Date
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 font-medium">
                Vendor
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-right font-medium">
                Charge
              </th>
              {columns.map((c) => (
                <th
                  key={c.entity_name}
                  className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-right font-medium"
                >
                  {c.label}
                </th>
              ))}
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-right font-medium">
                Total
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 text-right font-medium">
                Difference
              </th>
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 font-medium">
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {cardholder.rows.map((r) => {
              const flagged = isUnreconciled(r.difference);
              return (
                <tr
                  key={r.transaction_id}
                  onClick={() => onRowClick(r)}
                  className={cn(
                    "cursor-pointer border-b border-line transition-colors hover:bg-surface-2",
                    flagged && "bg-warning-soft-bg/50",
                  )}
                >
                  <FlagCell on={r.have_receipt} />
                  <FlagCell on={r.in_qb} />
                  <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                    {fmtDateMDY(r.date)}
                  </td>
                  <td className="px-3 py-2 font-medium text-ink">{r.vendor}</td>
                  <MoneyCell
                    value={r.charge}
                    className={r.charge < 0 ? "text-danger" : "text-ink"}
                  />
                  {columns.map((c) => (
                    <MoneyCell
                      key={c.entity_name}
                      value={getEntity(r.entities, c.entity_name)}
                      className="text-ink-muted"
                    />
                  ))}
                  <MoneyCell value={r.total} className="text-ink" />
                  <DifferenceCell value={r.difference} />
                  <td className="px-3 py-2 text-xs text-ink-muted">{r.notes || ""}</td>
                </tr>
              );
            })}
            {rowCount === 0 && (
              <tr>
                <td
                  colSpan={8 + columns.length}
                  className="px-3 py-6 text-center text-sm text-ink-subtle"
                >
                  No charges in this cycle.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line bg-surface-2 text-sm font-semibold text-ink">
              <td className="px-3 py-2.5" />
              <td className="px-3 py-2.5" />
              <td className="px-3 py-2.5" />
              <td className="px-3 py-2.5">Totals</td>
              <MoneyCell value={chargeSum} className="text-ink" />
              {columns.map((c) => (
                <MoneyCell
                  key={c.entity_name}
                  value={getEntity(cardholder.totals.per_entity, c.entity_name)}
                  className="text-ink"
                />
              ))}
              <MoneyCell value={cardholder.totals.total} className="text-ink" />
              <DifferenceCell value={cardholder.totals.difference} footer />
              <td className="px-3 py-2.5" />
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CcLedgerPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<CcLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [cycleStart, setCycleStart] = useState("");
  const [cycleEnd, setCycleEnd] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.ledger({
        cycle_start: cycleStart || undefined,
        cycle_end: cycleEnd || undefined,
      });
      setData(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        toast.error(
          "The credit-card ledger isn’t ready yet — finish the database migration and try again.",
        );
      } else {
        toast.error(err instanceof ApiError ? err.message : "Failed to load ledger");
      }
    } finally {
      setLoading(false);
    }
  }, [cycleStart, cycleEnd]);

  useEffect(() => {
    load();
  }, [load]);

  function resetCycle() {
    setCycleStart("");
    setCycleEnd("");
  }

  /**
   * Builds the multi-sheet workbook that reproduces the manual file: one sheet
   * per cardholder (named `tab_name`) + a Summary sheet. Numbers stay numeric so
   * Excel `SUM` works; booleans → "x"/""; absent allocations → "".
   */
  function exportExcel() {
    if (!data || data.cardholders.length === 0) {
      toast.info("Nothing to export.");
      return;
    }
    const columns = data.entity_columns;
    const entityLabels = columns.map((c) => c.label);
    const header = [
      "Have Receipt",
      "In QB",
      "Date",
      "Vendor",
      "Charge",
      ...entityLabels,
      "Total",
      "Difference",
      "Notes",
    ];

    const used = new Set<string>();
    const sheets: SheetSpec[] = data.cardholders.map((ch) => {
      const rows: (string | number)[][] = ch.rows.map((r) => [
        r.have_receipt ? "x" : "",
        r.in_qb ? "x" : "",
        fmtDateMDY(r.date),
        r.vendor,
        r.charge,
        ...columns.map((c) => getEntity(r.entities, c.entity_name) ?? ""),
        r.total,
        r.difference,
        r.notes || "",
      ]);
      const chargeSum = roundCents(ch.rows.reduce((s, r) => s + (r.charge || 0), 0));
      const totalsRow: (string | number)[] = [
        "",
        "",
        "",
        "Totals",
        chargeSum,
        ...columns.map((c) => getEntity(ch.totals.per_entity, c.entity_name) ?? ""),
        ch.totals.total,
        ch.totals.difference,
        "",
      ];
      return buildSheet(uniqueSheetName(ch.tab_name, used), header, [
        ...rows,
        totalsRow,
      ]);
    });

    // Summary sheet: per-cardholder name/card/total/difference + grand total,
    // then a per-entity totals row for the cycle.
    const summaryHeader = ["Cardholder", "Card", "Total", "Difference"];
    const summaryRows: (string | number)[][] = [
      ...data.summary.per_cardholder.map((c) => [
        c.name,
        c.card,
        c.total,
        c.difference,
      ]),
      ["Grand Total", "", data.summary.grand_total, data.summary.grand_difference],
      [],
      ["Per-Entity Totals"],
      [...entityLabels],
      [...columns.map((c) => getEntity(data.summary.per_entity_totals, c.entity_name) ?? "")],
    ];
    sheets.push(
      buildSheet(uniqueSheetName("Summary", used), summaryHeader, summaryRows),
    );

    const blob = buildWorkbook(sheets);
    downloadBlob(blob, `CC_Ledger_${data.cycle_end || exportDateStamp()}.xlsx`);
  }

  function onRowClick(row: LedgerRow) {
    navigate(`/credit-cards/transactions/${row.transaction_id}`);
  }

  // First paint only: page spinner. Later refetches keep content on screen.
  if (loading && !data) {
    return (
      <div>
        <PageHeader title="Ledger" subtitle="Cardholder ledger" />
        <CcSubNav />
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      </div>
    );
  }

  const cardholders = data?.cardholders ?? [];
  const cycleWindow =
    data?.cycle_start && data?.cycle_end
      ? `${formatDate(data.cycle_start)} – ${formatDate(data.cycle_end)}`
      : null;

  return (
    <div>
      <PageHeader
        title="Ledger"
        subtitle="Cardholder ledger — entity splits for the selected cycle"
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={exportExcel}
            disabled={cardholders.length === 0}
          >
            <Download className="h-4 w-4" />
            Export Excel
          </Button>
        }
      />
      <CcSubNav />

      {/* Cycle date-range Filter */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-6 py-3 text-sm">
        <SlidersHorizontal className="h-4 w-4 text-ink-subtle" />
        <span className="font-medium text-ink-muted">Cycle</span>
        <Input
          type="date"
          aria-label="Cycle start"
          value={cycleStart}
          max={cycleEnd || undefined}
          onChange={(e) => setCycleStart(e.target.value)}
          className="w-40"
        />
        <span className="text-ink-subtle">to</span>
        <Input
          type="date"
          aria-label="Cycle end"
          value={cycleEnd}
          min={cycleStart || undefined}
          onChange={(e) => setCycleEnd(e.target.value)}
          className="w-40"
        />
        {(cycleStart || cycleEnd) && (
          <Button variant="ghost" size="sm" onClick={resetCycle}>
            Reset
          </Button>
        )}
        {cycleWindow && (
          <span className="ml-auto text-xs text-ink-subtle">Showing {cycleWindow}</span>
        )}
      </div>

      <div className="space-y-6 p-6">
        {cardholders.length === 0 ? (
          <EmptyState
            title="No charges in this cycle"
            description="Import a statement and code entity splits to populate the ledger."
          />
        ) : (
          cardholders.map((ch) => (
            <CardholderSection
              key={ch.cardholder_id ?? "__unmatched__"}
              cardholder={ch}
              columns={data!.entity_columns}
              onRowClick={onRowClick}
            />
          ))
        )}
      </div>
    </div>
  );
}
