import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useFlow } from "../lib/flow";
import { api, ApiError, type CcTransaction } from "../lib/api";
import { formatCurrency } from "../lib/money";
import { AppHeader } from "../components/AppHeader";
import { OfflineBanner } from "../components/OfflineBanner";
import { Button } from "../components/Button";
import { Spinner } from "../components/Spinner";

/**
 * Home (`/home`). Hero "Snap a receipt" button. Optional secondary list of the
 * exec's charges needing a receipt (GET /api/cc/transactions?receipt_status=
 * PENDING). The list is a nice-to-have — the hero camera is the required path.
 */
export function HomeScreen() {
  const { user } = useAuth();
  const { reset } = useFlow();
  const navigate = useNavigate();
  const [txns, setTxns] = useState<CcTransaction[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { transactions } = await api.pendingTransactions();
        if (!cancelled) setTxns(transactions ?? []);
      } catch (err) {
        // Non-fatal — the list is optional. Keep the hero usable.
        if (!cancelled) {
          setTxns([]);
          if (err instanceof ApiError && !err.offline && err.status !== 403) {
            setListError("Couldn't load your open charges.");
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function startSnap() {
    reset();
    navigate("/capture");
  }

  return (
    <div className="screen">
      <OfflineBanner />
      <AppHeader />

      <main className="home-main">
        <div className="hero">
          <p className="hero-greeting">
            {user?.name ? `Hi ${user.name.split(" ")[0]},` : "Hi,"}
          </p>
          <h1 className="hero-title">Snap a receipt to file it in seconds.</h1>
          <button type="button" className="hero-btn" onClick={startSnap}>
            <span className="hero-btn-icon" aria-hidden="true">📷</span>
            <span>Snap a receipt</span>
          </button>
        </div>

        <section className="section">
          <h2 className="section-title">Charges needing a receipt</h2>
          {loading ? (
            <div className="center-row">
              <Spinner />
            </div>
          ) : listError ? (
            <p className="muted">{listError}</p>
          ) : txns && txns.length > 0 ? (
            <ul className="tx-list">
              {txns.map((t) => (
                <li key={t.id} className="tx-item">
                  <div className="tx-main">
                    <span className="tx-vendor">{t.vendor || "Unknown vendor"}</span>
                    <span className="tx-date">{t.transaction_date}</span>
                  </div>
                  <div className="tx-amount">{formatCurrency(t.amount)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No open charges — snap a receipt anytime.</p>
          )}
        </section>
      </main>

      <div className="bottom-bar">
        <Button onClick={startSnap}>Snap a receipt</Button>
      </div>
    </div>
  );
}
