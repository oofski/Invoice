import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Minimal GET hook with loading/error/refetch. Pass `null` to skip fetching.
 * For polling screens, call `refetch()` from a setInterval (no realtime here).
 */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(!!url);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!url) return;
      // `silent` keeps the current data on screen during background refreshes
      // (polls, focus, cross-view refresh events) so the page doesn't flash a
      // spinner every tick. The initial mount fetch is never silent.
      if (!opts?.silent) setLoading(true);
      setError(null);
      try {
        const result = await api.get<T>(url);
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [url],
  );

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch, setData };
}
