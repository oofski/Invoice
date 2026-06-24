import { lazy, Suspense, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";

// react-pdf is heavy and browser-only — load it lazily.
const PdfViewer = lazy(() => import("@/components/PdfViewer"));

/**
 * Fetches the invoice PDF bytes with the auth header (Bearer required) via
 * api.getBlob, turns them into an object URL, and renders the viewer. Pass
 * `invoiceId={null}` (or hasPdf=false) to show the empty state.
 */
export function PdfPane({
  invoiceId,
  hasPdf = true,
}: {
  invoiceId: string | null;
  hasPdf?: boolean;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | null = null;

    setObjectUrl(null);
    setError(false);

    if (!invoiceId || !hasPdf) return;

    setLoading(true);
    api
      .getBlob(`/api/invoices/${invoiceId}/pdf`)
      .then((blob) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => active && setError(true))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [invoiceId, hasPdf]);

  if (!invoiceId || !hasPdf) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-subtle">
        No PDF available
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-danger">
        Unable to load PDF.
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
