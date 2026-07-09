import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, Bell, ReceiptText, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import { Card, Button, Spinner, EmptyState } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { CcStatusBadge } from "@/components/cc/CcStatusBadge";
import { LineCodingModal } from "@/components/cc/LineCodingModal";
import { CcDropReceipts } from "@/components/cc/CcDropReceipts";
import { CcReturnedReceipts } from "@/components/cc/CcReturnedReceipts";
import {
  ccApi,
  roundCents,
  type CcTransaction,
  type Notification,
  type ReceiptLine,
} from "@/cc/ccApi";

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];

export default function CcMyReceiptsPage() {
  const [transactions, setTransactions] = useState<CcTransaction[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  // In-app receipt upload + coding flow (Amex AND Capital One)
  const [uploadTx, setUploadTx] = useState<CcTransaction | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Coding flow: once the receipt is POSTed we open the Quick-default
  // LineCodingModal. When OCR returned itemized lines we seed them (the manager
  // can flip to Line-by-line); otherwise we open with no item lines and Quick
  // split codes the whole charge.
  const [linesOpen, setLinesOpen] = useState(false);
  const [ocrLines, setOcrLines] = useState<ReceiptLine[]>([]);
  const [preparing, setPreparing] = useState(false);
  // After the receipt is uploaded, ask whether to split it now (clarity) instead
  // of auto-opening the coding modal.
  const [splitPromptOpen, setSplitPromptOpen] = useState(false);
  // Force-refresh the "Returned receipts" section after a fresh drop.
  const [returnedKey, setReturnedKey] = useState(0);
  const [returnedCount, setReturnedCount] = useState(0);
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

  function beginUpload(t: CcTransaction) {
    setUploadTx(t);
    setPickedFile(null);
    setOcrLines([]);
    setLinesOpen(false);
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
   * Upload the picked receipt, reflect the new tx status, and return the OCR.
   * Shared by the coding flow; the receipt is POSTed once here before the
   * coding modal opens.
   */
  async function uploadPickedReceipt(t: CcTransaction, file: File) {
    const form = new FormData();
    form.set("file", file, file.name);
    form.set("upload_method", "INVOICE_IQ_APP");
    const up = await ccApi.uploadReceipt(t.id, form);
    setTransactions((prev) =>
      prev.map((x) => (x.id === t.id ? up.transaction : x)),
    );
    return up;
  }

  /**
   * "Next" handler: POST the receipt first, then open the Quick-default
   * `LineCodingModal`. When OCR returned itemized `line_items` we seed them so
   * the manager can flip to the Line-by-line tab; otherwise we open with no
   * item lines and Quick split codes the whole charge. The manager-alert email
   * fires server-side on the receipt POST.
   */
  async function prepareCoding() {
    if (!uploadTx || !pickedFile) {
      toast.error("Choose a file first.");
      return;
    }
    setPreparing(true);
    try {
      const up = await uploadPickedReceipt(uploadTx, pickedFile);
      const items = (up.ocr?.line_items ?? []).filter(
        (li) => li && typeof li.amount === "number",
      );
      // Authoritative source for lines is the /lines endpoint (it includes the
      // tax line + any carried-forward coding); fall back to the OCR payload.
      let lines: ReceiptLine[] = [];
      if (items.length > 0) {
        try {
          const res = await ccApi.getLines(uploadTx.id);
          lines = res.lines ?? [];
        } catch {
          lines = [];
        }
        if (lines.length === 0) {
          lines = items.map((li, i) => ({
            client_id: `c${i}`,
            line_index: i,
            kind: "ITEM" as const,
            description: li.description ?? "",
            quantity: li.quantity ?? null,
            unit_price: li.unit_price ?? null,
            amount: roundCents(Number(li.amount) || 0),
            allocations: [],
          }));
          const tax = up.ocr?.sales_tax;
          if (typeof tax === "number" && roundCents(tax) > 0) {
            lines.push({
              client_id: "ctax",
              kind: "TAX",
              description: "Sales Tax",
              amount: roundCents(tax),
              allocations: [],
            });
          }
        }
      } else {
        // No OCR item lines: still surface any sales tax to Quick split so the
        // item subtotal = tx.amount − tax.
        const tax = up.ocr?.sales_tax;
        if (typeof tax === "number" && roundCents(tax) > 0) {
          lines = [
            {
              client_id: "ctax",
              kind: "TAX",
              description: "Sales Tax",
              amount: roundCents(tax),
              allocations: [],
            },
          ];
        }
      }

      // Receipt is now uploaded + the manager alerted. Ask whether to split it
      // now (opens the Quick-default coding modal) or send it as-is.
      setOcrLines(lines);
      setSplitPromptOpen(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setPreparing(false);
    }
  }

  /**
   * Coding path. The receipt is already uploaded; here we PUT the coded,
   * reconciled lines the modal hands back ($0-locked via onSubmit). This covers
   * both the Quick (one ITEM + TAX) and Line-by-line tabs.
   */
  async function submitReceiptAndLines(lines: ReceiptLine[]) {
    if (!uploadTx) throw new Error("no transaction");
    setSubmitting(true);
    try {
      await ccApi.putLines(uploadTx.id, lines);
      toast.success("Receipt uploaded and coded — your manager has been notified.");
      finishUpload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save coding");
      throw err;
    } finally {
      setSubmitting(false);
    }
  }

  function finishUpload() {
    setUploadTx(null);
    setPickedFile(null);
    setOcrLines([]);
    setLinesOpen(false);
    setSplitPromptOpen(false);
  }

  function actionFor(t: CcTransaction) {
    const needs =
      t.receipt_status === "PENDING" || t.receipt_status === "UPLOADED";
    if (!needs) return null;
    // Both Amex and Capital One: upload the receipt + code it here in-app.
    return (
      <Button size="sm" onClick={() => beginUpload(t)}>
        <Upload className="h-3.5 w-3.5" />
        {t.receipt_status === "UPLOADED" ? "Re-upload" : "Upload receipt"}
      </Button>
    );
  }

  return (
    <div>
      <PageHeader
        title="My Receipts"
        subtitle="Submit receipts for your credit-card transactions"
        actions={
          returnedCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-3 py-1 text-sm font-medium text-danger">
              <Undo2 className="h-3.5 w-3.5" />
              {returnedCount} returned
            </span>
          ) : undefined
        }
      />
      <CcSubNav />

      <div className="space-y-6 p-6">
        {/* Drop receipts — multi-file auto-match (Feature A) */}
        <CcDropReceipts onDropped={load} />

        {/* Returned by manager — re-submit (Feature A) */}
        <CcReturnedReceipts
          refreshKey={returnedKey}
          onCount={setReturnedCount}
          onResubmit={() => {
            // Re-open the drop flow: a fresh drop creates a new inbox row.
            setReturnedKey((k) => k + 1);
            toast.info("Drop the corrected receipt above to re-submit.");
          }}
        />

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

      {/* Receipt upload modal (Amex + Capital One) */}
      <Modal
        open={!!uploadTx && !linesOpen && !splitPromptOpen}
        onClose={() => {
          setUploadTx(null);
          setPickedFile(null);
        }}
        title={`Upload receipt${uploadTx ? ` · ${uploadTx.source === "AMEX" ? "Amex" : "Capital One"}` : ""}`}
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
                "rounded-xl border-2 border-dashed p-6 text-center transition-colors",
                pickedFile
                  ? "border-accent bg-selected-bg"
                  : "border-line hover:border-accent/40",
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
                onClick={prepareCoding}
                loading={preparing}
                disabled={!pickedFile || preparing}
                title={pickedFile ? undefined : "Choose a file first"}
              >
                Upload receipt
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* After upload: explicit choice to split now or send as-is. */}
      <Modal
        open={splitPromptOpen}
        onClose={() => {
          setSplitPromptOpen(false);
          finishUpload();
        }}
        title="Receipt uploaded"
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Your receipt is saved and your accountant has been notified. Do you
            want to split it across businesses &amp; locations now?
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setSplitPromptOpen(false);
                finishUpload();
                toast.success(
                  "Receipt sent — you can split it anytime from My Receipts.",
                );
              }}
            >
              Not now
            </Button>
            <Button
              onClick={() => {
                setSplitPromptOpen(false);
                setLinesOpen(true);
              }}
            >
              Split it
            </Button>
          </div>
        </div>
      </Modal>

      {/* Receipt coding — Quick split (default) or Line-by-line. Opens for both
          the OCR-lines and the no-OCR (whole-charge) cases. */}
      {uploadTx && (
        <LineCodingModal
          open={linesOpen}
          onClose={finishUpload}
          amount={uploadTx.amount}
          vendor={uploadTx.vendor}
          lines={ocrLines}
          readOnlyMeta
          onSubmit={submitReceiptAndLines}
          saving={submitting}
        />
      )}
    </div>
  );
}
