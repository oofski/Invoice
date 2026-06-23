import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { api, clearToken, getToken } from "@/lib/api";
import type { AuthUser } from "@/lib/types";
import { Spinner } from "@/components/ui/primitives";

export interface CurrentProfile {
  id: string;
  name: string;
  email: string;
  role: AuthUser["role"];
  entity_access?: string[] | null;
}

interface ProfileContextValue {
  profile: CurrentProfile;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

/**
 * Loads the current profile from GET /api/auth/me on mount and provides it (plus
 * a sign-out action) via context. Redirects to /login when there is no token or
 * the profile cannot be loaded. Wrap authenticated routes with this.
 */
export function ProfileProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<CurrentProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!getToken()) {
      navigate("/login", { replace: true });
      return;
    }
    try {
      const res = await api.get<{ user: AuthUser }>("/api/auth/me");
      setProfile({
        id: res.user.id,
        name: res.user.name,
        email: res.user.email,
        role: res.user.role,
        entity_access: res.user.entity_access ?? null,
      });
    } catch {
      clearToken();
      navigate("/login", { replace: true });
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    load();
  }, [load]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/api/auth/logout");
    } catch {
      // best-effort; clear the token regardless
    }
    clearToken();
    setProfile(null);
    navigate("/login", { replace: true });
  }, [navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (!profile) return null;

  return (
    <ProfileContext.Provider value={{ profile, signOut, refresh: load }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): CurrentProfile {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within ProfileProvider");
  return ctx.profile;
}

export function useAuth(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useAuth must be used within ProfileProvider");
  return ctx;
}
