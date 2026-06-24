import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------- Button
type Variant = "primary" | "secondary" | "danger" | "success" | "ghost";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-fg hover:bg-primary-hover disabled:bg-primary/40 tracking-wide",
  secondary:
    "bg-surface text-ink border border-line hover:bg-surface-2 disabled:opacity-50",
  danger: "bg-danger text-danger-fg hover:bg-danger-hover disabled:bg-danger/40",
  success:
    "bg-success text-success-fg hover:bg-success-hover disabled:bg-success/40",
  ghost: "text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50",
};
const SIZES: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-xs gap-1.5",
  md: "px-4 py-2 text-sm gap-2",
  lg: "px-5 py-3 text-base gap-2",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading,
      className,
      children,
      disabled,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center rounded-lg font-medium transition-colors disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = "Button";

// ---------------------------------------------------------------- Card
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface shadow-[0_1px_2px_rgba(46,47,48,0.04),0_4px_16px_-8px_rgba(46,47,48,0.10)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Spinner
export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2 className={cn("h-5 w-5 animate-spin text-ink-subtle", className)} />
  );
}

// ---------------------------------------------------------------- Input
export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle outline-none focus:border-accent focus:ring-1 focus:ring-ring disabled:bg-surface-2",
      className,
    )}
    {...props}
  />
));
Input.displayName = "Input";

// ---------------------------------------------------------------- Select
export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle outline-none focus:border-accent focus:ring-1 focus:ring-ring disabled:bg-surface-2",
      className,
    )}
    {...props}
  >
    {children}
  </select>
));
Select.displayName = "Select";

// ---------------------------------------------------------------- Empty state
export function EmptyState({
  title,
  description,
  icon,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      {icon && <div className="text-ink-subtle">{icon}</div>}
      <p className="font-medium text-ink">{title}</p>
      {description && (
        <p className="max-w-sm text-sm text-ink-muted">{description}</p>
      )}
    </div>
  );
}
