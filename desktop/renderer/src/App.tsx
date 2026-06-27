import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { ProfileProvider } from "@/components/ProfileProvider";
import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/Toast";

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
import CcUploadPage from "@/pages/cc/CcUploadPage";
import CcTransactionsPage from "@/pages/cc/CcTransactionsPage";
import CcReceiptTrackerPage from "@/pages/cc/CcReceiptTrackerPage";
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
              <AppShell />
            </ProfileProvider>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/approvals/:id" element={<ApprovalsPage />} />
          <Route path="/export" element={<ExportPage />} />
          <Route path="/vendors" element={<VendorsPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
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
