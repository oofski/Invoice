import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { ENTITY_COA, ENTITY_COA_ALIAS, glAccountNumber } from "@/lib/constants";
import {
  CC_ENTITIES,
  ccApi,
  roundCents,
  type EntitySplit,
} from "@/cc/ccApi";

/** Whether an entity has its own Chart of Accounts (UrbanAyurveda does not). */
function hasCoa(entity: string): boolean {
  const key = ENTITY_COA_ALIAS[entity] ?? entity;
  return !!ENTITY_COA[key];
}

/**
 * Entity-split editor (§4). Renders the 7 CC entities in template order with a
 * live Total Allocated + Remaining. The Save button is LOCKED 🔒 until
 * `Remaining === $0.00` (exact to the cent — `roundCents` compare), matching the
 * server's exact-to-cent `PUT /splits` validation. Pre-populates from existing
 * splits (carried from the Amex XLSX ingest). Save calls `ccApi.putSplits`;
 * non-Amex transactions return a 409 server-side which we surface as a toast.
 *
 * Two ways to drive a save:
 *  - `transactionId` set -> the modal PUTs splits itself and calls onSaved.
 *  - `onSubmit` provided  -> the parent owns persistence (e.g. the executive
 *    upload flow that POSTs the receipt first); the modal hands back the
 *    validated rows and never touches the network.
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
  const [savingSelf, setSavingSelf] = useState(false);
  // v1.9.0 overall GL category (COA name); "" = unset.
  const [glCat, setGlCat] = useState<string>("");

  const saving = savingProp || savingSelf;

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

  const totalAllocated = useMemo(
    () => roundCents(Object.values(parsed).reduce((a, b) => a + b, 0)),
    [parsed],
  );
  const remaining = roundCents(roundCents(amount) - totalAllocated);
  const balanced = remaining === 0;
  const hasNegative = Object.values(parsed).some((n) => n < 0);
  const canSave = balanced && !hasNegative && !saving;

  // The entity carrying the largest allocation scopes the GL category picker to
  // its Chart of Accounts (mirrors invoicing). Falls back to the full list when
  // that entity has no COA (UrbanAyurveda) or nothing is allocated yet.
  const primaryEntity = useMemo(() => {
    let best = "";
    let bestAmt = 0;
    for (const e of CC_ENTITIES) {
      const amt = parsed[e.canonical] ?? 0;
      if (amt > bestAmt) {
        bestAmt = amt;
        best = e.canonical;
      }
    }
    return best;
  }, [parsed]);
  const glEntity = primaryEntity && hasCoa(primaryEntity) ? primaryEntity : null;
  const glAccount = glEntity && glCat ? glAccountNumber(glEntity, glCat) : "";
  const showGl = showGlCategory && !!transactionId && !onSubmit;

  function setEntity(canonical: string, value: string) {
    // allow only a money-ish string
    if (value !== "" && !/^-?\d*\.?\d{0,2}$/.test(value)) return;
    setAmounts((prev) => ({ ...prev, [canonical]: value }));
  }

  /** Even-split helper: distribute the transaction amount across all 7. */
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
  }

  function clearAll() {
    const next: Record<string, string> = {};
    for (const e of CC_ENTITIES) next[e.canonical] = "";
    setAmounts(next);
  }

  async function handleSave() {
    if (!canSave) return;
    const rows = CC_ENTITIES.map((e) => ({
      entity_name: e.canonical,
      amount: roundCents(parsed[e.canonical]),
    })).filter((r) => r.amount !== 0);

    // Parent-managed path.
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
      const res = await ccApi.putSplits(transactionId, rows);
      // Persist the overall GL category alongside the split when the GL picker is
      // shown and the value changed (unchanged → skip the extra PATCH).
      if (showGl && glCat !== (glCategory ?? "")) {
        await ccApi.patchTransaction(transactionId, {
          gl_category: glCat || null,
        });
      }
      toast.success("Entity split saved");
      onSaved?.(res.splits);
      onClose();
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
            Allocate the full transaction across the entities. Save unlocks when
            the remaining balance is exactly $0.00.
          </p>
          <div className="flex gap-2">
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

        <div className="space-y-2">
          {CC_ENTITIES.map((e) => (
            <div key={e.canonical} className="flex items-center gap-3">
              <label
                htmlFor={`split-${e.canonical}`}
                className="flex-1 text-sm text-ink"
              >
                {e.label}
              </label>
              <div className="relative w-40">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-subtle">
                  $
                </span>
                <input
                  id={`split-${e.canonical}`}
                  inputMode="decimal"
                  value={amounts[e.canonical] ?? ""}
                  onChange={(ev) => setEntity(e.canonical, ev.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-lg border border-line bg-surface py-2 pl-7 pr-3 text-right text-sm tabular-nums text-ink outline-none focus:border-accent focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>
          ))}
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
            title={
              balanced ? undefined : "Remaining must be $0.00 to save"
            }
          >
            {!balanced && <Lock className="h-4 w-4" />}
            Save split
          </Button>
        </div>
      </div>
    </Modal>
  );
}
