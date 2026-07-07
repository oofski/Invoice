/**
 * Auth context — persistent login.
 *
 * On app open, if an `iq_token` exists in localStorage, silently `GET
 * /api/auth/me`; a valid token skips the login screen (14-day session). A 401
 * clears the token. `login()` stores the token; `logout()` clears it (and
 * best-effort tears down the server session).
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, clearToken, getToken, setToken, type AuthUser } from "./api";

interface AuthState {
  user: AuthUser | null;
  /** True while the initial silent /me is in flight (app-open splash). */
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());

  // Silent token validation on app open.
  useEffect(() => {
    let cancelled = false;
    if (!getToken()) {
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const { user: me } = await api.me();
        if (!cancelled) setUser(me);
      } catch {
        // Invalid/expired token (401 already cleared it) or offline.
        if (!cancelled) {
          clearToken();
          setUser(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // React to a 401 anywhere in the app: drop the user so guards redirect.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("iq:unauthorized", onUnauthorized);
    return () => window.removeEventListener("iq:unauthorized", onUnauthorized);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setToken(res.token);
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* best-effort; token cleared regardless */
    }
    clearToken();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, logout }),
    [user, loading, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
