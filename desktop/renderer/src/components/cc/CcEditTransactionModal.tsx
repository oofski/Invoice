import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Input } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { ApiError } from "@/lib/api";
import { ccApi, type CcTransaction } from "@/cc/ccApi";

/**
 * "Edit details" modal (manager-only) for correcting mis-parsed transaction
 * fields. Fields pre-fill from the transaction; Save sends ONLY the fields that
 * changed vs the original (via `ccApi.patchTransaction`). Vendor must be
 * non-empty and amount a finite number (mirrors the backend rules) before send.
 *
 * If the transaction already has entity splits or coded lines AND the amount is
 * being changed, an inline warning is shown — coding may no longer reconcile.
 * Warning only, not a block.
 */
export function CcEditTransactionModal({
  open,
  onClose,
  transaction,
  hasSplits,
  hasLines,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  transaction: CcTransaction;
  /** True when the tx has existing entity splits. */
  hasSplits: boolean;
  /** True when the tx has existing coded receipt lines. */
  hasLines: boolean;
  /** Called after a successful save (parent refreshes detail + list). */
  onSaved: () => void | Promise<void>;
}) {
  const [vendor, setVendor] = useState("");
  const [amount, setAmount] = useState("");
  const [transactionDate, setTransactionDate] = useState("");
  const [category, setCategory] = useState("");
  const [expAcct, setExpAcct] = useState("");
  const [inQb, setInQb] = useState(false);
  const [saving, setSaving] = useState(false);

  // (Re)seed from the transaction each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setVendor(transaction.vendor ?? "");
    setAmount(String(transaction.amount ?? ""));
    setTransactionDate(transaction.transaction_date ?? "");
    setCategory(transaction.category ?? "");
    setExpAcct(transaction.exp_acct ?? "");
    setInQb(!!transaction.in_qb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transaction.id]);

  const parsedAmount = parseFloat(amount);
  const amountChanged = Number.isFinite(parsedAmount)
    ? parsedAmount !== transaction.amount
    : amount.trim() !== String(transaction.amount ?? "");
  const showAmountWarning = (hasSplits || hasLines) && amountChanged;

  const vendorValid = vendor.trim().length > 0;
  const amountValid = Number.isFinite(parsedAmount);
  const canSave = vendorValid && amountValid && !saving;

  async function handleSave() {
    if (!vendorValid) {
      toast.error("Vendor is required");
      return;
    }
    if (!amountValid) {
      toast.error("Amount must be a number");
      return;
    }

    // Build a patch of ONLY the changed fields.
    const patch: Parameters<typeof ccApi.patchTransaction>[1] = {};
    const nextVendor = vendor.trim();
    if (nextVendor !== transaction.vendor) patch.vendor = nextVendor;
    if (parsedAmount !== transaction.amount) patch.amount = parsedAmount;
    if (transactionDate !== transaction.transaction_date)
      patch.transaction_date = transactionDate;
    const nextCategory = category.trim() ? category.trim() : null;
    if (nextCategory !== (transaction.category ?? null))
      patch.category = nextCategory;
    const nextExpAcct = expAcct.trim();
    if (nextExpAcct !== (transaction.exp_acct ?? ""))
      patch.exp_acct = nextExpAcct;
    if (inQb !== !!transaction.in_qb) patch.in_qb = inQb;

    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await ccApi.patchTransaction(transaction.id, patch);
      toast.success("Transaction updated");
      await onSaved();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit details"
      className="max-w-md"
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Vendor *
          </label>
          <Input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Amount *
            </label>
            <Input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="text-right tabular-nums"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Transaction date
            </label>
            <Input
              type="date"
              value={transactionDate}
              onChange={(e) => setTransactionDate(e.target.value)}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Category
          </label>
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="optional — empty clears it"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">
            Exp Acct
          </label>
          <Input
            value={expAcct}
            onChange={(e) => setExpAcct(e.target.value)}
            placeholder="optional"
          />
        </div>

        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={inQb}
            onChange={(e) => setInQb(e.target.checked)}
            className="h-4 w-4 rounded border-line accent-accent"
          />
          In QB
        </label>

        {showAmountWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-warning-soft-bg bg-warning-soft-bg px-3 py-2 text-xs text-warning-soft-fg">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Changing the amount may make existing entity splits / line coding
              no longer reconcile — re-check coding after saving.
            </span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={!canSave}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}
