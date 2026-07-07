import { useEffect, type ReactNode } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "./lib/auth";
import { FlowProvider } from "./lib/flow";
import { Spinner } from "./components/Spinner";
import { LoginScreen } from "./screens/LoginScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { CaptureScreen } from "./screens/CaptureScreen";
import { OcrReviewScreen } from "./screens/OcrReviewScreen";
import { SplitScreen } from "./screens/SplitScreen";
import { ConfirmScreen } from "./screens/ConfirmScreen";

/** Full-screen splash while the app-open silent /me resolves. */
function Splash() {
  return (
    <div className="screen screen-centered">
      <div className="splash">
        <div className="brand-mark" aria-hidden="true">📸</div>
        <Spinner size={28} />
      </div>
    </div>
  );
}

/** Redirect unauthenticated deep links to /login (remembering the target). */
function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Splash />;
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

export function App() {
  const navigate = useNavigate();

  // A 401 anywhere clears the token and drops the user; bounce to /login.
  useEffect(() => {
    const onUnauthorized = () => navigate("/login", { replace: true });
    window.addEventListener("iq:unauthorized", onUnauthorized);
    return () => window.removeEventListener("iq:unauthorized", onUnauthorized);
  }, [navigate]);

  return (
    <FlowProvider>
      <Routes>
        <Route path="/login" element={<LoginScreen />} />
        <Route
          path="/home"
          element={
            <RequireAuth>
              <HomeScreen />
            </RequireAuth>
          }
        />
        <Route
          path="/capture"
          element={
            <RequireAuth>
              <CaptureScreen />
            </RequireAuth>
          }
        />
        <Route
          path="/review"
          element={
            <RequireAuth>
              <OcrReviewScreen />
            </RequireAuth>
          }
        />
        <Route
          path="/split"
          element={
            <RequireAuth>
              <SplitScreen />
            </RequireAuth>
          }
        />
        <Route
          path="/done"
          element={
            <RequireAuth>
              <ConfirmScreen />
            </RequireAuth>
          }
        />
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
    </FlowProvider>
  );
}
