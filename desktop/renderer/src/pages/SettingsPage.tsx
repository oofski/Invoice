import { useNavigate } from "react-router-dom";
import {
  RefreshCw,
  DownloadCloud,
  CheckCircle2,
  KeyRound,
  LogOut,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button } from "@/components/ui/primitives";
import { useProfile, useAuth } from "@/components/ProfileProvider";
import { getApiBase } from "@/lib/api";
import { useUpdater } from "@/hooks/useUpdater";
import type { UpdateStatus } from "@/lib/desktop";

function statusLabel(s: UpdateStatus): string {
  switch (s.state) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return `Update ${s.version ?? ""} found — downloading…`.trim();
    case "downloading":
      return `Downloading update… ${s.percent ?? 0}%`;
    case "not-available":
      return "You're on the latest version.";
    case "error":
      return `Couldn't check for updates${s.message ? `: ${s.message}` : ""}.`;
    case "dev":
      return "Updates are disabled in development.";
    default:
      return "Check whether a newer version is available.";
  }
}

export default function SettingsPage() {
  const profile = useProfile();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const { supported, status, version, check, install } = useUpdater();
  const serverUrl = getApiBase() || "Not set";
  const busy = status.state === "checking" || status.state === "downloading";

  return (
    <div>
      <PageHeader title="Settings" subtitle="Your account, connection, and app updates" />
      <div className="max-w-2xl space-y-6 p-6">
        {/* Account */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Account
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Name</dt>
              <dd className="font-medium text-slate-900">{profile.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-medium text-slate-900">{profile.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Role</dt>
              <dd className="font-medium capitalize text-slate-900">{profile.role}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => navigate("/change-password")}>
              <KeyRound className="h-4 w-4" /> Change password
            </Button>
            <Button variant="secondary" size="sm" onClick={signOut}>
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </Card>

        {/* Connection */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Connection
          </h2>
          <div className="text-sm">
            <span className="text-slate-500">Server URL</span>
            <code className="mt-1 block break-all rounded-md bg-slate-50 p-2 font-mono text-xs text-slate-800">
              {serverUrl}
            </code>
            <p className="mt-2 text-xs text-slate-400">
              The InvoiceIQ backend this app talks to. To change it, sign out and
              update the Server URL on the login screen.
            </p>
          </div>
        </Card>

        {/* App & updates */}
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            App &amp; updates
          </h2>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-500">Version</span>
            <span className="font-medium text-slate-900">{version || "—"}</span>
          </div>

          <div className="mt-4 border-t border-slate-100 pt-4">
            {!supported ? (
              <p className="text-sm text-slate-500">
                Updates are delivered automatically by the desktop app. When a new
                version is published, you'll be prompted to restart and install.
              </p>
            ) : status.state === "downloaded" ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm text-emerald-700">
                  <CheckCircle2 className="h-4 w-4" />
                  Update {status.version ?? ""} is ready to install.
                </p>
                <Button size="sm" onClick={install}>
                  <DownloadCloud className="h-4 w-4" /> Restart &amp; install
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-slate-600">{statusLabel(status)}</p>
                <Button size="sm" variant="secondary" onClick={check} loading={busy}>
                  <RefreshCw className="h-4 w-4" /> Check for updates
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
