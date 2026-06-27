import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { ccApi } from "@/cc/ccApi";

// react-pdf is heavy and browser-only — load it lazily (mirrors PdfPane).
const PdfViewer = lazy(() => import("@/components/PdfViewer"));

/**
 * CC receipt preview. Mirrors `PdfPane` but fetches the receipt bytes from
 * `/api/cc/receipts/:id/file` (auth header required, no signed URL) via
 * `ccApi.getReceiptBlob`. PDFs render in the shared `PdfViewer`; images render
 * in an `<img>` (receipts can be JPG/PNG as well as PDF).
 */
export function CcReceiptPane({
  receiptId,
  fileType,
}: {
  receiptId: string | null;
  fileType?: string | null;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [isImage, setIsImage] = useState(false);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setError(false);

    if (!receiptId) return;

    setLoading(true);
    ccApi
      .getReceiptBlob(receiptId)
      .then((blob) => {
        if (!active) return;
        // Trust the fetched blob's content-type, falling back to the row's
        // file_type, to decide PDF vs image rendering.
        const ct = (blob.type || fileType || "").toLowerCase();
        setIsImage(ct.startsWith("image/"));
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [receiptId, fileType]);

  if (!receiptId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-subtle">
        No receipt selected
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        Unable to load receipt.
      </div>
    );
  }

  if (loading || !objectUrl) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
      </div>
    );
  }

  if (isImage) {
    return (
      <div className="scroll-thin flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
        <img
          src={objectUrl}
          alt="Receipt"
          className="max-h-full max-w-full rounded shadow"
        />
      </div>
    );
  }

  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-ink-subtle" />
        </div>
      }
    >
      <PdfViewer url={objectUrl} />
    </Suspense>
  );
}
