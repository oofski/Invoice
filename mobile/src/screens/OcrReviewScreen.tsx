import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFlow } from "../lib/flow";
import { api, ApiError } from "../lib/api";
import { formatCurrency, parseMoney } from "../lib/money";
import { AppHeader } from "../components/AppHeader";
import { OfflineBanner } from "../components/OfflineBanner";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";

/**
 * OCR result (`/review`). On mount, POST the photo (multipart) to
 * `POST /api/cc/receipts/inbox` with `upload_method=INVOICE_IQ_APP` (NO
 * pending_splits yet) to run OCR + auto-match. Show a scanning state, then the
 * merchant / total / line items. The total is EDITABLE (OCR can be off) and
 * seeds the split. A degraded OCR (empty receipt) still lets the exec type the
 * total and continue.
 *
 * NOTE (contract reconciliation): getting server OCR requires a drop, and OCR
 * must be seen before the split is allocated. So we do a preview drop here; the
 * authoritative split submit happens on `/split` (PUT /splits when MATCHED,
 * else a drop carrying pending_splits). See SplitScreen for the submit contract.
 */
export function OcrReviewScreen() {
  const navigate = useNavigate();
  const flow = useFlow();
  const { file, ocr, status, total, inboxId, applyDropResult, setTotal } = flow;
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalInput, setTotalInput] = useState<string>(
    total > 0 ? total.toFixed(2) : "",
  );
  const ran = useRef(false);

  // No file in flow (deep link / refresh) → back to capture.
  useEffect(() => {
    if (!file) navigate("/capture", { replace: true });
  }, [file, navigate]);

  async function runDrop() {
    if (!file) return;
    setError(null);
    setScanning(true);
    try {
      const res = await api.dropReceipt(file); // preview drop — no pending_splits
      const result = res.results?.[0];
      if (!result) {
        setError("We couldn't read that. Enter the total below to continue.");
        return;
      }
      if (result.status === "ERROR") {
        setError(result.error || "We couldn't process that photo. Try retaking it.");
        return;
      }
      applyDropResult(result);
      const t = result.ocr?.total;
      if (typeof t === "number" && t > 0) setTotalInput(t.toFixed(2));
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        setError("You're offline — reconnect to read the receipt.");
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong reading the receipt.");
      }
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    // v1.9.11 (M12): if this file was ALREADY dropped (Back navigation remounts
    // this screen with a fresh ran ref), reuse the existing inbox row instead of
    // re-posting — a re-drop created a duplicate receipt + a duplicate manager
    // alert, and clobbered the exec's manually corrected total.
    if (inboxId) return;
    void runDrop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onTotalChange(v: string) {
    if (v !== "" && !/^\d*\.?\d{0,2}$/.test(v)) return;
    setTotalInput(v);
  }

  function onContinue() {
    setTotal(parseMoney(totalInput));
    navigate("/split");
  }

  // "Send without splitting": the receipt was already filed by the preview drop,
  // so just confirm — the accountant will code/split it. Only offered once the
  // drop succeeded (status set).
  function onSendAsIs() {
    flow.setSkippedSplit(true);
    navigate("/done", { replace: true });
  }

  const parsedTotal = parseMoney(totalInput);
  const canContinue = parsedTotal > 0 && !scanning;
  const lineItems = ocr?.line_items ?? [];

  return (
    <div className="screen">
      <OfflineBanner />
      <AppHeader subtitle="Review receipt" />

      <main className="review-main">
        {scanning ? (
          <div className="scanning">
            <Spinner size={40} />
            <p className="scanning-text">Reading your receipt…</p>
            <p className="muted">This can take a few seconds.</p>
          </div>
        ) : (
          <>
            {status && (
              <div className={`match-banner match-${status.toLowerCase()}`}>
                {status === "MATCHED"
                  ? "We found your charge."
                  : "We'll file this to your accountant."}
              </div>
            )}

            {error && (
              <div className="notice notice-warn" role="alert">
                {error}
                <button type="button" className="link-btn" onClick={() => void runDrop()}>
                  Retry scan
                </button>
              </div>
            )}

            {ocr?.merchant_name && (
              <div className="review-merchant">
                <span className="review-merchant-name">{ocr.merchant_name}</span>
                {ocr.transaction_date && (
                  <span className="review-merchant-date">{ocr.transaction_date}</span>
                )}
              </div>
            )}

            <label className="field field-lg">
              <span className="field-label">Receipt total</span>
              <div className="money-input">
                <span className="money-prefix">$</span>
                <input
                  inputMode="decimal"
                  value={totalInput}
                  onChange={(e) => onTotalChange(e.target.value)}
                  placeholder="0.00"
                  aria-label="Receipt total"
                />
              </div>
              <span className="field-help">
                Edit if the scan is off — this is what you'll split.
              </span>
            </label>

            {lineItems.length > 0 && (
              <section className="section">
                <h2 className="section-title">Line items</h2>
                <ul className="line-list">
                  {lineItems.map((li, i) => (
                    <li key={i} className="line-item">
                      <span className="line-desc">{li.description || "Item"}</span>
                      <span className="line-amt">
                        {li.amount != null ? formatCurrency(li.amount) : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>

      <div className="bottom-bar bottom-bar-stack">
        {!scanning && (
          <p className="split-ask">Do you want to split this receipt?</p>
        )}
        <Button onClick={onContinue} disabled={!canContinue}>
          Yes — split by business & location
        </Button>
        {status && (
          <Button variant="secondary" onClick={onSendAsIs} disabled={scanning}>
            No — send as-is
          </Button>
        )}
        <Button variant="ghost" onClick={() => navigate("/capture")}>
          Retake photo
        </Button>
      </div>
    </div>
  );
}
