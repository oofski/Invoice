import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useFlow } from "../lib/flow";
import { AppHeader } from "../components/AppHeader";
import { Button } from "../components/Button";

/**
 * Submit → confirmation (`/done`). Clean success screen. The message reflects
 * the match outcome (§B.6):
 *   - MATCHED (split applied) → "Submitted — your accountant has been notified."
 *   - PENDING_MATCH (split saved to carry) → "Sent to your accountant to file —
 *     your entity split is saved and will apply automatically."
 */
export function ConfirmScreen() {
  const navigate = useNavigate();
  const { status, splitApplied, reset } = useFlow();

  // Deep link / refresh with no completed submit → home.
  useEffect(() => {
    if (!status) navigate("/home", { replace: true });
  }, [status, navigate]);

  const matched = status === "MATCHED" || splitApplied;

  function snapAnother() {
    reset();
    navigate("/capture");
  }

  function done() {
    reset();
    navigate("/home");
  }

  return (
    <div className="screen screen-centered">
      <AppHeader subtitle="Done" />
      <div className="done-card">
        <div className="done-check" aria-hidden="true">✓</div>
        <h1 className="done-title">Sent to the accountant</h1>
        <p className="done-sub">
          {matched
            ? "Submitted — your accountant has been notified."
            : "Sent to your accountant to file. Your entity split is saved and will apply automatically when it matches your charge."}
        </p>

        <div className="done-actions">
          <Button onClick={snapAnother}>Snap another</Button>
          <Button variant="secondary" onClick={done}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
