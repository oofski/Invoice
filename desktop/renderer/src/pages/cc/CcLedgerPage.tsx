import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  Download,
  SlidersHorizontal,
  Check,
  ChevronRight,
  ChevronDown,
  CreditCard,
  ArrowLeft,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Input, Spinner, EmptyState } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, downloadBlob, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { buildSheet, buildWorkbook, type SheetSpec } from "@/lib/workbook";
import { exportDateStamp } from "@/cc/ccExport";
import { ccApi, type CcLedgerResponse, type CcSource } from "@/cc/ccApi";

// Rows/cardholders/columns derived from the pinned backend contract so the
// component tracks the response shape without re-declaring it.
type LedgerCardholder = CcLedgerResponse["cardholders"][number];
type LedgerRow = LedgerCardholder["rows"][number];

// ---------------------------------------------------------------------------
// Card metadata — the ledger pivots into per-card "workbooks" (v1.9.0). Opening
// the ledger picks a card (Capital One / AMEX), then a cardholder (their sheet).
// ---------------------------------------------------------------------------

const CARD_SOURCES: { key: CcSource; label: string; sub: string }[] = [
  { key: "CAPITAL_ONE", label: "Capital One", sub: "Cap One statement" },
  { key: "AMEX", label: "American Express", sub: "Amex statement" },
];

function cardLabelOf(source: CcSource): string {
  return CARD_SOURCES.find((c) => c.key === source)?.label ?? source;
}

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

/**
 * Narrow a cardholder to a single card's rows (v1.9.0 pivot). Recomputes the
 * per-entity/total/difference footer over just that card's charges so each
 * cardholder sheet reconciles per card, exactly like the manual per-card
 * workbook. Rows without a `source` (a stale backend) are treated as matching so
 * nothing silently disappears.
 */
function narrowToCard(ch: LedgerCardholder, source: CcSource): LedgerCardholder {
  const rows = ch.rows.filter((r) => !r.source || r.source === source);
  const perEntity: Record<string, number> = {};
  let total = 0;
  let chargeSum = 0;
  for (const r of rows) {
    for (const [entity, amt] of Object.entries(r.entities)) {
      perEntity[entity] = roundCents((perEntity[entity] ?? 0) + amt);
    }
    total = roundCents(total + r.total);
    chargeSum = roundCents(chargeSum + r.charge);
  }
  return {
    ...ch,
    rows,
    totals: {
      per_entity: perEntity,
      total,
      difference: roundCents(chargeSum - total),
    },
  };
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
// Cardholder section (the split matrix). Adds a GL Account column (v1.9.0).
// ---------------------------------------------------------------------------

function CardholderSection({
  cardholder,
  columns,
  onRowClick,
  collapsed = false,
  onToggle,
}: {
  cardholder: LedgerCardholder;
  columns: CcLedgerResponse["entity_columns"];
  onRowClick: (row: LedgerRow) => void;
  /** When true the matrix is folded away (header stays visible). */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const chargeSum = roundCents(
    cardholder.rows.reduce((s, r) => s + (r.charge || 0), 0),
  );
  const rowCount = cardholder.rows.length;
  // Receipt, QB, Date, Vendor, GL Acct, Charge, Total, Difference, Notes = 9 fixed.
  const emptyColSpan = 9 + columns.length;

  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? "Expand this cardholder" : "Collapse this cardholder"}
        className="flex w-full flex-wrap items-center gap-3 border-b border-line px-4 py-3 text-left hover:bg-surface-2"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-subtle" />
        ) : (
          <ChevronDown className="h-4 w-4 shrink-0 text-ink-subtle" />
        )}
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
      </button>

      {!collapsed && (
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full min-w-[1180px] text-sm">
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
              <th className="sticky top-0 z-10 bg-surface-2 px-3 py-2 font-medium">
                GL Acct
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
                  <td
                    className="px-3 py-2 whitespace-nowrap text-xs text-ink-muted"
                    title={r.gl_category ?? undefined}
                  >
                    {r.gl_account ? r.gl_account : r.gl_category ? "—" : ""}
                  </td>
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
                  colSpan={emptyColSpan}
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
              <td className="px-3 py-2.5" />
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
      )}
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

  // Pivot navigation: pick a card, then a cardholder within it.
  const [card, setCard] = useState<CcSource | null>(null);
  const [cardholderKey, setCardholderKey] = useState<string | null>(null);

  // Flat-list fallback (stale backend without row.source): keep the classic
  // per-cardholder collapse behaviour so the ledger never breaks.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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

  const cardholders = useMemo(() => data?.cardholders ?? [], [data]);

  // Does the response carry per-row card sources? (New backend → yes.) When not,
  // fall back to the classic flat list so nothing breaks during a rollout.
  const anySource = useMemo(
    () => cardholders.some((ch) => ch.rows.some((r) => !!r.source)),
    [cardholders],
  );

  // Which cards actually have charges this cycle.
  const availableCards = useMemo(
    () =>
      CARD_SOURCES.filter((cs) =>
        cardholders.some((ch) => ch.rows.some((r) => r.source === cs.key)),
      ),
    [cardholders],
  );

  // Cardholders that have ≥1 charge on the selected card, narrowed to that card.
  const cardCardholders = useMemo(() => {
    if (!card) return [];
    return cardholders
      .map((ch) => narrowToCard(ch, card))
      .filter((ch) => ch.rows.length > 0);
  }, [cardholders, card]);

  const selectedCardholder = useMemo(
    () =>
      cardholderKey
        ? cardCardholders.find(
            (ch) => (ch.cardholder_id ?? "__unmatched__") === cardholderKey,
          ) ?? null
        : null,
    [cardCardholders, cardholderKey],
  );

  // A card total for the picker/summary badges.
  function cardTotal(source: CcSource): number {
    let sum = 0;
    for (const ch of cardholders)
      for (const r of ch.rows) if (r.source === source) sum = roundCents(sum + r.charge);
    return sum;
  }

  /**
   * Builds the multi-sheet workbook that reproduces the manual file: one sheet
   * per cardholder (named `tab_name`) + a Summary sheet. When `source` is given
   * the workbook is scoped to that card (its own "workbook", per the pivot).
   * Numbers stay numeric so Excel `SUM` works; booleans → "x"; absent
   * allocations → "".
   */
  function exportExcel(source?: CcSource) {
    if (!data || cardholders.length === 0) {
      toast.info("Nothing to export.");
      return;
    }
    const list = source
      ? cardholders.map((ch) => narrowToCard(ch, source)).filter((ch) => ch.rows.length > 0)
      : cardholders;
    if (list.length === 0) {
      toast.info("Nothing to export for this card.");
      return;
    }
    const columns = data.entity_columns;
    const entityLabels = columns.map((c) => c.label);
    const header = [
      "Have Receipt",
      "In QB",
      "Date",
      "Vendor",
      "GL Category",
      "GL Account",
      "Charge",
      ...entityLabels,
      "Total",
      "Difference",
      "Notes",
    ];

    const used = new Set<string>();
    const sheets: SheetSpec[] = list.map((ch) => {
      const rows: (string | number)[][] = ch.rows.map((r) => [
        r.have_receipt ? "x" : "",
        r.in_qb ? "x" : "",
        fmtDateMDY(r.date),
        r.vendor,
        r.gl_category ?? "",
        r.gl_account ?? "",
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
        "",
        "",
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
    // then a per-entity totals row for the cycle (scoped to the card too).
    const summaryHeader = ["Cardholder", "Card", "Total", "Difference"];
    const perEntityTotals: Record<string, number> = {};
    let grandTotal = 0;
    let grandDiff = 0;
    const summaryBody: (string | number)[][] = list.map((ch) => {
      for (const [e, amt] of Object.entries(ch.totals.per_entity))
        perEntityTotals[e] = roundCents((perEntityTotals[e] ?? 0) + amt);
      grandTotal = roundCents(grandTotal + ch.totals.total);
      grandDiff = roundCents(grandDiff + ch.totals.difference);
      return [ch.name, ch.card, ch.totals.total, ch.totals.difference];
    });
    const summaryRows: (string | number)[][] = [
      ...summaryBody,
      ["Grand Total", "", grandTotal, grandDiff],
      [],
      ["Per-Entity Totals"],
      [...entityLabels],
      [...columns.map((c) => getEntity(perEntityTotals, c.entity_name) ?? "")],
    ];
    sheets.push(
      buildSheet(uniqueSheetName("Summary", used), summaryHeader, summaryRows),
    );

    const blob = buildWorkbook(sheets);
    const cardTag = source ? `_${cardLabelOf(source).replace(/\s+/g, "")}` : "";
    downloadBlob(
      blob,
      `CC_Ledger${cardTag}_${data.cycle_end || exportDateStamp()}.xlsx`,
    );
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

  const cycleWindow =
    data?.cycle_start && data?.cycle_end
      ? `${formatDate(data.cycle_start)} – ${formatDate(data.cycle_end)}`
      : null;

  // Export action reflects where you are: a card view exports that card's
  // workbook; the picker/flat view exports everything.
  const exportAction = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => exportExcel(card ?? undefined)}
      disabled={cardholders.length === 0}
    >
      <Download className="h-4 w-4" />
      {card ? `Export ${cardLabelOf(card)}` : "Export Excel"}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Ledger"
        subtitle="Cardholder ledger — entity splits for the selected cycle"
        actions={exportAction}
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

      {/* Breadcrumb (pivot navigation) */}
      {anySource && (card || cardholderKey) && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-surface-2/60 px-6 py-2 text-sm">
          <button
            type="button"
            onClick={() => {
              setCard(null);
              setCardholderKey(null);
            }}
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Ledger
          </button>
          {card && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-ink-subtle" />
              <button
                type="button"
                onClick={() => setCardholderKey(null)}
                className={cn(
                  "font-medium",
                  cardholderKey ? "text-accent hover:underline" : "text-ink",
                )}
              >
                {cardLabelOf(card)}
              </button>
            </>
          )}
          {selectedCardholder && (
            <>
              <ChevronRight className="h-3.5 w-3.5 text-ink-subtle" />
              <span className="text-ink">{selectedCardholder.tab_name}</span>
            </>
          )}
        </div>
      )}

      <div className="space-y-6 p-6">
        {cardholders.length === 0 ? (
          <EmptyState
            title="No charges in this cycle"
            description="Import a statement and code entity splits to populate the ledger."
          />
        ) : !anySource ? (
          // ---- Fallback: classic flat list (no per-row source available) ----
          cardholders.map((ch) => {
            const key = ch.cardholder_id ?? "__unmatched__";
            return (
              <CardholderSection
                key={key}
                cardholder={ch}
                columns={data!.entity_columns}
                onRowClick={onRowClick}
                collapsed={collapsed.has(key)}
                onToggle={() => toggleCollapse(key)}
              />
            );
          })
        ) : !card ? (
          // ---- Level 1: pick a card ----------------------------------------
          <div className="grid gap-4 sm:grid-cols-2">
            {availableCards.map((cs) => {
              const count = cardholders.filter((ch) =>
                ch.rows.some((r) => r.source === cs.key),
              ).length;
              return (
                <button
                  key={cs.key}
                  type="button"
                  onClick={() => {
                    setCard(cs.key);
                    setCardholderKey(null);
                  }}
                  className="group flex items-center gap-4 rounded-xl border border-line bg-surface p-5 text-left transition-colors hover:border-accent hover:bg-surface-2"
                >
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-selected-bg text-accent">
                    <CreditCard className="h-6 w-6" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-base font-semibold text-ink">
                      {cs.label}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {count} cardholder{count === 1 ? "" : "s"} · {cs.sub}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-ink-subtle">
                      Charges
                    </p>
                    <p className="tabular-nums font-semibold text-ink">
                      {fmtMoney(cardTotal(cs.key))}
                    </p>
                  </div>
                  <ChevronRight className="h-5 w-5 shrink-0 text-ink-subtle group-hover:text-accent" />
                </button>
              );
            })}
          </div>
        ) : !selectedCardholder ? (
          // ---- Level 2: card summary — pick a cardholder -------------------
          <Card>
            <div className="border-b border-line px-4 py-3">
              <h2 className="font-display text-sm font-semibold text-ink">
                {cardLabelOf(card)} — cardholders
              </h2>
              <p className="text-xs text-ink-muted">
                Open a cardholder to see their split sheet for this card.
              </p>
            </div>
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.1em] text-ink-muted">
                    <th className="px-4 py-2 font-medium">Cardholder</th>
                    <th className="px-4 py-2 font-medium">Card</th>
                    <th className="px-4 py-2 text-right font-medium">Charges</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 text-right font-medium">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {cardCardholders.map((ch) => {
                    const key = ch.cardholder_id ?? "__unmatched__";
                    const chargeSum = roundCents(
                      ch.rows.reduce((s, r) => s + (r.charge || 0), 0),
                    );
                    return (
                      <tr
                        key={key}
                        onClick={() => setCardholderKey(key)}
                        className="cursor-pointer border-b border-line transition-colors hover:bg-surface-2"
                      >
                        <td
                          className={cn(
                            "px-4 py-2.5 font-medium",
                            ch.cardholder_id ? "text-ink" : "text-danger",
                          )}
                        >
                          {ch.tab_name}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-ink-muted">
                          {ch.card}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ink-muted">
                          {ch.rows.length}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-ink">
                          {fmtMoney(chargeSum)}
                        </td>
                        <DifferenceCell value={ch.totals.difference} />
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          // ---- Level 3: the cardholder's split sheet for this card ---------
          <CardholderSection
            cardholder={selectedCardholder}
            columns={data!.entity_columns}
            onRowClick={onRowClick}
          />
        )}
      </div>
    </div>
  );
}
