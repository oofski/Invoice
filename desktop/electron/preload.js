// InvoiceIQ preload script (CommonJS).
// Runs in an isolated context and exposes a tiny, safe API to the renderer:
// app info plus the auto-update controls (check / install / status events).
// No Node or main-process objects are leaked — only these functions.

const { contextBridge, ipcRenderer } = require("electron");

// Sync fallback version; the renderer prefers getVersion() (app.getVersion()
// from the main process, which is correct in the packaged app).
const fallbackVersion = process.env.npm_package_version || "";

contextBridge.exposeInMainWorld("invoiceiq", {
  platform: process.platform,
  isDesktop: true,
  version: fallbackVersion,

  // Authoritative app version from the main process.
  getVersion: () => ipcRenderer.invoke("app:version"),

  // Trigger an update check. Resolves with a status object
  // ({ state: "checking" | "dev" | "error", ... }); ongoing progress arrives
  // via onUpdateStatus.
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),

  // Quit and install a downloaded update ("Restart now").
  installUpdate: () => ipcRenderer.invoke("updates:install"),

  // Subscribe to update lifecycle events. Returns an unsubscribe function.
  onUpdateStatus: (cb) => {
    const handler = (_event, status) => cb(status);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
});
