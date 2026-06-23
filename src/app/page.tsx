import { redirect } from "next/navigation";
import { getSessionProfile } from "@/lib/auth";
import { ROLES } from "@/lib/constants";

export const dynamic = "force-dynamic";

/** Role-aware landing redirect (Brief §03 / §08). */
export default async function Home() {
  const session = await getSessionProfile();
  if (!session || !session.profile) redirect("/login");

  switch (session.profile.role) {
    case ROLES.EXECUTIVE:
      redirect("/approvals");
    case ROLES.STAFF:
      redirect("/upload");
    case ROLES.ACCOUNTANT:
    case ROLES.ADMIN:
    default:
      redirect("/dashboard");
  }
}
