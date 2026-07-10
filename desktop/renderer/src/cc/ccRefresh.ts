import { useEffect } from "react";

/**
 * Lightweight cross-page refresh signal for the Credit Cards module (v1.9.2).
 *
 * The CC screens call `ccApi` directly with per-page local state — there is no
 * shared query cache — so a mutation on one screen can't update a sibling that
 * is already mounted (e.g. deleting an inbox receipt left the Inbox-tab badge and
 * the dashboard showing the old "unmatched" count).
 *
 * Mutation sites call `emitCcRefresh()` after a successful add / delete / match /
 * edit; live views (the dashboard, the Inbox badge) call `useCcRefresh(refetch)`
 * to re-pull on that event, on window focus, and on a slow interval as a backstop.
 */
const CC_REFRESH_EVENT = "cc:data-changed";

/** Announce that CC data changed so any live view refetches. */
export function emitCcRefresh(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CC_REFRESH_EVENT));
  }
}

/**
 * Subscribe `onRefresh` to CC data-change events, window focus, and a periodic
 * poll. `onRefresh` MUST be stable (wrap in `useCallback`) so the subscription
 * isn't torn down/rebuilt every render. Pass `intervalMs = 0` to skip the poll.
 */
export function useCcRefresh(onRefresh: () => void, intervalMs = 20000): void {
  useEffect(() => {
    const handler = () => onRefresh();
    window.addEventListener(CC_REFRESH_EVENT, handler);
    window.addEventListener("focus", handler);
    const id = intervalMs > 0 ? window.setInterval(handler, intervalMs) : 0;
    return () => {
      window.removeEventListener(CC_REFRESH_EVENT, handler);
      window.removeEventListener("focus", handler);
      if (id) window.clearInterval(id);
    };
  }, [onRefresh, intervalMs]);
}
