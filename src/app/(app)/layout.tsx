import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

/**
 * Authenticated app shell layout. Guards every page in the (app) group and
 * provides the role-aware sidebar nav.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionProfile();
  if (!session || !session.profile) redirect("/login");
  const { profile } = session;
  if (!profile.is_active) redirect("/login");

  return (
    <AppShell
      profile={{
        id: profile.id,
        name: profile.name,
        email: profile.email,
        role: profile.role,
      }}
    >
      {children}
    </AppShell>
  );
}
