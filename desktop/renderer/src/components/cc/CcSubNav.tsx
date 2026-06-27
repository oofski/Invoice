import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Upload,
  ReceiptText,
  ListChecks,
  Bell,
  Users,
  UserCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Intra-module navigation for the Credit Cards section. The AppShell exposes a
 * single "Credit Cards" item (per the build plan); this strip switches between
 * the module's screens once you're inside it. Mirrors the app's active-link
 * styling.
 */
const TABS = [
  { to: "/credit-cards/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/credit-cards/receipts", label: "Receipt Tracker", icon: ListChecks },
  { to: "/credit-cards/transactions", label: "Transactions", icon: ReceiptText },
  { to: "/credit-cards/upload", label: "Upload", icon: Upload },
  { to: "/credit-cards/notifications", label: "Notifications", icon: Bell },
  { to: "/credit-cards/cardholders", label: "Cardholders", icon: Users },
  { to: "/credit-cards/my-receipts", label: "My Receipts", icon: UserCircle },
];

export function CcSubNav() {
  return (
    <div className="scroll-thin flex gap-1 overflow-x-auto border-b border-line bg-surface px-4 py-2">
      {TABS.map((t) => {
        const Icon = t.icon;
        return (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) =>
              cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-selected-bg text-accent"
                  : "text-ink-muted hover:bg-surface-2 hover:text-ink",
              )
            }
          >
            <Icon className="h-4 w-4" />
            {t.label}
          </NavLink>
        );
      })}
    </div>
  );
}
