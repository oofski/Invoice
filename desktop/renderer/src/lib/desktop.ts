/**
 * Typed accessor for the Electron preload bridge (window.invoiceiq). Returns
 * null when running outside the desktop app (e.g. a plain browser), so callers
 * can degrade gracefully.
 */

export type UpdateState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error"
  | "dev";

export interface UpdateStatus {
  state: UpdateState;
  version?: string;
  percent?: number;
  message?: string;
}

export interface DesktopApi {
  platform: string;
  isDesktop?: boolean;
  version: string;
  getVersion?: () => Promise<string>;
  checkForUpdates?: () => Promise<UpdateStatus>;
  installUpdate?: () => Promise<void>;
  onUpdateStatus?: (cb: (s: UpdateStatus) => void) => () => void;
  /** Open an external URL (mailto: / http(s):) in the OS default app. */
  openExternal?: (url: string) => Promise<boolean>;
}

declare global {
  interface Window {
    invoiceiq?: DesktopApi;
  }
}

export function desktop(): DesktopApi | null {
  return typeof window !== "undefined" && window.invoiceiq ? window.invoiceiq : null;
}
