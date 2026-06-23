import { useState, useRef, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import {
  Loader2,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Maximize2,
} from "lucide-react";

// Serve the pdf.js worker from the app directory so it loads under file:// in
// Electron. The file is copied from node_modules by scripts/copy-pdf-worker.mjs
// on predev/prebuild so its version always matches the installed pdfjs-dist.
// `new URL(..., import.meta.url)` resolves relative to the built bundle, which
// works for both the dev server and the packaged file:// renderer.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdf.worker.min.mjs",
  // base of the document — index.html lives next to the worker in dist/
  document.baseURI,
).toString();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.2;

export default function PdfViewer({ url }: { url: string | null }) {
  const [numPages, setNumPages] = useState(0);
  // Manual zoom multiplier. When `fitWidth` is true the page is sized to the
  // container width and `zoom` is treated as 1 (a fresh "fit" baseline); the
  // first explicit +/- drops out of fit mode so the indicator reflects reality.
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270
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

  // Leaving fit-to-width mode snaps the multiplier to 1 so the displayed size
  // is continuous (the page was already filling the width at "100%").
  const zoomOut = () => {
    setFitWidth(false);
    setZoom((z) => Math.max(MIN_ZOOM, +(z - ZOOM_STEP).toFixed(2)));
  };
  const zoomIn = () => {
    setFitWidth(false);
    setZoom((z) => Math.min(MAX_ZOOM, +(z + ZOOM_STEP).toFixed(2)));
  };
  const rotate = () => setRotation((r) => (r + 90) % 360);
  const fitToWidth = () => {
    setFitWidth(true);
    setZoom(1);
    setRotation(0);
  };

  // In fit mode the page fills the container width (rotation flips which page
  // dimension maps to that width — react-pdf handles that internally). In zoom
  // mode we render at the intrinsic page size scaled by `zoom`.
  const pageProps = fitWidth ? { width } : { scale: zoom };

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
            onClick={zoomOut}
            disabled={!fitWidth && zoom <= MIN_ZOOM}
            className="rounded p-1 text-slate-500 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Zoom out"
            title="Zoom out"
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-slate-500">
            {fitWidth ? "Fit" : `${Math.round(zoom * 100)}%`}
          </span>
          <button
            onClick={zoomIn}
            disabled={!fitWidth && zoom >= MAX_ZOOM}
            className="rounded p-1 text-slate-500 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Zoom in"
            title="Zoom in"
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <div className="mx-1 h-4 w-px bg-slate-300" aria-hidden />
          <button
            onClick={rotate}
            className="rounded p-1 text-slate-500 hover:bg-slate-200"
            aria-label="Rotate 90 degrees"
            title="Rotate 90°"
          >
            <RotateCw className="h-4 w-4" />
          </button>
          <button
            onClick={fitToWidth}
            className="rounded p-1 text-slate-500 hover:bg-slate-200"
            aria-label="Fit to width and reset"
            title="Fit to width / reset"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="scroll-thin flex-1 overflow-auto bg-slate-100 p-4"
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
                  rotate={rotation}
                  renderAnnotationLayer={false}
                  renderTextLayer={false}
                  {...pageProps}
                />
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
