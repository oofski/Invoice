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
        </Route>

        {/* Fallback */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </HashRouter>
  );
}
