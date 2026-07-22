import { HashRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { ProfileProvider, useProfile } from "@/components/ProfileProvider";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/Toast";
import { ROLES } from "@/lib/constants";

import LoginPage from "@/pages/LoginPage";
import ChangePasswordPage from "@/pages/ChangePasswordPage";
import HomeRedirect from "@/pages/HomeRedirect";
import DashboardPage from "@/pages/DashboardPage";
import UploadPage from "@/pages/UploadPage";
import InvoicesPage from "@/pages/InvoicesPage";
import InvoiceDetailPage from "@/pages/InvoiceDetailPage";
import ApprovalsPage from "@/pages/ApprovalsPage";
import ExportPage from "@/pages/ExportPage";
import VendorsPage from "@/pages/VendorsPage";
import AuditPage from "@/pages/AuditPage";
import AdminUsersPage from "@/pages/AdminUsersPage";
import SettingsPage from "@/pages/SettingsPage";

// Credit-Card Receipt Management (CCRMS) — role-gated by useCcEnabled()/useCcManager().
import { useCcEnabled, useCcManager } from "@/cc/useCcEnabled";
import CcDashboardPage from "@/pages/cc/CcDashboardPage";
import CcLedgerPage from "@/pages/cc/CcLedgerPage";
import CcUploadPage from "@/pages/cc/CcUploadPage";
import CcTransactionsPage from "@/pages/cc/CcTransactionsPage";
import CcReceiptTrackerPage from "@/pages/cc/CcReceiptTrackerPage";
import CcInboxPage from "@/pages/cc/CcInboxPage";
import CcNotificationsPage from "@/pages/cc/CcNotificationsPage";
import CcCardholdersPage from "@/pages/cc/CcCardholdersPage";
import CcMyReceiptsPage from "@/pages/cc/CcMyReceiptsPage";

/**
 * Client-side gate for the /credit-cards/* routes (defense-in-depth — the API
 * already 404s for disabled users). Renders the CC route children only when the
 * flag is on; otherwise redirects home so a disabled user can't open the module
 * by typing the hash route directly.
 */
function CcGate({ children }: { children: React.ReactNode }) {
  const enabled = useCcEnabled();
  if (!enabled) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Manager-only gate for the dashboard/upload/transactions/receipts/notifications/
 * cardholders screens. A cardholder (executive) is redirected to their own "My
 * Receipts" view — those manager APIs 403 server-side, so the screens are not
 * offered. Composed inside CcGate (so disabled users are already redirected home).
 */
function CcManagerGate({ children }: { children: React.ReactNode }) {
  const isManager = useCcManager();
  if (!isManager) return <Navigate to="/credit-cards/my-receipts" replace />;
  return <>{children}</>;
}

/**
 * Layout guard for the AP / invoicing routes. The Credit-Card-Accountant role is
 * scoped to the Credit Cards module only, so it is bounced to /credit-cards if it
 * tries to reach an AP page by typing the hash route directly (its sidebar already
 * hides these). Every other role passes through unchanged.
 */
function ApOnly() {
  const profile = useProfile();
  if (profile.role === ROLES.CREDIT_CARD_ACCOUNTANT) {
    return <Navigate to="/credit-cards" replace />;
  }
  return <Outlet />;
}

/**
 * v1.9.11 (L2): admin-only gate for /admin/users. The sidebar link is already
 * admin-only, but the route was reachable by hash for accountants (who can read
 * GET /api/users). Bounce every non-admin home.
 */
function AdminOnly({ children }: { children: React.ReactNode }) {
  const profile = useProfile();
  if (profile.role !== ROLES.ADMIN) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * v1.9.11 (L3): force a still-pending first-login password change. A user issued
 * a temporary password who reloads (or deep-links) is routed to /change-password
 * on every authenticated route until they change it. /change-password is a public
 * route outside this shell, so there's no redirect loop.
 */
function PasswordGate({ children }: { children: React.ReactNode }) {
  const profile = useProfile();
  if (profile.must_change_password)
    return <Navigate to="/change-password" replace />;
  return <>{children}</>;
}

/** Landing redirect for /credit-cards — managers → dashboard, cardholders → my-receipts. */
function CcHome() {
  const isManager = useCcManager();
  return (
    <Navigate
      to={isManager ? "/credit-cards/dashboard" : "/credit-cards/my-receipts"}
      replace
    />
  );
}

/**
 * HashRouter is required so client routing works when the SPA is loaded from
 * file:// inside Electron. The authenticated shell guards every nested route by
 * loading the profile via GET /api/auth/me (ProfileProvider).
 */
export default function App() {
  return (
    <HashRouter>
      <Routes>
        {/* Public */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/change-password" element={<ChangePasswordPage />} />

        {/* Authenticated shell */}
        <Route
          element={
            <ProfileProvider>
              <PasswordGate>
                <AppShell />
              </PasswordGate>
            </ProfileProvider>
          }
        >
          <Route index element={<HomeRedirect />} />
          {/* AP / invoicing — off-limits to the Credit-Card-Accountant role. */}
          <Route element={<ApOnly />}>
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/invoices" element={<InvoicesPage />} />
            <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
            <Route path="/approvals" element={<ApprovalsPage />} />
            <Route path="/approvals/:id" element={<ApprovalsPage />} />
            <Route path="/export" element={<ExportPage />} />
            <Route path="/vendors" element={<VendorsPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route
              path="/admin/users"
              element={
                <AdminOnly>
                  <AdminUsersPage />
                </AdminOnly>
              }
            />
          </Route>
          <Route path="/settings" element={<SettingsPage />} />

          {/* Credit Cards (CCRMS) — manager screens vs the cardholder "My Receipts" view */}
          <Route
            path="/credit-cards"
            element={
              <CcGate>
                <CcHome />
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/dashboard"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcDashboardPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/ledger"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcLedgerPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/upload"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcUploadPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/transactions"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcTransactionsPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/transactions/:id"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcTransactionsPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/receipts"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcReceiptTrackerPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/inbox"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcInboxPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/notifications"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcNotificationsPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/cardholders"
            element={
              <CcGate>
                <CcManagerGate>
                  <CcCardholdersPage />
                </CcManagerGate>
              </CcGate>
            }
          />
          <Route
            path="/credit-cards/my-receipts"
            element={
              <CcGate>
                <CcMyReceiptsPage />
              </CcGate>
            }
          />
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </HashRouter>
  );
}
