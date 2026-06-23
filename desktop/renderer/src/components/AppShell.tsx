import { useState } from "react";
import { Link, useLocation, Outlet } from "react-router-dom";
import {
  LayoutDashboard,
  Upload,
  FileText,
  CheckSquare,
  Download,
  Building2,
  ScrollText,
  Users,
  Settings,
  LogOut,
  Menu,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ROLES, type Role } from "@/lib/constants";
import { useAuth, useProfile } from "@/components/ProfileProvider";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  roles: Role[];
}

const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: [ROLES.ACCOUNTANT, ROLES.ADMIN],
  },
  {
    href: "/upload",
    label: "Upload",
    icon: Upload,
    roles: [ROLES.ACCOUNTANT, ROLES.STAFF, ROLES.ADMIN],
  },
  {
    href: "/invoices",
    label: "Invoices",
    icon: FileText,
    roles: [ROLES.ACCOUNTANT, ROLES.STAFF, ROLES.ADMIN],
  },
  {
    href: "/approvals",
    label: "Approvals",
    icon: CheckSquare,
    roles: [ROLES.EXECUTIVE, ROLES.ACCOUNTANT, ROLES.ADMIN],
  },
  {
    href: "/export",
    label: "Export",
    icon: Download,
    roles: [ROLES.ACCOUNTANT, ROLES.ADMIN],
  },
  {
    href: "/vendors",
    label: "Vendors",
    icon: Building2,
    roles: [ROLES.ACCOUNTANT, ROLES.ADMIN],
  },
  {
    href: "/audit",
    label: "Audit Trail",
    icon: ScrollText,
    roles: [ROLES.ACCOUNTANT, ROLES.ADMIN],
  },
  {
    href: "/admin/users",
    label: "Users",
    icon: Users,
    roles: [ROLES.ADMIN],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    roles: [ROLES.ACCOUNTANT, ROLES.STAFF, ROLES.EXECUTIVE, ROLES.ADMIN],
  },
];

export function AppShell() {
  const profile = useProfile();
  const { signOut } = useAuth();
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const items = NAV.filter((n) => n.roles.includes(profile.role));

  const sidebar = (
    <div className="flex h-full flex-col bg-slate-900 text-slate-300">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-sm font-bold text-white">
          IQ
        </div>
        <span className="text-lg font-bold text-white">InvoiceIQ</span>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-2">
        {items.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              to={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                active
                  ? "bg-blue-600 text-white"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-slate-800 p-3">
        <div className="mb-2 px-2">
          <p className="truncate text-sm font-medium text-white">
            {profile.name}
          </p>
          <p className="truncate text-xs capitalize text-slate-400">
            {profile.role}
          </p>
        </div>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 md:block">{sidebar}</aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-slate-900/50"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-60">{sidebar}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile topbar */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu">
            {mobileOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </button>
          <span className="font-bold text-slate-900">InvoiceIQ</span>
          <span className="text-xs text-slate-500">{profile.name}</span>
        </header>

        <main className="min-w-0 flex-1 overflow-x-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
