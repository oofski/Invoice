"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button, Card, Input } from "@/components/ui/primitives";
import { Mail, CheckCircle2 } from "lucide-react";

function LoginForm() {
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") ?? "/";
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const emailRedirectTo = `${window.location.origin}/auth/callback?redirectTo=${encodeURIComponent(
      redirectTo,
    )}`;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo },
    });
    setLoading(false);
    if (error) setError(error.message);
    else setSent(true);
  }

  return (
    <Card className="w-full max-w-md p-8">
      <div className="mb-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-slate-900 text-lg font-bold text-white">
          IQ
        </div>
        <h1 className="text-xl font-bold text-slate-900">InvoiceIQ</h1>
        <p className="text-sm text-slate-500">
          AP automation — sign in to continue
        </p>
      </div>

      {sent ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-emerald-50 p-6 text-center">
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
          <p className="font-medium text-emerald-800">Check your email</p>
          <p className="text-sm text-emerald-700">
            We sent a magic sign-in link to <strong>{email}</strong>.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Email address
            </label>
            <Input
              type="email"
              required
              autoFocus
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" loading={loading} className="w-full">
            <Mail className="h-4 w-4" />
            Send magic link
          </Button>
          <p className="text-center text-xs text-slate-400">
            You&apos;ll receive a one-time sign-in link. No password required.
          </p>
        </form>
      )}
    </Card>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
