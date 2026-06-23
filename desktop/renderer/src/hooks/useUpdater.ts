import { useCallback, useEffect, useState } from "react";
import { desktop, type UpdateStatus } from "@/lib/desktop";

/**
 * Bridges the Settings page to the Electron auto-updater. `supported` is false
 * in a plain browser (no preload bridge), so the UI can show a passive note.
 */
export function useUpdater() {
  const d = desktop();
  const supported = !!(d && d.checkForUpdates && d.onUpdateStatus);

  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [version, setVersion] = useState<string>(d?.version ?? "");

  useEffect(() => {
    if (!d) return;
    let active = true;
    if (d.getVersion) {
      d.getVersion()
        .then((v) => {
          if (active && v) setVersion(v);
        })
        .catch(() => {});
    }
    const off = d.onUpdateStatus?.((s) => setStatus(s));
    return () => {
      active = false;
      off?.();
    };
    // window.invoiceiq is a stable singleton; run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const check = useCallback(async () => {
    if (!d?.checkForUpdates) return;
    setStatus({ state: "checking" });
    try {
      const res = await d.checkForUpdates();
      if (res?.state) setStatus(res);
    } catch (e) {
      setStatus({
        state: "error",
        message: e instanceof Error ? e.message : "Update check failed",
      });
    }
  }, [d]);

  const install = useCallback(async () => {
    await d?.installUpdate?.();
  }, [d]);

  return { supported, status, version, check, install };
}
