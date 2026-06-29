import { useEffect, useMemo, useState } from "react";
import { Lock, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Select } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import {
  CC_ENTITIES,
  CC_GL_BACK_BAR,
  CC_GL_RETAIL,
  ccApi,
  roundCents,
  type LineAllocation,
  type ReceiptLine,
} from "@/cc/ccApi";
import {
  ALL_LOCATIONS,
  allocateTax,
  buildItemAllocations,
  locWeights,
  locationsFor,
  reconcile,
} from "@/cc/ccLines";

/**
 * Line-by-line receipt coding grid (design §5.1). Replaces/augments
 * `EntitySplitModal` when the transaction has OCR lines. Each ITEM row is coded
 * by Entity -> Location(s) -> Back bar / Retail / 50-50 -> amount (auto
 * even-split, with a per-(location × category) manual override). A footer
 * Sales-Tax row allocates the OCR tax across the union of locations used
 * (by-spend or even). A live Reconcile bar shows Receipt total / Allocated /
 * Remaining; Save is LOCKED until Remaining == $0.00 exactly.
 *
 * Two drive modes (mirroring `EntitySplitModal`):
 *  - `transactionId` set -> the modal PUTs lines itself and calls `onSaved`.
 *  - `onSubmit` provided  -> the parent owns persistence (e.g. the cardholder
 *    upload flow that POSTs the receipt first); the modal hands back the
 *    validated, reconciled lines and never touches the network.
 */

type CatChoice = "BACK_BAR" | "RETAIL" | "HALF";
type CodingTab = "QUICK" | "LINES";

/** Editable grid state per ITEM line (on top of the OCR line). */
interface ItemState {
  clientId: string;
  receiptId?: string | null;
  description: string;
  amount: number;
  entity: string; // "" until the user picks
  locations: string[]; // canonical campus names (resolved, no ALL sentinel)
  cat: CatChoice;
  manual: boolean;
  /** Manual amounts keyed by `${location}|${gl_category}` (strings, edited). */
  manualAmounts: Record<string, string>;
}

const CAT_OF: Record<CatChoice, number> = {
  BACK_BAR: 1,
  RETAIL: 0,
  HALF: 0.5,
};

function newClientId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}`;
}

function manualKey(location: string, glCategory: string): string {
  return `${location}|${glCategory}`;
}

export function LineCodingModal({
  open,
  onClose,
  transactionId,
  amount,
  vendor,
  lines: initialLines,
  readOnlyMeta = false,
  onSaved,
  onSubmit,
  saving: savingProp,
}: {
  open: boolean;
  onClose: () => void;
  transactionId?: string;
  amount: number;
  vendor: string;
  /** OCR lines (ITEM rows + one optional TAX row) for the transaction. */
  lines: ReceiptLine[];
  /** Cardholder view: lock description/amount editing (manager may edit). */
  readOnlyMeta?: boolean;
  onSaved?: (res: { lines: ReceiptLine[] }) => void;
  /** Parent-managed save. Receives the reconciled lines; resolve to close. */
  onSubmit?: (lines: ReceiptLine[]) => Promise<void> | void;
  saving?: boolean;
}) {
  const [tab, setTab] = useState<CodingTab>("QUICK");
  const [items, setItems] = useState<ItemState[]>([]);
  const [taxAmount, setTaxAmount] = useState<number>(0);
  const [taxDescription, setTaxDescription] = useState<string>("Sales Tax");
  const [taxReceiptId, setTaxReceiptId] = useState<string | null | undefined>(
    undefined,
  );
  const [taxMode, setTaxMode] = useState<"spend" | "even">("spend");
  const [savingSelf, setSavingSelf] = useState(false);

  // ---- Quick-split tab state (design §5 — Feature B) --------------------
  // One entity + location(s) + Back bar/Retail/50-50 applied to the whole
  // charge, mapped on Save to ONE synthesized ITEM line + the TAX line.
  const [quickEntity, setQuickEntity] = useState<string>("");
  const [quickLocations, setQuickLocations] = useState<string[]>([]);
  const [quickCat, setQuickCat] = useState<CatChoice>("HALF");
  const [quickTaxMode, setQuickTaxMode] = useState<"spend" | "even">("spend");

  const saving = savingProp || savingSelf;

  // (Re)seed from the incoming OCR lines + any existing coding each time it opens.
  useEffect(() => {
    if (!open) return;
    const seededItems: ItemState[] = [];
    let seededTax = 0;
    let seededTaxDesc = "Sales Tax";
    let seededTaxReceipt: string | null | undefined = undefined;
    for (const line of initialLines ?? []) {
      if (line.kind === "TAX") {
        seededTax = roundCents(line.amount);
        seededTaxDesc = line.description || "Sales Tax";
        seededTaxReceipt = line.receipt_id ?? null;
        continue;
      }
      const itemAllocs = line.allocations.filter((a) => !a.is_tax);
      const entity = itemAllocs[0]?.entity_name ?? "";
      const locations = Array.from(
        new Set(itemAllocs.map((a) => a.location)),
      ).filter(Boolean);
      // Infer the category choice from the existing allocations.
      const hasBack = itemAllocs.some((a) => a.gl_category === CC_GL_BACK_BAR);
      const hasRetail = itemAllocs.some((a) => a.gl_category === CC_GL_RETAIL);
      const cat: CatChoice =
        hasBack && hasRetail ? "HALF" : hasRetail ? "RETAIL" : "BACK_BAR";
      const manualAmounts: Record<string, string> = {};
      for (const a of itemAllocs) {
        manualAmounts[manualKey(a.location, a.gl_category)] =
          a.amount.toFixed(2);
      }
      seededItems.push({
        clientId: line.client_id || line.id || newClientId(),
        receiptId: line.receipt_id ?? null,
        description: line.description ?? "",
        amount: roundCents(line.amount),
        entity,
        locations,
        cat,
        manual: false,
        manualAmounts,
      });
    }
    setItems(seededItems);
    setTaxAmount(seededTax);
    setTaxDescription(seededTaxDesc);
    setTaxReceiptId(seededTaxReceipt);
    setTaxMode("spend");

    // Quick tab is the default. Seed its single coding from the existing
    // item coding when there is exactly one consistent entity + location set
    // across all item lines; otherwise leave it blank (default "All locations"
    // is applied by the chip logic once an entity is chosen).
    const distinctEntities = Array.from(
      new Set(seededItems.map((it) => it.entity).filter(Boolean)),
    );
    if (distinctEntities.length === 1) {
      const entity = distinctEntities[0];
      const allLocs = Array.from(
        new Set(seededItems.flatMap((it) => it.locations)),
      ).filter(Boolean);
      const full = locationsFor(entity);
      // If every item already covers the entity's full location set, default to
      // "All locations" (the represented set); else use the union seen.
      setQuickEntity(entity);
      setQuickLocations(
        allLocs.length > 0 ? full.filter((l) => allLocs.includes(l)) : [],
      );
      // Infer the category from the union of GL slices.
      const cats = new Set(
        seededItems.flatMap((it) =>
          it.cat === "HALF" ? ["BACK_BAR", "RETAIL"] : [it.cat],
        ),
      );
      setQuickCat(
        cats.has("BACK_BAR") && cats.has("RETAIL")
          ? "HALF"
          : cats.has("RETAIL")
            ? "RETAIL"
            : "BACK_BAR",
      );
    } else {
      setQuickEntity("");
      setQuickLocations([]);
      setQuickCat("HALF");
    }
    setQuickTaxMode("spend");
    setTab("QUICK");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transactionId]);

  // Selecting a Quick entity defaults its locations to "All locations".
  function setQuickEntityAndDefaultLocs(entity: string) {
    setQuickEntity(entity);
    setQuickLocations(entity ? locationsFor(entity) : []);
  }

  function toggleQuickLocation(location: string) {
    const all = locationsFor(quickEntity);
    if (location === ALL_LOCATIONS) {
      const isAll = quickLocations.length === all.length;
      setQuickLocations(isAll ? [] : [...all]);
      return;
    }
    const has = quickLocations.includes(location);
    const next = has
      ? quickLocations.filter((l) => l !== location)
      : [...quickLocations, location];
    setQuickLocations(all.filter((l) => next.includes(l)));
  }

  // The synthesized Quick lines: one ITEM (vendor / tx.amount − tax) + the TAX
  // line, exactly as design §5 specifies. tax comes from the seeded TAX line.
  const quickLines = useMemo<ReceiptLine[]>(() => {
    const tax = roundCents(taxAmount);
    const itemAmount = roundCents(roundCents(amount) - tax);
    const item: ReceiptLine = {
      client_id: "cquick",
      receipt_id: null,
      kind: "ITEM",
      description: vendor,
      amount: itemAmount,
      allocations: buildItemAllocations(
        quickEntity,
        quickLocations,
        itemAmount,
        CAT_OF[quickCat],
      ),
    };
    const lines: ReceiptLine[] = [item];
    if (tax > 0) {
      lines.push({
        client_id: "cquicktax",
        receipt_id: taxReceiptId ?? null,
        kind: "TAX",
        description: taxDescription || "Sales Tax",
        amount: tax,
        allocations: allocateTax(tax, locWeights([item]), quickTaxMode),
      });
    }
    return lines;
  }, [
    amount,
    vendor,
    taxAmount,
    taxDescription,
    taxReceiptId,
    quickEntity,
    quickLocations,
    quickCat,
    quickTaxMode,
  ]);

  const quickRecon = useMemo(
    () => reconcile(amount, quickLines),
    [amount, quickLines],
  );
  const quickCoded = Boolean(quickEntity) && quickLocations.length > 0;
  const canSaveQuick = quickCoded && quickRecon.reconciled && !saving;

  // ---- per-line derived allocations -------------------------------------
  /** Resolve the allocation rows for one item line from its grid state. */
  function itemAllocations(it: ItemState): LineAllocation[] {
    if (!it.entity || it.locations.length === 0) return [];
    if (it.manual) {
      const out: LineAllocation[] = [];
      const cats =
        it.cat === "HALF"
          ? [CC_GL_BACK_BAR, CC_GL_RETAIL]
          : it.cat === "RETAIL"
            ? [CC_GL_RETAIL]
            : [CC_GL_BACK_BAR];
      for (const location of it.locations) {
        for (const gl of cats) {
          const raw = it.manualAmounts[manualKey(location, gl)] ?? "";
          const n = parseFloat(raw);
          const amt = Number.isFinite(n) ? roundCents(n) : 0;
          if (amt !== 0) {
            out.push({ entity_name: it.entity, location, gl_category: gl, amount: amt });
          }
        }
      }
      return out;
    }
    return buildItemAllocations(
      it.entity,
      it.locations,
      it.amount,
      CAT_OF[it.cat],
    );
  }

  // Build the full ReceiptLine[] (items + tax) from current state.
  const builtLines = useMemo<ReceiptLine[]>(() => {
    const itemLines: ReceiptLine[] = items.map((it) => ({
      client_id: it.clientId,
      receipt_id: it.receiptId ?? null,
      kind: "ITEM" as const,
      description: it.description,
      amount: it.amount,
      allocations: itemAllocations(it),
    }));
    const lines = [...itemLines];
    if (roundCents(taxAmount) > 0) {
      const weights = locWeights(itemLines);
      const taxAllocs = allocateTax(taxAmount, weights, taxMode);
      lines.push({
        client_id: "ctax",
        receipt_id: taxReceiptId ?? null,
        kind: "TAX",
        description: taxDescription || "Sales Tax",
        amount: roundCents(taxAmount),
        allocations: taxAllocs,
      });
    }
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, taxAmount, taxMode, taxDescription, taxReceiptId]);

  const recon = useMemo(
    () => reconcile(amount, builtLines),
    [amount, builtLines],
  );

  // Per-line reconcile errors (manual override that doesn't sum to the line).
  const lineErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const it of items) {
      if (!it.entity || it.locations.length === 0) continue;
      const allocated = roundCents(
        itemAllocations(it).reduce((a, x) => a + x.amount, 0),
      );
      if (it.manual && roundCents(allocated) !== roundCents(it.amount)) {
        errs[it.clientId] = `Allocations must sum to ${formatCurrency(it.amount)} (now ${formatCurrency(allocated)})`;
      }
    }
    return errs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const hasLineErrors = Object.keys(lineErrors).length > 0;
  const allItemsCoded = items.every(
    (it) => it.entity && it.locations.length > 0,
  );
  const canSave =
    recon.reconciled && !hasLineErrors && allItemsCoded && !saving;

  // The reconcile bar / Save lock follow the active tab.
  const activeRecon = tab === "QUICK" ? quickRecon : recon;

  // ---- mutations ---------------------------------------------------------
  function patchItem(clientId: string, patch: Partial<ItemState>) {
    setItems((prev) =>
      prev.map((it) => (it.clientId === clientId ? { ...it, ...patch } : it)),
    );
  }

  function setEntity(clientId: string, entity: string) {
    // Reset locations when entity changes (campus set differs).
    patchItem(clientId, { entity, locations: [], manual: false, manualAmounts: {} });
  }

  function toggleLocation(clientId: string, location: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.clientId !== clientId) return it;
        const all = locationsFor(it.entity);
        if (location === ALL_LOCATIONS) {
          const isAll = it.locations.length === all.length;
          return { ...it, locations: isAll ? [] : [...all], manualAmounts: {} };
        }
        const has = it.locations.includes(location);
        const next = has
          ? it.locations.filter((l) => l !== location)
          : [...it.locations, location];
        // keep campus order stable
        const ordered = all.filter((l) => next.includes(l));
        return { ...it, locations: ordered, manualAmounts: {} };
      }),
    );
  }

  function setCat(clientId: string, cat: CatChoice) {
    patchItem(clientId, { cat, manualAmounts: {} });
  }

  function toggleManual(clientId: string) {
    setItems((prev) =>
      prev.map((it) => {
        if (it.clientId !== clientId) return it;
        if (it.manual) return { ...it, manual: false };
        // Seed manual amounts from the current auto even-split.
        const seeded: Record<string, string> = {};
        for (const a of buildItemAllocations(
          it.entity,
          it.locations,
          it.amount,
          CAT_OF[it.cat],
        )) {
          seeded[manualKey(a.location, a.gl_category)] = a.amount.toFixed(2);
        }
        return { ...it, manual: true, manualAmounts: seeded };
      }),
    );
  }

  function setManualAmount(
    clientId: string,
    location: string,
    gl: string,
    value: string,
  ) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setItems((prev) =>
      prev.map((it) =>
        it.clientId === clientId
          ? {
              ...it,
              manualAmounts: {
                ...it.manualAmounts,
                [manualKey(location, gl)]: value,
              },
            }
          : it,
      ),
    );
  }

  function setItemAmount(clientId: string, value: string) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    const n = parseFloat(value);
    patchItem(clientId, {
      amount: Number.isFinite(n) ? roundCents(n) : 0,
      manualAmounts: {},
    });
  }

  function addManualLine() {
    setItems((prev) => [
      ...prev,
      {
        clientId: newClientId(),
        receiptId: null,
        description: "Manual line",
        amount: 0,
        entity: "",
        locations: [],
        cat: "BACK_BAR",
        manual: false,
        manualAmounts: {},
      },
    ]);
  }

  function removeLine(clientId: string) {
    setItems((prev) => prev.filter((it) => it.clientId !== clientId));
  }

  // ---- save --------------------------------------------------------------
  async function handleSave() {
    const isQuick = tab === "QUICK";
    if (isQuick ? !canSaveQuick : !canSave) return;
    const payload = isQuick ? quickLines : builtLines;

    if (onSubmit) {
      try {
        await onSubmit(payload);
        onClose();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Failed to save lines");
      }
      return;
    }

    if (!transactionId) {
      onClose();
      return;
    }
    setSavingSelf(true);
    try {
      const res = await ccApi.putLines(transactionId, payload);
      toast.success("Line coding saved");
      onSaved?.(res);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save lines");
    } finally {
      setSavingSelf(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Code receipt — ${vendor} ${formatCurrency(amount)}`}
      className="h-[88vh] w-[95vw] max-w-[1100px]"
      fill
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Tab strip — Quick split (default) vs Line by line. */}
        <div className="mb-3 flex shrink-0 items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-line">
            <button
              type="button"
              onClick={() => setTab("QUICK")}
              className={cn(
                "px-3 py-1.5 text-sm font-medium transition-colors",
                tab === "QUICK"
                  ? "bg-selected-bg text-accent"
                  : "bg-surface text-ink-muted hover:bg-surface-2",
              )}
            >
              Quick split
            </button>
            <button
              type="button"
              onClick={() => setTab("LINES")}
              className={cn(
                "border-l border-line px-3 py-1.5 text-sm font-medium transition-colors",
                tab === "LINES"
                  ? "bg-selected-bg text-accent"
                  : "bg-surface text-ink-muted hover:bg-surface-2",
              )}
            >
              Line by line
            </button>
          </div>
          {tab === "LINES" && (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={addManualLine}
            >
              <Plus className="h-3.5 w-3.5" />
              Add line
            </Button>
          )}
        </div>

        {tab === "QUICK" ? (
          <QuickSplitPanel
            amount={amount}
            vendor={vendor}
            taxAmount={taxAmount}
            taxDescription={taxDescription}
            entity={quickEntity}
            locations={quickLocations}
            cat={quickCat}
            taxMode={quickTaxMode}
            lines={quickLines}
            onEntity={setQuickEntityAndDefaultLocs}
            onToggleLocation={toggleQuickLocation}
            onCat={setQuickCat}
            onTaxMode={setQuickTaxMode}
          />
        ) : (
          <>
            <p className="pb-3 text-xs text-ink-muted">
              Code each line by entity, location(s) and Back bar / Retail. Save
              unlocks when the remaining balance is exactly $0.00.
            </p>

            {/* scroll region: the line rows */}
            <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {items.length === 0 && (
                <p className="px-1 py-6 text-center text-sm text-ink-muted">
                  No item lines. Add a line or use Quick split instead.
                </p>
              )}
              {items.map((it) => (
                <ItemRow
                  key={it.clientId}
                  item={it}
                  allocations={itemAllocations(it)}
                  error={lineErrors[it.clientId]}
                  readOnlyMeta={readOnlyMeta}
                  onEntity={(e) => setEntity(it.clientId, e)}
                  onToggleLocation={(l) => toggleLocation(it.clientId, l)}
                  onCat={(c) => setCat(it.clientId, c)}
                  onToggleManual={() => toggleManual(it.clientId)}
                  onManualAmount={(loc, gl, v) =>
                    setManualAmount(it.clientId, loc, gl, v)
                  }
                  onAmount={(v) => setItemAmount(it.clientId, v)}
                  onDescription={(v) =>
                    patchItem(it.clientId, { description: v })
                  }
                  onRemove={() => removeLine(it.clientId)}
                />
              ))}
            </div>

            {/* Tax footer row */}
            {roundCents(taxAmount) > 0 && (
              <div className="mt-2 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-ink">
                      {taxDescription}
                    </span>
                    <span className="tabular-nums text-ink-muted">
                      {formatCurrency(taxAmount)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-ink-muted">Allocate tax:</span>
                    <Segmented
                      options={[
                        { value: "spend", label: "By spend" },
                        { value: "even", label: "Even" },
                      ]}
                      value={taxMode}
                      onChange={(v) => setTaxMode(v as "spend" | "even")}
                    />
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-subtle">
                  Tax is split across the locations used by the lines above
                  {taxMode === "spend"
                    ? " in proportion to each location's spend."
                    : " equally."}
                </p>
              </div>
            )}
          </>
        )}

        {/* Reconcile bar (reflects the active tab) */}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-surface-2 px-4 py-3 text-sm">
          <div>
            <p className="text-xs text-ink-muted">Receipt total</p>
            <p className="font-medium tabular-nums text-ink">
              {formatCurrency(amount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Allocated</p>
            <p className="font-medium tabular-nums text-ink">
              {formatCurrency(activeRecon.allocated)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-muted">Remaining</p>
            <p
              className={cn(
                "font-semibold tabular-nums",
                activeRecon.reconciled ? "text-success" : "text-danger",
              )}
            >
              {formatCurrency(activeRecon.remaining)}
            </p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-xs text-danger">
            {tab === "QUICK"
              ? !quickCoded
                ? "Choose an entity and at least one location."
                : ""
              : hasLineErrors
                ? "One or more lines don't sum to their amount."
                : !allItemsCoded
                  ? "Every line needs an entity and at least one location."
                  : ""}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              loading={saving}
              disabled={tab === "QUICK" ? !canSaveQuick : !canSave}
              title={
                activeRecon.reconciled
                  ? undefined
                  : "Remaining must be $0.00 to save"
              }
            >
              {!activeRecon.reconciled && <Lock className="h-4 w-4" />}
              Save coding
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One item line row
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  allocations,
  error,
  readOnlyMeta,
  onEntity,
  onToggleLocation,
  onCat,
  onToggleManual,
  onManualAmount,
  onAmount,
  onDescription,
  onRemove,
}: {
  item: ItemState;
  allocations: LineAllocation[];
  error?: string;
  readOnlyMeta: boolean;
  onEntity: (e: string) => void;
  onToggleLocation: (l: string) => void;
  onCat: (c: CatChoice) => void;
  onToggleManual: () => void;
  onManualAmount: (loc: string, gl: string, v: string) => void;
  onAmount: (v: string) => void;
  onDescription: (v: string) => void;
  onRemove: () => void;
}) {
  const locs = item.entity ? locationsFor(item.entity) : [];
  const allSelected =
    locs.length > 0 && item.locations.length === locs.length;
  const allocated = roundCents(
    allocations.reduce((a, x) => a + x.amount, 0),
  );

  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      {/* Top: description + amount */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {readOnlyMeta ? (
            <p className="truncate text-sm font-medium text-ink">
              {item.description || "—"}
            </p>
          ) : (
            <input
              value={item.description}
              onChange={(e) => onDescription(e.target.value)}
              placeholder="Description"
              className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-sm font-medium text-ink outline-none hover:border-line focus:border-accent focus:ring-1 focus:ring-ring"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {readOnlyMeta ? (
            <span className="text-sm tabular-nums text-ink">
              {formatCurrency(item.amount)}
            </span>
          ) : (
            <div className="relative w-28">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
                $
              </span>
              <input
                inputMode="decimal"
                value={item.amount ? String(item.amount) : ""}
                onChange={(e) => onAmount(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-md border border-line bg-surface py-1.5 pl-6 pr-2 text-right text-sm tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring"
              />
            </div>
          )}
          <button
            type="button"
            onClick={onRemove}
            className="text-ink-subtle hover:text-danger"
            aria-label="Remove line"
            title="Remove line"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Controls: entity / locations / category */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Select
          value={item.entity}
          onChange={(e) => onEntity(e.target.value)}
          className="w-44"
        >
          <option value="">Choose entity…</option>
          {CC_ENTITIES.map((e) => (
            <option key={e.canonical} value={e.canonical}>
              {e.label}
            </option>
          ))}
        </Select>

        {item.entity && (
          <div className="flex flex-wrap items-center gap-1">
            {locs.length > 1 && (
              <Chip
                active={allSelected}
                onClick={() => onToggleLocation(ALL_LOCATIONS)}
              >
                All locations
              </Chip>
            )}
            {locs.map((l) => (
              <Chip
                key={l}
                active={item.locations.includes(l)}
                onClick={() => onToggleLocation(l)}
              >
                {l}
              </Chip>
            ))}
          </div>
        )}

        {item.entity && item.locations.length > 0 && (
          <Segmented
            options={[
              { value: "BACK_BAR", label: "Back bar" },
              { value: "RETAIL", label: "Retail" },
              { value: "HALF", label: "50 / 50" },
            ]}
            value={item.cat}
            onChange={(v) => onCat(v as CatChoice)}
          />
        )}

        {item.entity && item.locations.length > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={item.manual}
              onChange={onToggleManual}
              className="h-3.5 w-3.5 rounded border-line"
            />
            Manual override
          </label>
        )}
      </div>

      {/* Allocation breakdown */}
      {item.entity && item.locations.length > 0 && (
        <div className="mt-2 rounded-md bg-surface-2 px-2.5 py-2">
          {item.manual ? (
            <ManualGrid item={item} onManualAmount={onManualAmount} />
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
              {allocations.length === 0 ? (
                <span>No allocation yet.</span>
              ) : (
                allocations.map((a, i) => (
                  <span key={i} className="tabular-nums">
                    {a.location} · {catShort(a.gl_category)}:{" "}
                    <span className="text-ink">{formatCurrency(a.amount)}</span>
                  </span>
                ))
              )}
            </div>
          )}
          <div className="mt-1 flex items-center justify-between border-t border-line pt-1 text-xs">
            <span className="text-ink-muted">Line allocated</span>
            <span
              className={cn(
                "font-medium tabular-nums",
                roundCents(allocated) === roundCents(item.amount)
                  ? "text-success"
                  : "text-ink-muted",
              )}
            >
              {formatCurrency(allocated)} / {formatCurrency(item.amount)}
            </span>
          </div>
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

function ManualGrid({
  item,
  onManualAmount,
}: {
  item: ItemState;
  onManualAmount: (loc: string, gl: string, v: string) => void;
}) {
  const cats =
    item.cat === "HALF"
      ? [CC_GL_BACK_BAR, CC_GL_RETAIL]
      : item.cat === "RETAIL"
        ? [CC_GL_RETAIL]
        : [CC_GL_BACK_BAR];
  return (
    <div className="space-y-1.5">
      {item.locations.map((loc) => (
        <div key={loc} className="flex flex-wrap items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-ink-muted">{loc}</span>
          {cats.map((gl) => (
            <div key={gl} className="flex items-center gap-1">
              <span className="text-xs text-ink-subtle">{catShort(gl)}</span>
              <div className="relative w-24">
                <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-ink-subtle">
                  $
                </span>
                <input
                  inputMode="decimal"
                  value={item.manualAmounts[manualKey(loc, gl)] ?? ""}
                  onChange={(e) => onManualAmount(loc, gl, e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-line bg-surface py-1 pl-5 pr-1.5 text-right text-xs tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick-split panel (design §5 — Feature B). One entity + location chips +
// Back bar/Retail/50-50 over the whole charge, plus a tax-mode toggle when the
// receipt carries sales tax. The synthesized ITEM/TAX lines + reconcile + Save
// lock live on the parent; this panel is presentation + the live allocation
// preview.
// ---------------------------------------------------------------------------

function QuickSplitPanel({
  amount,
  vendor,
  taxAmount,
  taxDescription,
  entity,
  locations,
  cat,
  taxMode,
  lines,
  onEntity,
  onToggleLocation,
  onCat,
  onTaxMode,
}: {
  amount: number;
  vendor: string;
  taxAmount: number;
  taxDescription: string;
  entity: string;
  locations: string[];
  cat: CatChoice;
  taxMode: "spend" | "even";
  lines: ReceiptLine[];
  onEntity: (e: string) => void;
  onToggleLocation: (l: string) => void;
  onCat: (c: CatChoice) => void;
  onTaxMode: (m: "spend" | "even") => void;
}) {
  const tax = roundCents(taxAmount);
  const itemAmount = roundCents(roundCents(amount) - tax);
  const locs = entity ? locationsFor(entity) : [];
  const allSelected = locs.length > 0 && locations.length === locs.length;
  const itemAllocs = lines
    .filter((l) => l.kind === "ITEM")
    .flatMap((l) => l.allocations);
  const taxAllocs = lines
    .filter((l) => l.kind === "TAX")
    .flatMap((l) => l.allocations);

  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
      <p className="text-xs text-ink-muted">
        Code the whole charge in one step: pick an entity, the location(s), and
        Back bar / Retail. Save unlocks when the remaining balance is exactly
        $0.00.
      </p>

      {/* Entity */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
          Entity
        </label>
        <Select
          value={entity}
          onChange={(e) => onEntity(e.target.value)}
          className="w-full max-w-xs"
        >
          <option value="">Choose entity…</option>
          {CC_ENTITIES.map((e) => (
            <option key={e.canonical} value={e.canonical}>
              {e.label}
            </option>
          ))}
        </Select>
      </div>

      {/* Locations */}
      {entity && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
            Locations
          </label>
          <div className="flex flex-wrap items-center gap-1.5">
            {locs.length > 1 && (
              <Chip
                active={allSelected}
                onClick={() => onToggleLocation(ALL_LOCATIONS)}
              >
                All locations
              </Chip>
            )}
            {locs.map((l) => (
              <Chip
                key={l}
                active={locations.includes(l)}
                onClick={() => onToggleLocation(l)}
              >
                {l}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {/* Category */}
      {entity && locations.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
            Category
          </label>
          <Segmented
            options={[
              { value: "BACK_BAR", label: "Back bar" },
              { value: "RETAIL", label: "Retail" },
              { value: "HALF", label: "50 / 50" },
            ]}
            value={cat}
            onChange={(v) => onCat(v as CatChoice)}
          />
        </div>
      )}

      {/* Tax mode (only when the receipt has sales tax) */}
      {tax > 0 && entity && locations.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
            {taxDescription} · {formatCurrency(tax)}
          </label>
          <div className="flex items-center gap-3">
            <span className="text-xs text-ink-muted">Allocate tax:</span>
            <Segmented
              options={[
                { value: "spend", label: "By spend" },
                { value: "even", label: "Even" },
              ]}
              value={taxMode}
              onChange={(v) => onTaxMode(v as "spend" | "even")}
            />
          </div>
          <p className="text-xs text-ink-subtle">
            Tax is split across the chosen locations
            {taxMode === "spend"
              ? " in proportion to each location's spend."
              : " equally."}
          </p>
        </div>
      )}

      {/* Live allocation preview */}
      {entity && locations.length > 0 && (
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">{vendor || "Item"}</span>
            <span className="tabular-nums text-ink-muted">
              {formatCurrency(itemAmount)}
            </span>
          </div>
          {itemAllocs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
              {itemAllocs.map((a, i) => (
                <span key={`i${i}`} className="tabular-nums">
                  {a.location} · {catShort(a.gl_category)}:{" "}
                  <span className="text-ink">{formatCurrency(a.amount)}</span>
                </span>
              ))}
            </div>
          )}
          {tax > 0 && (
            <div className="mt-2 border-t border-line pt-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-ink">{taxDescription}</span>
                <span className="tabular-nums text-ink-muted">
                  {formatCurrency(tax)}
                </span>
              </div>
              {taxAllocs.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
                  {taxAllocs.map((a, i) => (
                    <span key={`t${i}`} className="tabular-nums">
                      {a.location}:{" "}
                      <span className="text-ink">
                        {formatCurrency(a.amount)}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small UI bits
// ---------------------------------------------------------------------------

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-accent bg-selected-bg text-accent"
          : "border-line bg-surface text-ink-muted hover:bg-surface-2",
      )}
    >
      {children}
    </button>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-line">
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium transition-colors",
            i > 0 && "border-l border-line",
            value === o.value
              ? "bg-selected-bg text-accent"
              : "bg-surface text-ink-muted hover:bg-surface-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function catShort(gl: string): string {
  if (gl === CC_GL_BACK_BAR) return "Back bar";
  if (gl === CC_GL_RETAIL) return "Retail";
  return gl;
}
