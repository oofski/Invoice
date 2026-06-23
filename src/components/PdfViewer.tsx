"use client";

import { useState, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { Loader2, ZoomIn, ZoomOut, ExternalLink } from "lucide-react";

// Serve the pdf.js worker from /public so it works offline in the PWA shell
// (Brief §09). The file is copied from node_modules by scripts/copy-pdf-worker.mjs
// on predev/prebuild so its version always matches the installed pdfjs-dist.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export default function PdfViewer({ url }: { url: string | null }) {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1);
  const [width, setWidth] = useState<number>(600);
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const measure = () => {
      if (containerRef.current) {
        setWidth(Math.max(280, containerRef.current.clientWidth - 32));
      }
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  if (!url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        No PDF available
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="text-xs font-medium text-slate-500">
          {numPages > 0 ? `${numPages} page${numPages > 1 ? "s" : ""}` : "PDF"}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setScale((s) => Math.max(0.5, s - 0.2))}
            className="rounded p-1 text-slate-500 hover:bg-slate-200"
            aria-label="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-10 text-center text-xs text-slate-500">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(2.5, s + 0.2))}
            className="rounded p-1 text-slate-500 hover:bg-slate-200"
            aria-label="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="ml-1 rounded p-1 text-slate-500 hover:bg-slate-200"
            aria-label="Open in new tab"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div
        ref={containerRef}
        className="scroll-thin flex-1 overflow-y-auto bg-slate-100 p-4"
      >
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-red-500">
            Unable to load PDF.
          </div>
        ) : (
          <Document
            file={url}
            onLoadSuccess={({ numPages }) => setNumPages(numPages)}
            onLoadError={() => setError(true)}
            loading={
              <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            }
          >
            {Array.from({ length: numPages }, (_, i) => (
              <div
                key={i}
                className="mx-auto mb-4 w-fit overflow-hidden rounded shadow"
              >
                <Page
                  pageNumber={i + 1}
                  width={width}
                  scale={scale}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                />
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
