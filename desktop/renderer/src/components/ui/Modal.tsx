import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  bodyClassName,
  fill = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  className?: string;
  /** Extra classes for the scrollable body wrapper. */
  bodyClassName?: string;
  /**
   * When true the body becomes a clipped flex column (no scroll of its own) so
   * a child can own the single scroll region (e.g. a tall table that fills the
   * modal while the footer stays pinned). Pair with a fixed height on
   * `className` (e.g. `h-[88vh]`). Defaults to the classic scroll-the-body
   * behavior, which is unchanged for existing modals.
   */
  fill?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // `cn` is plain clsx (no tailwind-merge), so a hardcoded base width would
  // collide with a caller-supplied width — and CSS source order, not the class
  // string, decides the winner (the base usually won, capping every modal at
  // max-w-lg). Only apply the defaults the caller hasn't overridden so e.g.
  // `w-[95vw] max-w-[1600px]` actually takes effect.
  const hasWidth = /(^|\s)w-/.test(className ?? "");
  const hasMaxWidth = /(^|\s)max-w-/.test(className ?? "");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[90vh] flex-col overflow-hidden rounded-xl bg-elevated shadow-[0_12px_48px_-12px_rgba(46,47,48,0.30)]",
          hasWidth ? "" : "w-full",
          hasMaxWidth ? "" : "max-w-lg",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3.5">
            <h3 className="font-display font-semibold text-ink">{title}</h3>
            <button
              onClick={onClose}
              className="text-ink-subtle hover:text-ink"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div
          className={cn(
            "scroll-thin flex-1 p-5",
            fill ? "flex min-h-0 flex-col overflow-hidden" : "overflow-y-auto",
            bodyClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
