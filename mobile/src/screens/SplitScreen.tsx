import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFlow } from "../lib/flow";
import {
  CC_ENTITIES,
  roundCents,
  validateSplits,
  type EntitySplitInput,
} from "../lib/cc";
import { api, ApiError } from "../lib/api";
import { formatCurrency } from "../lib/money";
import { AppHeader } from "../components/AppHeader";
import { OfflineBanner } from "../components/OfflineBanner";
import { Button } from "../components/Button";

/**
 * Entity split (`/split`) — mirrors the desktop EntitySplitModal. Renders the 7
 * CC_ENTITIES in template order, each a money input, seeded with the full total
 * on the first entity. Live Total allocated + Remaining (roundCents(total) −
 * roundCents(Σ)). Submit is LOCKED until Remaining === $0.00 exactly and no
 * negatives — matching the server's exact-to-cent validateSplits. Helpers:
 * "Split evenly", "Clear", and per-row "All".
 *
 * SUBMIT CONTRACT (§C.5 / §C.6):
 *   - MATCHED (from the /review preview drop): the receipt is already attached,
 *     so PUT /api/cc/transactions/:matched_id/splits with the rows.
 *   - PENDING_MATCH: POST /api/cc/receipts/inbox with file + upload_method +
 *     pending_splits — the server stashes the split to apply automatically when
 *     the charge later matches (the pinned single-POST-with-pending_splits path).
 */
export function SplitScreen() {
  const navigate = useNavigate();
  const flow = useFlow();
  const { file, total, status, matchedTransactionId, setSplits, setSplitApplied } = flow;

  // amounts keyed by canonical entity_name; "" = empty input (treated as 0).
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No total (deep link / refresh) → back to review.
  useEffect(() => {
    if (!file) {
      navigate("/capture", { replace: true });
    } else if (!(total > 0)) {
      navigate("/review", { replace: true });
    }
  }, [file, total, navigate]);

  // Seed once: full total on the first entity (Remaining starts at $0.00; the
  // exec adjusts from there). Mirrors "most-likely entity holds the full total".
  useEffect(() => {
    const seed: Record<string, string> = {};
    for (const e of CC_ENTITIES) seed[e.canonical] = "";
    if (total > 0) seed[CC_ENTITIES[0].canonical] = roundCents(total).toFixed(2);
    setAmounts(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  const parsed = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of CC_ENTITIES) {
      const n = parseFloat(amounts[e.canonical] ?? "");
      out[e.canonical] = Number.isFinite(n) ? n : 0;
    }
    return out;
  }, [amounts]);

  const totalAllocated = useMemo(
    () => roundCents(Object.values(parsed).reduce((a, b) => a + b, 0)),
    [parsed],
  );
  const remaining = roundCents(roundCents(total) - totalAllocated);
  const hasNegative = Object.values(parsed).some((n) => n < 0);
  const balanced = remaining === 0 && !hasNegative;

  function setEntity(canonical: string, value: string) {
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setAmounts((prev) => ({ ...prev, [canonical]: value }));
  }

  /** Even split: distribute cents, remainder to the first N (desktop algorithm). */
  function splitEvenly() {
    const cents = Math.round(roundCents(total) * 100);
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
  }

  function clearAll() {
    const next: Record<string, string> = {};
    for (const e of CC_ENTITIES) next[e.canonical] = "";
    setAmounts(next);
  }

  /** Quick action: put the full total on one entity, zero the rest. */
  function allOn(canonical: string) {
    const next: Record<string, string> = {};
    for (const e of CC_ENTITIES) next[e.canonical] = "";
    next[canonical] = roundCents(total).toFixed(2);
    setAmounts(next);
  }

  function buildRows(): EntitySplitInput[] {
    return CC_ENTITIES.map((e) => ({
      entity_name: e.canonical,
      amount: roundCents(parsed[e.canonical]),
    })).filter((r) => r.amount !== 0);
  }

  async function onSubmit() {
    if (!balanced || submitting || !file) return;
    const rows = buildRows();

    // Belt-and-suspenders: exact-to-cent client validation (server re-checks).
    const v = validateSplits(total, rows);
    if (!v.ok) {
      setError(v.error ?? "Splits must sum to the total.");
      return;
    }

    setError(null);
    setSubmitting(true);
    setSplits(rows);
    try {
      if (status === "MATCHED" && matchedTransactionId) {
        // Receipt already attached at the preview drop → persist the split.
        await api.putSplits(matchedTransactionId, rows);
        setSplitApplied(true);
      } else if (flow.inboxId) {
        // PENDING_MATCH: the photo was already dropped once (at /review, to get
        // OCR). Attach the split to THAT existing row — never re-drop (a second
        // drop would create a duplicate inbox row). The server stashes it to
        // apply automatically on a later match, or applies it now (`applied`)
        // if the row has matched in the meantime.
        const res = await api.attachPendingSplits(flow.inboxId, rows);
        setSplitApplied(!!res.applied);
      } else {
        // Fallback: no preview-drop row exists (the /review drop errored / went
        // offline, but the exec typed the total manually). Do a real drop now
        // carrying pending_splits — the single-POST-with-splits path.
        const res = await api.dropReceipt(file, rows);
        const result = res.results?.[0];
        if (result?.status === "ERROR") {
          setError(result.error || "Submit failed. Please try again.");
          setSubmitting(false);
          return;
        }
        // If it now matched and the server applied the split, note it; if it
        // matched but didn't apply (defensive), fall back to PUT /splits.
        if (result?.status === "MATCHED") {
          if (result.split_applied) {
            setSplitApplied(true);
          } else if (result.matched_transaction_id) {
            await api.putSplits(result.matched_transaction_id, rows);
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
      <AppHeader subtitle="Split by entity" />

      <main className="split-main">
        <div className="split-head">
          <div>
            <span className="muted">Splitting</span>
            <div className="split-total">{formatCurrency(total)}</div>
          </div>
          <div className="split-actions">
            <button type="button" className="chip" onClick={splitEvenly}>
              Split evenly
            </button>
            <button type="button" className="chip chip-muted" onClick={clearAll}>
              Clear
            </button>
          </div>
        </div>

        <ul className="split-list">
          {CC_ENTITIES.map((e) => (
            <li key={e.canonical} className="split-row">
              <label htmlFor={`split-${e.canonical}`} className="split-label">
                {e.label}
              </label>
              <button
                type="button"
                className="chip chip-mini"
                onClick={() => allOn(e.canonical)}
                aria-label={`Put the full total on ${e.label}`}
              >
                All
              </button>
              <div className="money-input money-input-sm">
                <span className="money-prefix">$</span>
                <input
                  id={`split-${e.canonical}`}
                  inputMode="decimal"
                  value={amounts[e.canonical] ?? ""}
                  onChange={(ev) => setEntity(e.canonical, ev.target.value)}
                  placeholder="0.00"
                />
              </div>
            </li>
          ))}
        </ul>

        <div className="split-summary">
          <div className="summary-row">
            <span className="muted">Total allocated</span>
            <span className="tabular">{formatCurrency(totalAllocated)}</span>
          </div>
          <div className="summary-row summary-remaining">
            <span>Remaining</span>
            <span className={balanced ? "tabular ok" : "tabular bad"}>
              {formatCurrency(remaining)}
            </span>
          </div>
          {hasNegative && (
            <p className="form-error">Amounts cannot be negative.</p>
          )}
        </div>

        {error && (
          <p className="form-error" role="alert">{error}</p>
        )}
      </main>

      <div className="bottom-bar">
        <Button onClick={onSubmit} loading={submitting} disabled={!balanced}>
          {balanced ? "Send to accountant" : `🔒 Remaining must be $0.00`}
        </Button>
      </div>
    </div>
  );
}
