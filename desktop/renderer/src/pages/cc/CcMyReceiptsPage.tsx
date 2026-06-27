import { useCallback, useEffect, useRef, useState } from "react";
import {
  Smartphone,
  Upload,
  Bell,
  ReceiptText,
  Info,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { EntitySplitModal } from "@/components/cc/EntitySplitModal";
import {
  ccApi,
  type CcTransaction,
  type EntitySplit,
  type Notification,
} from "@/cc/ccApi";

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];

export default function CcMyReceiptsPage() {
  const [transactions, setTransactions] = useState<CcTransaction[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  // Cap One instructions modal
  const [capOneTx, setCapOneTx] = useState<CcTransaction | null>(null);

  // Amex upload flow
  const [uploadTx, setUploadTx] = useState<CcTransaction | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [existingSplits, setExistingSplits] = useState<EntitySplit[]>([]);
  const [splitOpen, setSplitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [txRes, notifRes] = await Promise.all([
        ccApi.listTransactions({ per_page: 200 }),
        ccApi.listNotifications().catch(() => ({ notifications: [] as Notification[] })),
      ]);
      setTransactions((txRes.transactions ?? []).filter((t) => !t.is_payment));
      setNotifications(notifRes.notifications ?? []);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function beginAmexUpload(t: CcTransaction) {
    setUploadTx(t);
    setPickedFile(null);
    setExistingSplits([]);
    try {
      const res = await ccApi.getSplits(t.id);
      setExistingSplits(res.splits ?? []);
    } catch {
      setExistingSplits([]);
    }
  }

  function pickFile(file: File) {
    if (!ALLOWED.includes(file.type)) {
      toast.error("Unsupported file type. Use PDF, JPG, or PNG.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error("File too large (max 20MB).");
      return;
    }
    setPickedFile(file);
  }

  /**
   * Final submit: POST the receipt, then PUT the (possibly edited) split. The
   * split modal hands us the validated rows ($0-locked) via onSubmit; we own
   * persistence here so the receipt and split land together. The manager-alert
   * email fires server-side on the receipt POST.
   */
  async function submitReceiptAndSplit(
    rows: { entity_name: string; amount: number }[],
  ) {
    if (!uploadTx || !pickedFile) {
      toast.error("Choose a file first.");
      throw new Error("no file");
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("file", pickedFile, pickedFile.name);
      form.set("upload_method", "INVOICE_IQ_APP");
      const up = await ccApi.uploadReceipt(uploadTx.id, form);

      // Persist the split if it differs from what's stored (or there was none).
      const changed =
        rows.length !== existingSplits.length ||
        rows.some((r) => {
          const m = existingSplits.find((s) => s.entity_name === r.entity_name);
          return !m || Math.abs(m.amount - r.amount) > 0.0001;
        });
      if (changed && rows.length > 0) {
        try {
          await ccApi.putSplits(uploadTx.id, rows);
        } catch (err) {
          // Receipt already uploaded; surface but don't roll back.
          toast.error(
            err instanceof ApiError
              ? `Receipt uploaded, but split failed: ${err.message}`
              : "Receipt uploaded, but split failed.",
          );
        }
      }

      // reflect the new status
      setTransactions((prev) =>
        prev.map((t) => (t.id === uploadTx.id ? up.transaction : t)),
      );
      toast.success("Receipt uploaded — your manager has been notified.");
      setUploadTx(null);
      setPickedFile(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed");
      throw err;
    } finally {
      setSubmitting(false);
    }
  }

  function actionFor(t: CcTransaction) {
    const needs =
      t.receipt_status === "PENDING" || t.receipt_status === "UPLOADED";
    if (!needs) return null;
    if (t.source === "CAPITAL_ONE") {
      return (
        <Button size="sm" variant="secondary" onClick={() => setCapOneTx(t)}>
          <Smartphone className="h-3.5 w-3.5" />
          Submit via Cap One
        </Button>
      );
    }
    return (
      <Button size="sm" onClick={() => beginAmexUpload(t)}>
        <Upload className="h-3.5 w-3.5" />
        Upload invoice
      </Button>
    );
  }

  return (
    <div>
      <PageHeader
        title="My Receipts"
        subtitle="Submit receipts for your credit-card transactions"
      />
      <CcSubNav />

      <div className="space-y-6 p-6">
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <ReceiptText className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              My transactions
            </h2>
          </div>
          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : transactions.length === 0 ? (
            <EmptyState
              title="No transactions"
              description="Your credit-card transactions will appear here."
            />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Vendor</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      Amount
                    </th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 text-right font-medium">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr
                      key={t.id}
                      className="border-b border-line hover:bg-surface-2"
                    >
                      <td className="px-4 py-3 text-ink-muted">
                        {formatDate(t.transaction_date)}
                      </td>
                      <td className="px-4 py-3 font-medium text-ink">
                        {t.vendor}
                      </td>
                      <td className="px-4 py-3 text-xs text-ink-muted">
                        {t.source === "AMEX" ? "Amex" : "Cap One"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {formatCurrency(t.amount)}
                      </td>
                      <td className="px-4 py-3">
                        <CcStatusBadge status={t.receipt_status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end">{actionFor(t)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* My notification history */}
        <Card>
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <Bell className="h-4 w-4 text-ink-subtle" />
            <h2 className="font-display text-sm font-semibold text-ink">
              My reminders
            </h2>
          </div>
          {notifications.length === 0 ? (
            <EmptyState title="No reminders" />
          ) : (
            <ul className="divide-y divide-line">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <span className="text-ink">{n.subject}</span>
                  <span className="shrink-0 text-xs text-ink-muted">
                    {formatDate(n.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Cap One instructions modal */}
      <Modal
        open={!!capOneTx}
        onClose={() => setCapOneTx(null)}
        title="Submit via the Capital One app"
      >
        <div className="space-y-4 text-sm text-ink">
          <div className="flex items-start gap-3 rounded-lg bg-info-soft-bg px-4 py-3 text-info-soft-fg">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Capital One receipts are added in the bank's mobile app — there's
              nothing to upload here.
            </p>
          </div>
          {capOneTx && (
            <p className="text-ink-muted">
              Transaction: <span className="text-ink">{capOneTx.vendor}</span> ·{" "}
              {formatCurrency(capOneTx.amount)} ·{" "}
              {formatDate(capOneTx.transaction_date)}
            </p>
          )}
          <ol className="list-decimal space-y-1.5 pl-5 text-ink-muted">
            <li>Open the Capital One mobile app and sign in.</li>
            <li>Go to your account and find this transaction.</li>
            <li>
              Tap the transaction, then tap <strong>“Add Receipt.”</strong>
            </li>
            <li>Take a photo of the receipt or attach a saved image/PDF.</li>
          </ol>
          <div className="flex justify-end">
            <Button onClick={() => setCapOneTx(null)}>Got it</Button>
          </div>
        </div>
      </Modal>

      {/* Amex upload modal */}
      <Modal
        open={!!uploadTx && !splitOpen}
        onClose={() => {
          setUploadTx(null);
          setPickedFile(null);
        }}
        title="Upload Amex invoice"
      >
        {uploadTx && (
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              {uploadTx.vendor} · {formatCurrency(uploadTx.amount)} ·{" "}
              {formatDate(uploadTx.transaction_date)}
            </p>

            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickFile(f);
                e.target.value = "";
              }}
            />

            <div
              className={cn(
                "rounded-lg border-2 border-dashed p-6 text-center",
                pickedFile ? "border-accent bg-selected-bg" : "border-line",
              )}
            >
              {pickedFile ? (
                <div className="text-sm">
                  <p className="font-medium text-ink">{pickedFile.name}</p>
                  <p className="text-xs text-ink-muted">
                    {(pickedFile.size / 1024).toFixed(0)} KB
                  </p>
                  <button
                    onClick={() => setPickedFile(null)}
                    className="mt-1 text-xs text-ink-muted hover:text-danger"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Choose PDF / image
                </Button>
              )}
              <p className="mt-2 text-xs text-ink-subtle">
                PDF, JPG, or PNG · max 20MB
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  setUploadTx(null);
                  setPickedFile(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => setSplitOpen(true)}
                disabled={!pickedFile}
                title={pickedFile ? undefined : "Choose a file first"}
              >
                Next: confirm split
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Split confirm (parent-managed submit) */}
      {uploadTx && (
        <EntitySplitModal
          open={splitOpen}
          onClose={() => setSplitOpen(false)}
          amount={uploadTx.amount}
          vendor={uploadTx.vendor}
          existingSplits={existingSplits}
          onSubmit={submitReceiptAndSplit}
          saving={submitting}
        />
      )}
    </div>
  );
}
