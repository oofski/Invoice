import { useEffect, useMemo, useState } from "react";
import { Lock, Split as SplitIcon } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { ENTITY_COA, ENTITY_COA_ALIAS, glAccountNumber } from "@/lib/constants";
import { locationsFor, splitEven } from "@/cc/ccLines";
import {
  CC_ENTITIES,
  CC_GL_BACK_BAR,
  ccApi,
  roundCents,
  type EntitySplit,
  type ReceiptLine,
} from "@/cc/ccApi";

/** Whether an entity has its own Chart of Accounts (UrbanAyurveda does not). */
function hasCoa(entity: string): boolean {
  const key = ENTITY_COA_ALIAS[entity] ?? entity;
  return !!ENTITY_COA[key];
}

/** Sum a per-location amount map (string inputs) to cents-rounded dollars. */
function sumLocMap(m: Record<string, string> | undefined, locs: string[]): number {
  if (!m) return 0;
  let s = 0;
  for (const loc of locs) {
    const n = parseFloat(m[loc] ?? "");
    if (Number.isFinite(n)) s += n;
  }
  return roundCents(s);
}

/**
 * Entity-split editor (§4). Renders the 7 CC entities in template order with a
 * live Total Allocated + Remaining. The Save button is LOCKED 🔒 until
 * `Remaining === $0.00` (exact to the cent — `roundCents` compare), matching the
 * server's exact-to-cent `PUT /splits` validation. Pre-populates from existing
 * splits (carried from the Amex XLSX ingest).
 *
 * v1.9.1 — two-fold split: each multi-location business (Neroli, SKNBar, IBW)
 * can be expanded and its amount split evenly across its locations/classes. When
 * ANY business is location-split the save routes through the line-coding path
 * (`PUT /lines`, which stores entity × location) instead of the entity-only
 * `PUT /splits`; with no location split the entity-only path is unchanged.
 *
 * Two ways to drive a save:
 *  - `transactionId` set -> the modal PUTs itself and calls onSaved.
 *  - `onSubmit` provided  -> the parent owns persistence (e.g. the executive
 *    upload flow); the modal hands back the validated ENTITY rows and never
 *    touches the network (location split is a self-managed desktop feature).
 */
export function EntitySplitModal({
  open,
  onClose,
  transactionId,
  amount,
  vendor,
  existingSplits,
  showGlCategory = false,
  glCategory,
  onSaved,
  onSubmit,
  saving: savingProp,
}: {
  open: boolean;
  onClose: () => void;
  transactionId?: string;
  amount: number;
  vendor: string;
  existingSplits?: EntitySplit[] | { entity_name: string; amount: number }[];
  /**
   * v1.9.0: when set (self-managed path only), render an "Overall GL category"
   * picker (like invoicing) below the split. Saved via patchTransaction alongside
   * the split. Left off for the parent-managed (mobile/exec) flows.
   */
  showGlCategory?: boolean;
  /** The transaction's current overall GL category (COA name) to seed the picker. */
  glCategory?: string | null;
  /** Called after a successful self-managed save with the persisted rows. */
  onSaved?: (splits: EntitySplit[]) => void;
  /** Parent-managed save. Receives the validated rows; resolve to close. */
  onSubmit?: (
    splits: { entity_name: string; amount: number }[],
  ) => Promise<void> | void;
  /** External saving flag when the parent owns persistence. */
  saving?: boolean;
}) {
  // amounts keyed by canonical entity_name; "" means empty input (treated as 0).
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  // v1.9.1: per-entity location breakdown. A key present here means that entity
  // is location-split; its value is a location -> amount-string map.
  const [byLoc, setByLoc] = useState<Record<string, Record<string, string>>>({});
  const [savingSelf, setSavingSelf] = useState(false);
  // v1.9.0 overall GL category (COA name); "" = unset.
  const [glCat, setGlCat] = useState<string>("");

  const saving = savingProp || savingSelf;
  // Location split is a self-managed-only feature (parent flows have their own).
  const allowLocationSplit = !onSubmit;

  // (Re)seed from existing splits each time the modal opens.
  useEffect(() => {
    if (!open) return;
    const seed: Record<string, string> = {};
    for (const e of CC_ENTITIES) seed[e.canonical] = "";
    for (const s of existingSplits ?? []) {
      if (s.entity_name in seed && Number(s.amount) !== 0) {
        seed[s.entity_name] = String(s.amount);
      }
    }
    setAmounts(seed);
    setByLoc({});
    setGlCat(glCategory ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transactionId]);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of CC_ENTITIES) {
      const raw = amounts[e.canonical] ?? "";
      const n = parseFloat(raw);
      out[e.canonical] = Number.isFinite(n) ? n : 0;
    }
    return out;
  }, [amounts]);

  // Effective total per entity: the sum of its locations when split, else its
  // entity-level input. This is the source of truth for totals + reconcile.
  const effective = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of CC_ENTITIES) {
      const c = e.canonical;
      out[c] =
        c in byLoc ? sumLocMap(byLoc[c], locationsFor(c)) : parsed[c] ?? 0;
    }
    return out;
  }, [byLoc, parsed]);

  const anyLocSplit = Object.keys(byLoc).length > 0;

  const totalAllocated = useMemo(
    () => roundCents(Object.values(effective).reduce((a, b) => a + b, 0)),
    [effective],
  );
  const remaining = roundCents(roundCents(amount) - totalAllocated);
  const balanced = remaining === 0;
  const hasNegative = useMemo(() => {
    if (Object.values(effective).some((n) => n < 0)) return true;
    for (const map of Object.values(byLoc)) {
      for (const v of Object.values(map)) {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n < 0) return true;
      }
    }
    return false;
  }, [effective, byLoc]);
  const canSave = balanced && !hasNegative && !saving;

  // The entity carrying the largest allocation scopes the GL category picker to
  // its Chart of Accounts (mirrors invoicing). Falls back to the full list when
  // that entity has no COA (UrbanAyurveda) or nothing is allocated yet.
  const primaryEntity = useMemo(() => {
    let best = "";
    let bestAmt = 0;
    for (const e of CC_ENTITIES) {
      const amt = effective[e.canonical] ?? 0;
      if (amt > bestAmt) {
        bestAmt = amt;
        best = e.canonical;
      }
    }
    return best;
  }, [effective]);
  const glEntity = primaryEntity && hasCoa(primaryEntity) ? primaryEntity : null;
  const glAccount = glEntity && glCat ? glAccountNumber(glEntity, glCat) : "";
  const showGl = showGlCategory && !!transactionId && !onSubmit;

  function setEntity(canonical: string, value: string) {
    // allow only a money-ish string
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setAmounts((prev) => ({ ...prev, [canonical]: value }));
  }

  function setLocAmount(canonical: string, location: string, value: string) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setByLoc((prev) => ({
      ...prev,
      [canonical]: { ...(prev[canonical] ?? {}), [location]: value },
    }));
  }

  /** Toggle a business between one lump and an even split across its locations. */
  function toggleLocSplit(canonical: string) {
    const locs = locationsFor(canonical);
    if (canonical in byLoc) {
      // Combine back to a single lump = the current location sum.
      const eff = sumLocMap(byLoc[canonical], locs);
      setByLoc((prev) => {
        const next = { ...prev };
        delete next[canonical];
        return next;
      });
      setAmounts((a) => ({ ...a, [canonical]: eff ? eff.toFixed(2) : "" }));
    } else {
      // Split the entity's current amount evenly across its locations.
      const parts = splitEven(roundCents(parsed[canonical] ?? 0), locs.length);
      const m: Record<string, string> = {};
      locs.forEach((loc, i) => {
        m[loc] = parts[i] ? parts[i].toFixed(2) : "";
      });
      setByLoc((prev) => ({ ...prev, [canonical]: m }));
    }
  }

  /** Re-distribute a business's current total evenly across its locations. */
  function evenSplitEntity(canonical: string) {
    const locs = locationsFor(canonical);
    const total = sumLocMap(byLoc[canonical], locs);
    const parts = splitEven(roundCents(total), locs.length);
    const m: Record<string, string> = {};
    locs.forEach((loc, i) => {
      m[loc] = parts[i] ? parts[i].toFixed(2) : "";
    });
    setByLoc((prev) => ({ ...prev, [canonical]: m }));
  }

  /** Even-split the transaction amount across all 7 businesses (entity-level). */
  function splitEvenly() {
    const cents = Math.round(roundCents(amount) * 100);
    const per = Math.floor(cents / CC_ENTITIES.length);
    let remainder = cents - per * CC_ENTITIES.length;
    const next: Record<string, string> = {};
    for (const e of CC_ENTITIES) {
      let c = per;
      if (remainder > 0) {
        c += 1;
        remainder -= 1;
      }
      next[e.canonical] = (c / 100).toFixed(2);
    }
    setAmounts(next);
    setByLoc({});
  }

  function clearAll() {
    const next: Record<string, string> = {};
    for (const e of CC_ENTITIES) next[e.canonical] = "";
    setAmounts(next);
    setByLoc({});
  }

  /** Build the entity×location line-coding payload for a location-split save. */
  function buildLocationLines(): ReceiptLine[] {
    const lines: ReceiptLine[] = [];
    for (const e of CC_ENTITIES) {
      const c = e.canonical;
      const total = roundCents(effective[c] ?? 0);
      if (total <= 0) continue;
      const locs = locationsFor(c);
      const allocations: {
        entity_name: string;
        location: string;
        gl_category: string;
        amount: number;
      }[] = [];
      if (c in byLoc) {
        // User-specified per-location amounts.
        for (const loc of locs) {
          const amt = roundCents(parseFloat(byLoc[c][loc] ?? "") || 0);
          if (amt > 0)
            allocations.push({
              entity_name: c,
              location: loc,
              gl_category: CC_GL_BACK_BAR,
              amount: amt,
            });
        }
      } else if (locs.length <= 1) {
        // Single-location business: its one location IS the entity.
        allocations.push({
          entity_name: c,
          location: locs[0],
          gl_category: CC_GL_BACK_BAR,
          amount: total,
        });
      } else {
        // A multi-location business left as a lump → even-split its locations.
        const parts = splitEven(total, locs.length);
        locs.forEach((loc, i) => {
          if (parts[i] > 0)
            allocations.push({
              entity_name: c,
              location: loc,
              gl_category: CC_GL_BACK_BAR,
              amount: parts[i],
            });
        });
      }
      lines.push({ kind: "ITEM", description: e.label, amount: total, allocations });
    }
    return lines;
  }

  async function handleSave() {
    if (!canSave) return;
    const rows = CC_ENTITIES.map((e) => ({
      entity_name: e.canonical,
      amount: roundCents(effective[e.canonical] ?? 0),
    })).filter((r) => r.amount !== 0);

    // Parent-managed path (entity-only; parent flows don't use location split).
    if (onSubmit) {
      try {
        await onSubmit(rows);
        onClose();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : "Failed to save split");
      }
      return;
    }

    // Self-managed path.
    if (!transactionId) {
      onClose();
      return;
    }
    setSavingSelf(true);
    try {
      if (anyLocSplit) {
        // Two-fold split → persist via the line-coding path (entity × location).
        await ccApi.putLines(transactionId, buildLocationLines());
        if (showGl && glCat !== (glCategory ?? "")) {
          await ccApi.patchTransaction(transactionId, { gl_category: glCat || null });
        }
        toast.success("Split saved across locations");
        // Synthesize the entity rollup for the caller's local state.
        onSaved?.(
          rows.map((r, i) => ({
            id: `roll-${i}`,
            transaction_id: transactionId,
            entity_name: r.entity_name,
            amount: r.amount,
          })),
        );
        onClose();
      } else {
        const res = await ccApi.putSplits(transactionId, rows);
        if (showGl && glCat !== (glCategory ?? "")) {
          await ccApi.patchTransaction(transactionId, { gl_category: glCat || null });
        }
        toast.success("Entity split saved");
        onSaved?.(res.splits);
        onClose();
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save split");
    } finally {
      setSavingSelf(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Entity Split — ${vendor} ${formatCurrency(amount)}`}
      className="max-w-xl"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs">
          <p className="text-ink-muted">
            Allocate the full transaction across the businesses.
            {allowLocationSplit
              ? " Split a business across its locations with “Split locations.”"
              : ""}{" "}
            Save unlocks when the remaining balance is exactly $0.00.
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={splitEvenly}
              className="font-medium text-accent hover:underline"
            >
              Split evenly
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="font-medium text-ink-muted hover:underline"
            >
              Clear
            </button>
          </div>
        </div>

        <div className="scroll-thin max-h-[46vh] space-y-2 overflow-y-auto pr-1">
          {CC_ENTITIES.map((e) => {
            const c = e.canonical;
            const locs = locationsFor(c);
            const multi = locs.length > 1;
            const split = c in byLoc;
            const eff = effective[c] ?? 0;
            return (
              <div
                key={c}
                className={cn(
                  "rounded-lg border px-3 py-2",
                  split ? "border-accent/40 bg-selected-bg/40" : "border-line",
                )}
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <label htmlFor={`split-${c}`} className="text-sm text-ink">
                      {e.label}
                    </label>
                    {multi && (
                      <span className="ml-1 text-xs text-ink-subtle">
                        · {locs.length} locations
                      </span>
                    )}
                  </div>
                  {allowLocationSplit && multi && (
                    <button
                      type="button"
                      onClick={() => toggleLocSplit(c)}
                      className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                    >
                      <SplitIcon className="h-3 w-3" />
                      {split ? "Combine" : "Split locations"}
                    </button>
                  )}
                  <div className="relative w-40">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
                      $
                    </span>
                    <input
                      id={`split-${c}`}
                      inputMode="decimal"
                      value={split ? (eff ? eff.toFixed(2) : "") : amounts[c] ?? ""}
                      readOnly={split}
                      onChange={(ev) => setEntity(c, ev.target.value)}
                      placeholder="0.00"
                      className={cn(
                        "w-full rounded-lg border border-line py-2 pl-7 pr-3 text-right text-sm tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring",
                        split ? "bg-surface-2 text-ink-muted" : "bg-surface",
                      )}
                    />
                  </div>
                </div>

                {split && (
                  <div className="mt-2 space-y-1.5 rounded-md bg-surface-2 px-3 py-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-muted">
                        Split across {e.label}'s locations
                      </span>
                      <button
                        type="button"
                        onClick={() => evenSplitEntity(c)}
                        className="font-medium text-accent hover:underline"
                      >
                        Split evenly
                      </button>
                    </div>
                    {locs.map((loc) => (
                      <div key={loc} className="flex items-center gap-2">
                        <span className="w-28 shrink-0 truncate text-xs text-ink-muted">
                          {loc}
                        </span>
                        <div className="relative flex-1">
                          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-ink-subtle">
                            $
                          </span>
                          <input
                            inputMode="decimal"
                            value={byLoc[c]?.[loc] ?? ""}
                            onChange={(ev) => setLocAmount(c, loc, ev.target.value)}
                            placeholder="0.00"
                            className="w-full rounded-md border border-line bg-surface py-1.5 pl-6 pr-2 text-right text-xs tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-1 rounded-lg bg-surface-2 px-4 py-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Transaction amount</span>
            <span className="font-medium tabular-nums text-ink">
              {formatCurrency(amount)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink-muted">Total allocated</span>
            <span className="font-medium tabular-nums text-ink">
              {formatCurrency(totalAllocated)}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-line pt-1">
            <span className="font-medium text-ink">Remaining</span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                balanced ? "text-success" : "text-danger",
              )}
            >
              {formatCurrency(remaining)}
            </span>
          </div>
          {hasNegative && (
            <p className="text-xs text-danger">
              Negative amounts are not allowed.
            </p>
          )}
          {anyLocSplit && (
            <p className="text-xs text-ink-subtle">
              Saved by location (line coding) so each business reconciles across
              its locations.
            </p>
          )}
        </div>

        {/* Overall GL category (mirrors invoicing) — optional; scoped to the
            primary entity's Chart of Accounts and resolved to a real account. */}
        {showGl && (
          <div className="space-y-1.5 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium uppercase tracking-wide text-ink-muted">
                Overall GL category
              </label>
              {glAccount && (
                <span className="text-xs tabular-nums text-ink-muted">
                  Account {glAccount}
                </span>
              )}
            </div>
            <GLCategorySelect
              value={glCat || null}
              onChange={setGlCat}
              entity={glEntity}
              includeReview={false}
              className="w-full"
            />
            <p className="text-xs text-ink-subtle">
              Optional — sets the GL account for this charge
              {glEntity ? ` from ${glEntity}'s chart of accounts` : ""}, like
              invoicing.
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            loading={saving}
            disabled={!canSave}
            title={balanced ? undefined : "Remaining must be $0.00 to save"}
          >
            {!balanced && <Lock className="h-4 w-4" />}
            Save split
          </Button>
        </div>
      </div>
    </Modal>
  );
}
