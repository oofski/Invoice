import { useEffect, useMemo, useState } from "react";
import { Lock } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import {
  CC_ENTITIES,
  ccApi,
  roundCents,
  type EntitySplit,
} from "@/cc/ccApi";

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
