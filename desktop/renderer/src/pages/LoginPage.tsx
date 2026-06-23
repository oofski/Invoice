import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { LogIn, UserPlus, ArrowLeft, Server } from "lucide-react";
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

/** Role -> landing route after login. */
function landingFor(role: AuthUser["role"]): string {
  switch (role) {
    case ROLES.EXECUTIVE:
      return "/approvals";
    case ROLES.STAFF:
      return "/upload";
    default:
      return "/dashboard";
  }
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("login");

  // Shared
  const [serverUrl, setServerUrl] = useState(getApiBase());
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      setError("Enter the server URL for your InvoiceIQ Worker.");
      return;
    }
    setLoading(true);
    try {
      const res = await api.post<{ token: string; user: AuthUser }>(
        "/api/auth/login",
        { email, password },
      );
      setToken(res.token);
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
      setError("Enter the server URL for your InvoiceIQ Worker.");
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
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Card className="w-full max-w-md p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white">
            IQ
          </div>
          <h1 className="text-xl font-bold text-slate-900">InvoiceIQ</h1>
          <p className="text-sm text-slate-500">
            {mode === "login"
              ? "AP automation — sign in to continue"
              : "Create the first admin account"}
          </p>
        </div>

        {mode === "login" ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <ServerField value={serverUrl} onChange={setServerUrl} />
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
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
              <label className="mb-1 block text-sm font-medium text-slate-700">
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
            {error && <p className="text-sm text-red-600">{error}</p>}
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
              className="block w-full text-center text-xs text-slate-500 hover:text-slate-700"
            >
              First time? Create the admin account
            </button>
          </form>
        ) : (
          <form onSubmit={handleBootstrap} className="space-y-4">
            <ServerField value={serverUrl} onChange={setServerUrl} />
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
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
              <label className="mb-1 block text-sm font-medium text-slate-700">
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
              <label className="mb-1 block text-sm font-medium text-slate-700">
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
            {error && <p className="text-sm text-red-600">{error}</p>}
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
              className="inline-flex w-full items-center justify-center gap-1 text-center text-xs text-slate-500 hover:text-slate-700"
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
      <label className="mb-1 flex items-center gap-1 text-sm font-medium text-slate-700">
        <Server className="h-3.5 w-3.5 text-slate-400" /> Server URL
      </label>
      <Input
        type="url"
        placeholder="https://invoiceiq.acct.workers.dev"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="mt-1 text-xs text-slate-400">
        Your InvoiceIQ Worker address. Saved on this device.
      </p>
    </div>
  );
}
