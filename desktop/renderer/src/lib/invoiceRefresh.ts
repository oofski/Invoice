import { useEffect } from "react";

/**
 * Lightweight cross-view refresh signal for the INVOICE (AP) side (v1.9.6),
 * mirroring the Credit-Cards bus in `cc/ccRefresh.ts`.
 *
 * The invoice screens each keep their own local `useApi` state — there is no
 * shared query cache — so a mutation on one view can't update a sibling
 * (e.g. approving/deleting/"these are fine" in the Invoices view left the
 * Dashboard showing stale KPIs and charts until its slow poll ticked). The api
 * client (`lib/api.ts`) fires `emitInvoiceRefresh()` after every successful
 * mutating call to an invoice endpoint; live views (Dashboard, Invoices list,
 * Approvals) call `useInvoiceRefresh(refetch)` to re-pull on that event, on
 * window focus, and on a slow interval as a backstop.
 */
const INVOICE_REFRESH_EVENT = "invoice:data-changed";

/** Announce that invoice data changed so any live view refetches. */
export function emitInvoiceRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(INVOICE_REFRESH_EVENT));
  }
}

/**
 * Subscribe `onRefresh` to invoice data-change events, window focus, and a
 * periodic poll. `onRefresh` MUST be stable (wrap in `useCallback`) so the
 * subscription isn't torn down/rebuilt every render. Pass `intervalMs = 0` to
 * skip the poll.
 */
export function useInvoiceRefresh(onRefresh: () => void, intervalMs = 20000): void {
  useEffect(() => {
    const handler = () => onRefresh();
    window.addEventListener(INVOICE_REFRESH_EVENT, handler);
    window.addEventListener("focus", handler);
    const id = intervalMs > 0 ? window.setInterval(handler, intervalMs) : 0;
    return () => {
      window.removeEventListener(INVOICE_REFRESH_EVENT, handler);
      window.removeEventListener("focus", handler);
      if (id) window.clearInterval(id);
    };
  }, [onRefresh, intervalMs]);
}
