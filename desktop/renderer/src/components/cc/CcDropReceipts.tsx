import { useEffect, useRef, useState } from "react";
import {
  Upload,
  CheckCircle2,
  Clock,
  AlertTriangle,
  X,
  Camera,
} from "lucide-react";
import { Card, Button } from "@/components/ui/primitives";
import { toast } from "@/components/ui/Toast";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { ccApi, type PerFileResult } from "@/cc/ccApi";

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = ["application/pdf", "image/jpeg", "image/png"];

/** True when this device/build can open a live camera (getUserMedia). */
function cameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/**
 * Cardholder multi-file drop zone (design §4 — Feature A). Drag-and-drop OR a
 * file picker (`multiple`). Each picked file is validated client-side (same
 * `ALLOWED` / `MAX_BYTES` as the per-tx upload flow); the valid set is sent in
 * ONE `FormData` with N `file` parts to `ccApi.dropReceipts`. The server OCRs +
 * auto-matches each one and returns a per-file result, which we render as:
 *   ✅ Matched to {vendor} {amount}   (auto-attached to a transaction)
 *   🕓 Sent to your manager to file   (queued — PENDING_MATCH)
 *   ⚠️ {file}: {error}                (unsupported / too large / OCR error)
 *
 * `onDropped` lets the parent refresh dependent lists (e.g. the tx table) once
 * a drop completes.
 */
export function CcDropReceipts({ onDropped }: { onDropped?: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PerFileResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // v1.9.1: live-camera capture (take a photo of a paper receipt). Uses
  // getUserMedia + a canvas snapshot → a JPEG File fed through the same `send`
  // path as file/drag uploads. Gracefully hidden when no camera is available.
  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canUseCamera = cameraSupported();

  function stopCamera() {
    const s = streamRef.current;
    if (s) {
      for (const track of s.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }

  // Always release the camera when the component unmounts.
  useEffect(() => stopCamera, []);

  async function openCamera() {
    if (!canUseCamera || starting) return;
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
      // Attach on the next tick once the <video> is mounted.
      requestAnimationFrame(() => {
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
      });
    } catch {
      toast.error(
        "Couldn't open the camera. Check the app's camera permission, or use Choose files.",
      );
      stopCamera();
    } finally {
      setStarting(false);
    }
  }

  function capturePhoto() {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob(
      (blob) => {
        if (!blob) {
          toast.error("Couldn't capture the photo. Try again.");
          return;
        }
        const file = new File([blob], `receipt-${Date.now()}.jpg`, {
          type: "image/jpeg",
        });
        stopCamera();
        void send([file]);
      },
      "image/jpeg",
      0.92,
    );
  }

  /** Validate the picked set; bad files become local ERROR results (never sent). */
  function partition(files: File[]): { valid: File[]; rejected: PerFileResult[] } {
    const valid: File[] = [];
    const rejected: PerFileResult[] = [];
    for (const f of files) {
      if (!ALLOWED.includes(f.type)) {
        rejected.push({
          file_name: f.name,
          status: "ERROR",
          inbox_id: "",
          error: "Unsupported file type (use PDF, JPG, or PNG).",
        });
      } else if (f.size > MAX_BYTES) {
        rejected.push({
          file_name: f.name,
          status: "ERROR",
          inbox_id: "",
          error: "File too large (max 20MB).",
        });
      } else {
        valid.push(f);
      }
    }
    return { valid, rejected };
  }

  async function send(files: File[]) {
    if (files.length === 0) return;
    const { valid, rejected } = partition(files);
    if (valid.length === 0) {
      setResults(rejected);
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of valid) form.append("file", f, f.name);
      const res = await ccApi.dropReceipts(form);
      // Show server results first, then the client-rejected files.
      setResults([...(res.results ?? []), ...rejected]);
      const matched = (res.results ?? []).filter((r) => r.status === "MATCHED").length;
      const queued = (res.results ?? []).filter(
        (r) => r.status === "PENDING_MATCH",
      ).length;
      if (matched > 0 && queued === 0) {
        toast.success(
          `${matched} receipt${matched === 1 ? "" : "s"} auto-matched`,
        );
      } else if (matched === 0 && queued > 0) {
        toast.success(
          `${queued} receipt${queued === 1 ? "" : "s"} sent to your manager`,
        );
      } else if (matched + queued > 0) {
        toast.success(`${matched} matched · ${queued} sent to manager`);
      }
      onDropped?.();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Drop failed");
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    void send(files);
  }

  return (
    <Card>
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Upload className="h-4 w-4 text-ink-subtle" />
        <h2 className="font-display text-sm font-semibold text-ink">
          Drop receipts
        </h2>
        <span className="ml-auto text-xs text-ink-muted">
          We'll match each one automatically
        </span>
      </div>

      <div className="space-y-3 p-4">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void send(files);
          }}
        />

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            "rounded-xl border-2 border-dashed p-8 text-center transition-colors",
            dragging
              ? "border-accent bg-selected-bg"
              : "border-line hover:border-accent/40",
          )}
        >
          <Upload className="mx-auto h-6 w-6 text-ink-subtle" />
          <p className="mt-2 text-sm font-medium text-ink">
            Drag receipts here, or
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              Choose files
            </Button>
            {canUseCamera && (
              <Button
                variant="secondary"
                size="sm"
                loading={starting}
                disabled={busy || cameraOn}
                onClick={openCamera}
              >
                <Camera className="h-3.5 w-3.5" />
                Take photo
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-subtle">
            PDF, JPG, or PNG · max 20MB · drop several at once
            {canUseCamera ? " · or snap a photo" : ""}
          </p>
        </div>

        {/* Live camera capture */}
        {cameraOn && (
          <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
            <div className="overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                playsInline
                muted
                className="mx-auto max-h-[50vh] w-full object-contain"
              />
            </div>
            <div className="flex items-center justify-center gap-2">
              <Button size="sm" onClick={capturePhoto} disabled={busy}>
                <Camera className="h-3.5 w-3.5" />
                Capture
              </Button>
              <Button variant="ghost" size="sm" onClick={stopCamera}>
                Cancel
              </Button>
            </div>
            <p className="text-center text-xs text-ink-subtle">
              Line up the receipt and tap Capture — it'll be matched
              automatically.
            </p>
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />

        {results.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-ink-muted">
                Results
              </p>
              <button
                onClick={() => setResults([])}
                className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            </div>
            <ul className="space-y-1.5">
              {results.map((r, i) => (
                <DropResultRow key={`${r.file_name}-${i}`} result={r} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function DropResultRow({ result }: { result: PerFileResult }) {
  if (result.status === "MATCHED") {
    const vendor = result.ocr?.merchant_name;
    const amount = result.ocr?.total;
    const date = result.ocr?.transaction_date;
    return (
      <li className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{result.file_name}</p>
          <p className="text-xs text-success">
            Matched
            {vendor ? ` to ${vendor}` : ""}
            {typeof amount === "number" ? ` · ${formatCurrency(amount)}` : ""}
            {date ? ` · ${formatDate(date)}` : ""}
          </p>
        </div>
      </li>
    );
  }
  if (result.status === "PENDING_MATCH") {
    return (
      <li className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
        <Clock className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{result.file_name}</p>
          <p className="text-xs text-ink-muted">
            Sent to your manager to file
          </p>
        </div>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <div className="min-w-0">
        <p className="truncate font-medium text-ink">{result.file_name}</p>
        <p className="text-xs text-danger">{result.error ?? "Upload failed"}</p>
      </div>
    </li>
  );
}
