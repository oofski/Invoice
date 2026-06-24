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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className={cn(
          "flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-xl",
          className,
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-5 py-3.5">
            <h3 className="font-semibold text-slate-900">{title}</h3>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600"
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
