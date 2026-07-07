import { useEffect, useState } from "react";

/**
 * Persistent offline banner. Shown whenever `navigator.onLine === false` so the
 * exec knows a submit won't go through until they reconnect.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine === false : false,
  );

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (!offline) return null;
  return (
    <div className="offline-banner" role="status">
      You're offline — reconnect to submit.
    </div>
  );
}
