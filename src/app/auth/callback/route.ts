import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /auth/callback — exchanges the magic-link code for a session, then
 * redirects to the originally requested page (or the role-aware home). Brief
 * §12 Session 1 (Supabase Auth email magic link).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const redirectTo = searchParams.get("redirectTo") ?? "/";

  const supabase = createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${redirectTo}`);
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      type: type as "magiclink" | "email",
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${origin}${redirectTo}`);
  }

  return NextResponse.redirect(`${origin}/auth/auth-code-error`);
}
