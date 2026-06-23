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

  const refetch = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<T>(url);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch, setData };
}
