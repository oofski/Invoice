"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Role } from "@/lib/constants";

export interface CurrentProfile {
  id: string;
  name: string;
  email: string;
  role: Role;
}

const ProfileContext = createContext<CurrentProfile | null>(null);

export function ProfileProvider({
  profile,
  children,
}: {
  profile: CurrentProfile;
  children: ReactNode;
}) {
  return (
    <ProfileContext.Provider value={profile}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): CurrentProfile {
  const ctx = useContext(ProfileContext);
  if (!ctx)
    throw new Error("useProfile must be used within ProfileProvider");
  return ctx;
}
