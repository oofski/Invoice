// InvoiceIQ preload script (CommonJS).
// Runs in an isolated context and exposes a tiny, safe API to the renderer.
// Keep this minimal: only expose primitive, non-sensitive values.

const { contextBridge } = require("electron");

// process.versions / process.env are available in the preload context.
// The app version is injected by Electron as an env var when packaged; fall
// back to the renderer-independent default to avoid pulling in main-process
// modules (app.getVersion() is a main-process API, not safe to call here).
const appVersion = process.env.npm_package_version || "1.0.0";

contextBridge.exposeInMainWorld("invoiceiq", {
  platform: process.platform,
  version: appVersion,
});
