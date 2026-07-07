import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
  block?: boolean;
  children: ReactNode;
}

/** Large tap-target button. Shows a spinner and disables while `loading`. */
export function Button({
  variant = "primary",
  loading = false,
  block = true,
  disabled,
  className,
  children,
  ...rest
}: Props) {
  const classes = [
    "btn",
    `btn-${variant}`,
    block ? "btn-block" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner size={18} />}
      <span>{children}</span>
    </button>
  );
}
