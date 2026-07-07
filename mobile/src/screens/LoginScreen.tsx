import { useState, type FormEvent } from "react";
import { useNavigate, useLocation, Navigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ApiError } from "../lib/api";
import { Button } from "../components/Button";
import { OfflineBanner } from "../components/OfflineBanner";

/**
 * Login (`/login`). Email + password → POST /api/auth/login. Same origin, so no
 * "Server URL" field. On success → /home (or the deep link the guard bounced
 * from). Friendly errors: 401 → "Invalid email or password"; network → offline.
 */
export function LoginScreen() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Already authenticated → skip the login screen.
  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? "/home";
    return <Navigate to={from} replace />;
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      const from = (location.state as { from?: string } | null)?.from ?? "/home";
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.offline) setError("You're offline — reconnect and try again.");
        else if (err.status === 401) setError("Invalid email or password.");
        else setError(err.message);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen screen-centered">
      <OfflineBanner />
      <div className="login-card">
        <div className="brand-mark" aria-hidden="true">📸</div>
        <h1 className="login-title">InvoiceIQ Receipts</h1>
        <p className="login-sub">Sign in to snap and file receipts.</p>

        <form onSubmit={onSubmit} className="form" noValidate>
          <label className="field">
            <span className="field-label">Email</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              required
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <Button type="submit" loading={submitting}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
