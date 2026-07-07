import { useAuth } from "../lib/auth";

/** Small sticky header: exec name + sign out. */
export function AppHeader({ subtitle }: { subtitle?: string }) {
  const { user, logout } = useAuth();
  return (
    <header className="app-header">
      <div className="app-header-titles">
        <span className="app-header-brand">InvoiceIQ Receipts</span>
        <span className="app-header-sub">
          {subtitle ?? user?.name ?? ""}
        </span>
      </div>
      <button
        type="button"
        className="link-btn"
        onClick={() => void logout()}
      >
        Sign out
      </button>
    </header>
  );
}
