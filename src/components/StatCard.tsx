import Link from "next/link";
import { cn } from "@/lib/utils";
import { type ReactNode } from "react";

const TONES = {
  slate: "border-slate-200",
  amber: "border-amber-300",
  red: "border-red-300",
  emerald: "border-emerald-300",
  blue: "border-blue-300",
} as const;

const VALUE_TONES = {
  slate: "text-slate-900",
  amber: "text-amber-600",
  red: "text-red-600",
  emerald: "text-emerald-600",
  blue: "text-blue-600",
} as const;

export function StatCard({
  label,
  value,
  tone = "slate",
  icon,
  href,
}: {
  label: string;
  value: ReactNode;
  tone?: keyof typeof TONES;
  icon?: ReactNode;
  href?: string;
}) {
  const inner = (
    <div
      className={cn(
        "rounded-xl border-l-4 bg-white p-4 shadow-sm transition-shadow",
        TONES[tone],
        href && "hover:shadow-md",
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {label}
        </p>
        {icon && <span className="text-slate-300">{icon}</span>}
      </div>
      <p className={cn("mt-1 text-2xl font-bold", VALUE_TONES[tone])}>{value}</p>
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}
