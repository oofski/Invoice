import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Role-based route protection (Brief §12, Session 1).
 *
 * - Refreshes the Supabase session cookie on every request.
 * - Redirects unauthenticated users to /login (for pages) or returns 401
 *   (for /api routes).
 * - Fine-grained role checks (accountant vs exec vs staff vs admin) are
 *   enforced inside each route handler via requireRole(), because role lives
 *   in the `users` table which we don't query in the edge middleware.
 */

const PUBLIC_PATHS = ["/login", "/auth/callback", "/auth/auth-code-error"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (isPublic(pathname)) {
    return supabaseResponse;
  }

  if (!user) {
    if (pathname.startsWith("/api/")) {
      // Allow the internal processing endpoint to authenticate via a secret
      // header instead of a user session (it is invoked server-to-server).
      if (pathname === "/api/invoices/process") {
        return supabaseResponse;
      }
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except static assets, the PWA service worker /
     * manifest, and image files.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.json|sw.js|workbox-|icons/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|mjs)$).*)",
  ],
};
