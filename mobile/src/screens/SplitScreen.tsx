import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFlow } from "../lib/flow";
import {
  CC_ENTITIES,
  roundCents,
  locationsFor,
  ccEntityLabel,
  buildQuickLines,
  buildLineByLine,
  validateLineCoding,
  SERVICE_COSTS,
  SALES_USE_TAX,
  type LineAllocation,
  type LineDescriptor,
  type ReceiptLine,
} from "../lib/cc";
import { api, ApiError } from "../lib/api";
import { formatCurrency } from "../lib/money";
import { AppHeader } from "../components/AppHeader";
import { OfflineBanner } from "../components/OfflineBanner";
import { Button } from "../components/Button";

/**
 * Entity + location split (`/split`). Unifies the mobile split onto the CC
 * line-coding model (entity × location × GL) so it matches the desktop and rolls
 * up to the accountant ledger for free. Two modes:
 *
 *   - QUICK (default): split the whole receipt total across the 7 CC entities.
 *     A multi-campus entity (Neroli / SKNBarRx / Institute) can be split across
 *     MULTIPLE locations at once — its location button opens a multi-select sheet;
 *     each chosen campus becomes its own amount row. Single-campus entities need
 *     no popup.
 *   - LINE BY LINE: assign each scanned line (+ a tax line) to an entity/location.
 *
 * Submit is LOCKED until it balances exact-to-cent (mirrors the server
 * `validateLineCoding`). SUBMIT CONTRACT:
 *   - MATCHED  → PUT /api/cc/transactions/:matched_id/lines
 *   - PENDING  → PATCH /api/cc/receipts/inbox/:id/pending_splits { lines } (no re-drop)
 *   - fallback → drop carrying { lines } (only when there is no preview-drop row)
 */

type Mode = "quick" | "line";

/** Quick-mode allocation row: one chosen campus + the dollar string. An entity
 *  may now hold SEVERAL of these (multi-location). */
interface QuickRow {
  location: string;
  amount: string;
}

/** Line-mode row: a scanned item (or the tax line) assigned to entity/location. */
interface LineRow {
  description: string;
  amount: string;
  entity: string;
  location: string;
  kind: "ITEM" | "TAX";
}

/**
 * Bottom-sheet for picking one OR MORE campuses for an entity (quick mode).
 * Multi-select: tap to toggle each location; "Done" closes. Every selected
 * location gets its own amount row on the split screen.
 */
function LocationSheet({
  entity,
  selected,
  onToggle,
  onClose,
}: {
  entity: string;
  selected: string[];
  onToggle: (location: string) => void;
  onClose: () => void;
}) {
  const locations = locationsFor(entity);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h2 className="sheet-title">{ccEntityLabel(entity)}</h2>
        <p className="sheet-sub">Pick one or more locations</p>
        <ul className="sheet-list">
          {locations.map((loc) => {
            const on = selected.includes(loc);
            return (
              <li key={loc}>
                <button
                  type="button"
                  className={`sheet-opt${on ? " selected" : ""}`}
                  onClick={() => onToggle(loc)}
                  role="checkbox"
                  aria-checked={on}
                >
                  <span>{loc}</span>
                  {on && <span className="sheet-opt-check">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="sheet-done" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

export function SplitScreen() {
  const navigate = useNavigate();
  const flow = useFlow();
  const { file, total, ocr, status, matchedTransactionId, setLines, setSplitApplied } = flow;

  const [mode, setMode] = useState<Mode>("quick");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick mode: an ARRAY of {location, amount} rows per entity (multi-location).
  const [quick, setQuick] = useState<Record<string, QuickRow[]>>({});
  // Which entity's location sheet is open (quick mode), or null.
  const [sheetEntity, setSheetEntity] = useState<string | null>(null);

  // Line mode: one row per scanned line (+ a tax line when the receipt printed tax).
  const [lineRows, setLineRows] = useState<LineRow[]>([]);

  const ocrItems = useMemo(() => ocr?.line_items ?? [], [ocr]);
  const hasLineItems = ocrItems.length > 0;

  // No file / no total (deep link / refresh) → back to the right screen.
  useEffect(() => {
    if (!file) navigate("/capture", { replace: true });
    else if (!(total > 0)) navigate("/review", { replace: true });
  }, [file, total, navigate]);

  // Seed quick mode once: each entity starts with its first campus, and the full
  // total lands on the first entity (Remaining starts at $0 — the common
  // single-entity receipt is one tap; the exec reallocates from there).
  useEffect(() => {
    const seed: Record<string, QuickRow[]> = {};
    for (const e of CC_ENTITIES) {
      seed[e.canonical] = [{ location: locationsFor(e.canonical)[0], amount: "" }];
    }
    if (total > 0) seed[CC_ENTITIES[0].canonical][0].amount = roundCents(total).toFixed(2);
    setQuick(seed);
  }, [total]);

  // Seed line mode from the scanned lines (+ tax) the first time it's opened.
  useEffect(() => {
    if (mode !== "line" || lineRows.length > 0) return;
    const rows: LineRow[] = ocrItems.map((li) => ({
      description: li.description || "Item",
      amount:
        typeof li.amount === "number" && li.amount ? roundCents(li.amount).toFixed(2) : "",
      entity: "",
      location: "",
      kind: "ITEM",
    }));
    if (typeof ocr?.sales_tax === "number" && roundCents(ocr.sales_tax) > 0) {
      rows.push({
        description: "Sales Tax",
        amount: roundCents(ocr.sales_tax).toFixed(2),
        entity: "",
        location: "",
        kind: "TAX",
      });
    }
    setLineRows(rows);
  }, [mode, lineRows.length, ocrItems, ocr]);

  // ---- quick-mode derived state ----
  // Flatten every entity's location rows into (entity, location, amount).
  const quickFlat = useMemo(() => {
    const rows: { entity: string; location: string; amount: number }[] = [];
    for (const e of CC_ENTITIES) {
      for (const r of quick[e.canonical] ?? []) {
        const n = parseFloat(r.amount);
        rows.push({
          entity: e.canonical,
          location: r.location,
          amount: Number.isFinite(n) ? n : 0,
        });
      }
    }
    return rows;
  }, [quick]);
  const quickAllocated = roundCents(quickFlat.reduce((a, r) => a + r.amount, 0));
  const quickRemaining = roundCents(roundCents(total) - quickAllocated);
  const quickNegative = quickFlat.some((r) => r.amount < 0);
  const quickBalanced = quickRemaining === 0 && !quickNegative && quickAllocated > 0;

  // ---- line-mode derived state ----
  const lineParsed = useMemo(
    () =>
      lineRows.map((r) => {
        const n = parseFloat(r.amount);
        return Number.isFinite(n) ? n : 0;
      }),
    [lineRows],
  );
  const lineAllocated = roundCents(lineParsed.reduce((a, b) => a + b, 0));
  const lineRemaining = roundCents(roundCents(total) - lineAllocated);
  const lineNegative = lineParsed.some((n) => n < 0);
  const allLineAssigned =
    lineRows.length > 0 &&
    lineRows.every((r, i) => r.entity && r.location && lineParsed[i] > 0);
  const lineBalanced = lineRemaining === 0 && !lineNegative && allLineAssigned;

  const balanced = mode === "quick" ? quickBalanced : lineBalanced;
  const remaining = mode === "quick" ? quickRemaining : lineRemaining;
  const allocated = mode === "quick" ? quickAllocated : lineAllocated;
  const hasNegative = mode === "quick" ? quickNegative : lineNegative;

  // ---- quick-mode actions ----
  function setQuickAmount(entity: string, idx: number, value: string) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setQuick((prev) => ({
      ...prev,
      [entity]: (prev[entity] ?? []).map((r, i) =>
        i === idx ? { ...r, amount: value } : r,
      ),
    }));
  }
  /** Toggle a location for an entity: add a row (amount "") or remove it. Rows
   *  are kept in the entity's canonical location order. */
  function toggleLocation(entity: string, location: string) {
    setQuick((prev) => {
      const rows = prev[entity] ?? [];
      const has = rows.some((r) => r.location === location);
      let next: QuickRow[];
      if (has) {
        next = rows.filter((r) => r.location !== location);
      } else {
        const order = locationsFor(entity);
        next = [...rows, { location, amount: "" }].sort(
          (a, b) => order.indexOf(a.location) - order.indexOf(b.location),
        );
      }
      return { ...prev, [entity]: next };
    });
  }
  /** Put the full total on this entity (its first row), zeroing everything else. */
  function allOn(entity: string) {
    setQuick((prev) => {
      const next: Record<string, QuickRow[]> = {};
      for (const e of CC_ENTITIES) {
        next[e.canonical] = (prev[e.canonical] ?? []).map((r) => ({ ...r, amount: "" }));
      }
      const rows = next[entity];
      if (rows.length === 0) {
        next[entity] = [{ location: locationsFor(entity)[0], amount: roundCents(total).toFixed(2) }];
      } else {
        next[entity] = rows.map((r, i) =>
          i === 0 ? { ...r, amount: roundCents(total).toFixed(2) } : r,
        );
      }
      return next;
    });
  }
  /**
   * v1.9.1 — one-tap two-fold split: take a business's amount (or the unallocated
   * remainder when it's still empty) and split it EVENLY across ALL of its
   * locations. e.g. $100 on Neroli → $20 to each of its 5 locations.
   */
  function evenLocations(entity: string) {
    const locs = locationsFor(entity);
    if (locs.length <= 1) return;
    const rows = quick[entity] ?? [];
    const entityTotal = roundCents(
      rows.reduce((a, r) => {
        const n = parseFloat(r.amount);
        return a + (Number.isFinite(n) ? n : 0);
      }, 0),
    );
    const otherAllocated = roundCents(quickAllocated - entityTotal);
    const base =
      entityTotal > 0
        ? entityTotal
        : Math.max(0, roundCents(roundCents(total) - otherAllocated));
    const cents = Math.round(base * 100);
    const per = Math.floor(cents / locs.length);
    let rem = cents - per * locs.length;
    const newRows: QuickRow[] = locs.map((loc) => {
      let c = per;
      if (rem > 0) {
        c += 1;
        rem -= 1;
      }
      return { location: loc, amount: base > 0 ? (c / 100).toFixed(2) : "" };
    });
    setQuick((prev) => ({ ...prev, [entity]: newRows }));
  }

  /** Even split across EVERY currently-shown location row. */
  function splitEvenly() {
    const flatKeys: { entity: string; idx: number }[] = [];
    for (const e of CC_ENTITIES) {
      (quick[e.canonical] ?? []).forEach((_, idx) => flatKeys.push({ entity: e.canonical, idx }));
    }
    const n = flatKeys.length;
    if (n === 0) return;
    const cents = Math.round(roundCents(total) * 100);
    const per = Math.floor(cents / n);
    let rem = cents - per * n;
    const amountByKey = new Map<string, string>();
    for (const k of flatKeys) {
      let c = per;
      if (rem > 0) {
        c += 1;
        rem -= 1;
      }
      amountByKey.set(`${k.entity}#${k.idx}`, (c / 100).toFixed(2));
    }
    setQuick((prev) => {
      const next: Record<string, QuickRow[]> = {};
      for (const e of CC_ENTITIES) {
        next[e.canonical] = (prev[e.canonical] ?? []).map((r, idx) => ({
          ...r,
          amount: amountByKey.get(`${e.canonical}#${idx}`) ?? "",
        }));
      }
      return next;
    });
  }
  function clearQuick() {
    setQuick((prev) => {
      const next: Record<string, QuickRow[]> = {};
      for (const e of CC_ENTITIES) {
        next[e.canonical] = (prev[e.canonical] ?? []).map((r) => ({ ...r, amount: "" }));
      }
      return next;
    });
  }

  // ---- line-mode actions ----
  function setLine(i: number, patch: Partial<LineRow>) {
    setLineRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function setLineEntity(i: number, entity: string) {
    const locs = entity ? locationsFor(entity) : [];
    // Auto-pick the campus when the entity has exactly one.
    const location = locs.length === 1 ? locs[0] : "";
    setLine(i, { entity, location });
  }
  function setLineAmount(i: number, value: string) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setLine(i, { amount: value });
  }

  // ---- build the line-coding payload for submit ----
  function buildLines(): ReceiptLine[] {
    if (mode === "quick") {
      const allocations: LineAllocation[] = quickFlat
        .map((r) => ({
          entity_name: r.entity,
          location: r.location,
          gl_category: SERVICE_COSTS,
          amount: roundCents(r.amount),
        }))
        .filter((a) => a.amount !== 0);
      return buildQuickLines(total, allocations);
    }
    // line-by-line
    const items = lineRows.filter((r) => r.kind === "ITEM");
    const descriptors: LineDescriptor[] = items.map((r) => ({
      description: r.description,
      amount: roundCents(parseFloat(r.amount) || 0),
    }));
    const perLine: LineAllocation[][] = items.map((r) => [
      {
        entity_name: r.entity,
        location: r.location,
        gl_category: SERVICE_COSTS,
        amount: roundCents(parseFloat(r.amount) || 0),
      },
    ]);
    const taxRow = lineRows.find((r) => r.kind === "TAX");
    const tax =
      taxRow && roundCents(parseFloat(taxRow.amount) || 0) > 0
        ? {
            amount: roundCents(parseFloat(taxRow.amount) || 0),
            allocations: [
              {
                entity_name: taxRow.entity,
                location: taxRow.location,
                gl_category: SALES_USE_TAX,
                amount: roundCents(parseFloat(taxRow.amount) || 0),
                is_tax: true,
              },
            ],
          }
        : null;
    return buildLineByLine(descriptors, perLine, tax);
  }

  async function onSubmit() {
    if (!balanced || submitting || !file) return;
    const lines = buildLines();

    // Belt-and-suspenders exact-to-cent validation (server re-checks).
    const v = validateLineCoding(total, lines);
    if (!v.ok) {
      setError(v.error ?? "The split must balance to the receipt total.");
      return;
    }

    setError(null);
    setSubmitting(true);
    setLines(lines, mode);
    try {
      if (status === "MATCHED" && matchedTransactionId) {
        // Receipt already attached at the preview drop → persist the coding.
        await api.putLines(matchedTransactionId, lines);
        setSplitApplied(true);
      } else if (flow.inboxId) {
        // PENDING: attach to the EXISTING preview-drop row (never re-drop).
        const res = await api.attachPendingLines(flow.inboxId, lines);
        setSplitApplied(!!res.applied);
      } else {
        // Fallback: no preview-drop row (OCR errored / offline at /review) →
        // a real drop carrying the lines payload.
        const res = await api.dropReceipt(file, lines);
        const result = res.results?.[0];
        if (result?.status === "ERROR") {
          setError(result.error || "Submit failed. Please try again.");
          setSubmitting(false);
          return;
        }
        if (result?.status === "MATCHED") {
          if (result.split_applied) {
            setSplitApplied(true);
          } else if (result.matched_transaction_id) {
            await api.putLines(result.matched_transaction_id, lines);
            setSplitApplied(true);
          }
          flow.applyDropResult(result);
        }
      }
      navigate("/done", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        setError("You're offline — reconnect to submit.");
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Submit failed. Please try again.");
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="screen">
      <OfflineBanner />
      <AppHeader subtitle="Split receipt" />

      <main className="split-main">
        <div className="split-head">
          <div>
            <span className="muted">Splitting</span>
            <div className="split-total">{formatCurrency(total)}</div>
          </div>
          {mode === "quick" && (
            <div className="split-actions">
              <button type="button" className="chip" onClick={splitEvenly}>
                Split evenly
              </button>
              <button type="button" className="chip chip-muted" onClick={clearQuick}>
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Mode toggle (line-by-line only when there are scanned lines). */}
        {hasLineItems && (
          <div className="seg" role="tablist" aria-label="Split mode">
            <button
              type="button"
              className={`seg-btn${mode === "quick" ? " active" : ""}`}
              onClick={() => setMode("quick")}
            >
              Quick split
            </button>
            <button
              type="button"
              className={`seg-btn${mode === "line" ? " active" : ""}`}
              onClick={() => setMode("line")}
            >
              Line by line
            </button>
          </div>
        )}

        {mode === "quick" ? (
          <ul className="split-list">
            {CC_ENTITIES.map((e) => {
              const locs = locationsFor(e.canonical);
              const multi = locs.length > 1;
              const rows = quick[e.canonical] ?? [];
              return (
                <li key={e.canonical} className="alloc">
                  <div className="alloc-top">
                    <span className="alloc-entity">{e.label}</span>
                    <div className="alloc-top-actions">
                      {multi && (
                        <button
                          type="button"
                          className="chip chip-mini"
                          onClick={() => setSheetEntity(e.canonical)}
                        >
                          📍 Locations{rows.length > 1 ? ` (${rows.length})` : ""}
                        </button>
                      )}
                      {multi && (
                        <button
                          type="button"
                          className="chip chip-mini"
                          onClick={() => evenLocations(e.canonical)}
                          aria-label={`Split ${e.label} evenly across its ${locs.length} locations`}
                        >
                          Even locations
                        </button>
                      )}
                      <button
                        type="button"
                        className="chip chip-mini"
                        onClick={() => allOn(e.canonical)}
                        aria-label={`Put the full total on ${e.label}`}
                      >
                        All
                      </button>
                    </div>
                  </div>

                  {rows.length === 0 && multi ? (
                    <button
                      type="button"
                      className="add-loc"
                      onClick={() => setSheetEntity(e.canonical)}
                    >
                      + Add a location
                    </button>
                  ) : (
                    rows.map((r, idx) => (
                      <div className="alloc-bottom" key={r.location}>
                        {multi ? (
                          <span className="loc-static">📍 {r.location}</span>
                        ) : (
                          <span className="loc-static">
                            {r.location === e.canonical ? "" : r.location}
                          </span>
                        )}
                        <div className="money-input money-input-sm">
                          <span className="money-prefix">$</span>
                          <input
                            inputMode="decimal"
                            value={r.amount}
                            onChange={(ev) => setQuickAmount(e.canonical, idx, ev.target.value)}
                            placeholder="0.00"
                            aria-label={`Amount for ${e.label}${multi ? ` ${r.location}` : ""}`}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="split-list">
            {lineRows.map((r, i) => {
              const locs = r.entity ? locationsFor(r.entity) : [];
              return (
                <li
                  key={i}
                  className={`line-card${r.kind === "TAX" ? " line-card-tax" : ""}`}
                >
                  <div className="line-card-head">
                    <span className="line-card-desc">{r.description}</span>
                    <div className="money-input money-input-sm">
                      <span className="money-prefix">$</span>
                      <input
                        inputMode="decimal"
                        value={r.amount}
                        onChange={(ev) => setLineAmount(i, ev.target.value)}
                        placeholder="0.00"
                        aria-label={`Amount for ${r.description}`}
                      />
                    </div>
                  </div>
                  <div className="line-pickers">
                    <select
                      className="entity-select"
                      value={r.entity}
                      onChange={(ev) => setLineEntity(i, ev.target.value)}
                      aria-label={`Business for ${r.description}`}
                    >
                      <option value="">Business…</option>
                      {CC_ENTITIES.map((e) => (
                        <option key={e.canonical} value={e.canonical}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className="gl-select"
                      value={r.location}
                      onChange={(ev) => setLine(i, { location: ev.target.value })}
                      disabled={!r.entity || locs.length <= 1}
                      aria-label={`Location for ${r.description}`}
                    >
                      {(!r.entity || !r.location) && (
                        <option value="">Location…</option>
                      )}
                      {locs.map((loc) => (
                        <option key={loc} value={loc}>
                          {loc}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="split-summary">
          <div className="summary-row">
            <span>Total allocated</span>
            <span className="tabular">{formatCurrency(allocated)}</span>
          </div>
          <div className="summary-row summary-remaining">
            <span>Remaining</span>
            <span className={remaining === 0 && !hasNegative ? "tabular ok" : "tabular bad"}>
              {formatCurrency(remaining)}
            </span>
          </div>
          {hasNegative && <p className="form-error">Amounts cannot be negative.</p>}
          {mode === "line" && !allLineAssigned && lineRemaining === 0 && !hasNegative && (
            <p className="field-help">Assign every line to a business and location.</p>
          )}
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </main>

      <div className="bottom-bar">
        <Button onClick={onSubmit} loading={submitting} disabled={!balanced}>
          {balanced ? "Send to accountant" : "🔒 Remaining must be $0.00"}
        </Button>
      </div>

      {sheetEntity && (
        <LocationSheet
          entity={sheetEntity}
          selected={(quick[sheetEntity] ?? []).map((r) => r.location)}
          onToggle={(loc) => toggleLocation(sheetEntity, loc)}
          onClose={() => setSheetEntity(null)}
        />
      )}
    </div>
  );
}
