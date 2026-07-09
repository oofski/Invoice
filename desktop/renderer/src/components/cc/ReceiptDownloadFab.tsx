import { Download } from "lucide-react";
import { downloadBlob } from "@/lib/utils";

/**
 * Floating "Download" action for a receipt preview. Reuses the blob the pane has
 * ALREADY fetched (no second request) and saves it locally via the shared
 * `downloadBlob` helper. Read-only: it never mutates the receipt, transaction,
 * match, or any server state — it only lets the user save a copy of what they
 * are already viewing.
 */
export function ReceiptDownloadFab({
  blob,
  fileName,
}: {
  blob: Blob | null;
  fileName?: string | null;
}) {
  if (!blob) return null;
  return (
    <button
      type="button"
      onClick={() => downloadBlob(blob, fileName || "receipt")}
      title="Download this receipt"
      className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface/95 px-3 py-2 text-sm font-medium text-ink shadow-card backdrop-blur hover:bg-surface-2"
    >
      <Download className="h-4 w-4" />
      Download
    </button>
  );
}
