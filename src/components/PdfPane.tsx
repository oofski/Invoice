"use client";

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

// react-pdf must only run in the browser — load it with SSR disabled.
const PdfViewer = dynamic(() => import("@/components/PdfViewer"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
    </div>
  ),
});

export function PdfPane({ url }: { url: string | null }) {
  return <PdfViewer url={url} />;
}
