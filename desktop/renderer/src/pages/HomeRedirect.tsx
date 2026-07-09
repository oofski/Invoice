import { Navigate } from "react-router-dom";
import { useProfile } from "@/components/ProfileProvider";
import { ROLES } from "@/lib/constants";

/** Role-aware landing redirect (Brief §03 / §08). Rendered inside the shell. */
export default function HomeRedirect() {
  const profile = useProfile();
  switch (profile.role) {
    case ROLES.EXECUTIVE:
      return <Navigate to="/approvals" replace />;
    case ROLES.STAFF:
      return <Navigate to="/upload" replace />;
    // Credit-Card-Accountant is scoped to the Credit Cards module — land there
    // (CcHome then forwards managers to the CC dashboard).
    case ROLES.CREDIT_CARD_ACCOUNTANT:
      return <Navigate to="/credit-cards" replace />;
    case ROLES.ACCOUNTANT:
    case ROLES.ADMIN:
    default:
      return <Navigate to="/dashboard" replace />;
  }
}
