import Link from "next/link";
import { Card } from "@/components/ui/primitives";
import { AlertCircle } from "lucide-react";

export default function AuthCodeErrorPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <Card className="w-full max-w-md p-8 text-center">
        <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-500" />
        <h1 className="text-lg font-bold text-slate-900">
          Sign-in link invalid or expired
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          Your magic link could not be verified. Please request a new one.
        </p>
        <Link
          href="/login"
          className="mt-5 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Back to sign in
        </Link>
      </Card>
    </div>
  );
}
