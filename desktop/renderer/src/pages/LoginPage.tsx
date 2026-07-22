import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn, UserPlus, ArrowLeft, Server, Banknote } from "lucide-react";
import { Button, Card, Input } from "@/components/ui/primitives";
import {
  api,
  ApiError,
  getApiBase,
  setApiBase,
  setToken,
} from "@/lib/api";
import { ROLES } from "@/lib/constants";
import type { AuthUser } from "@/lib/types";

type Mode = "login" | "bootstrap";

// "Remember me" stores the login on this device (renderer localStorage).
const REMEMBER_KEY = "iq_remember";
const REMEMBER_EMAIL = "iq_login_email";
const REMEMBER_PW = "iq_login_pw";
const rememberedOn = () => localStorage.getItem(REMEMBER_KEY) === "1";

/** Role -> landing route after login. */
function landingFor(role: AuthUser["role"]): string {
  switch (role) {
    case ROLES.EXECUTIVE:
      return "/approvals";
    case ROLES.STAFF:
      return "/upload";
    // Credit-Card-Accountant is scoped to the Credit Cards module only.
    case ROLES.CREDIT_CARD_ACCOUNTANT:
      return "/credit-cards";
    default:
      return "/dashboard";
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");

  // Shared
  const [serverUrl, setServerUrl] = useState(getApiBase());
  const [email, setEmail] = useState(() =>
    rememberedOn() ? localStorage.getItem(REMEMBER_EMAIL) ?? "" : "",
  );
  // v1.9.11 (L1): never prefill/persist the password. "Remember me" keeps only
  // the email; staying signed in is handled by the session token (setToken).
  // Purge any password a prior version stored in plaintext on this device.
  const [password, setPassword] = useState("");
  useEffect(() => {
    localStorage.removeItem(REMEMBER_PW);
  }, []);
  const [remember, setRemember] = useState(() => rememberedOn());
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function persistServer() {
    setApiBase(serverUrl);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    persistServer();
    if (!serverUrl.trim()) {
      setError("Enter the server URL for your EBG server.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ token: string; user: AuthUser }>(
        "/api/auth/login",
        { email, password },
      );
      setToken(res.token);
      if (remember) {
        localStorage.setItem(REMEMBER_KEY, "1");
        localStorage.setItem(REMEMBER_EMAIL, email);
      } else {
        localStorage.removeItem(REMEMBER_KEY);
        localStorage.removeItem(REMEMBER_EMAIL);
      }
      localStorage.removeItem(REMEMBER_PW); // never persist the password (L1)
      if (res.user.must_change_password) {
        navigate("/change-password", { replace: true });
      } else {
        navigate(landingFor(res.user.role), { replace: true });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    persistServer();
    if (!serverUrl.trim()) {
      setError("Enter the server URL for your EBG server.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ token: string; user: AuthUser }>(
        "/api/auth/bootstrap",
        { name, email, password },
      );
      setToken(res.token);
      navigate(landingFor(res.user.role), { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Could not create admin account",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-accent-fg">
            <Banknote className="h-6 w-6" />
          </div>
          <h1 className="font-wordmark text-xl font-bold uppercase tracking-[0.16em] text-ink">
            EBG
          </h1>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Invoices &amp; Credit Cards
          </p>
          <p className="mt-1 text-sm text-ink-muted">
            {mode === "login"
              ? "Sign in to continue"
              : "Create the first admin account"}
          </p>
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <ServerField value={serverUrl} onChange={setServerUrl} />
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-muted">
                Email address
              </label>
              <Input
                type="email"
                required
                autoFocus
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-muted">
                Password
              </label>
              <Input
                type="password"
                required
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 rounded border-line accent-accent"
              />
              Remember me on this device
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" loading={loading} className="w-full">
              <LogIn className="h-4 w-4" />
              Sign in
            </Button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("bootstrap");
              }}
              className="block w-full text-center text-xs text-ink-muted hover:text-ink"
            >
              First time? Create the admin account
            </button>
          </form>
        ) : (
          <form onSubmit={handleBootstrap} className="space-y-4">
            <ServerField value={serverUrl} onChange={setServerUrl} />
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-muted">
                Full name
              </label>
              <Input
                required
                autoFocus
                placeholder="Jane Admin"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-muted">
                Email address
              </label>
              <Input
                type="email"
                required
                placeholder="admin@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-muted">
                Password
              </label>
              <Input
                type="password"
                required
                placeholder="Choose a strong password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" loading={loading} className="w-full">
              <UserPlus className="h-4 w-4" />
              Create admin & sign in
            </Button>
            <button
              type="button"
              onClick={() => {
                setError(null);
                setMode("login");
              }}
              className="inline-flex w-full items-center justify-center gap-1 text-center text-xs text-ink-muted hover:text-ink"
            >
              <ArrowLeft className="h-3 w-3" /> Back to sign in
            </button>
          </form>
        )}
      </Card>
    </div>
  );
}

function ServerField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="mb-1 flex items-center gap-1 text-sm font-medium text-ink-muted">
        <Server className="h-3.5 w-3.5 text-ink-subtle" /> Server URL
      </label>
      <Input
        type="url"
        placeholder="https://invoiceiq.acct.workers.dev"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="mt-1 text-xs text-ink-subtle">
        Your EBG server address. Saved on this device.
      </p>
    </div>
  );
}
