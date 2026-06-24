import { useCallback, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button } from "@/components/ui/primitives";
import { useProfile } from "@/components/ProfileProvider";
import { api, ApiError } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { ROLES } from "@/lib/constants";

const STEPS = ["Uploading", "OCR", "AI Processing", "Routing", "Done"];

type FileStatus =
  | { state: "pending" }
  | { state: "processing"; step: number }
  | { state: "done"; invoiceId: string; approver: string; lineItemCount: number }
  | {
      state: "duplicate";
      vendor: string;
      invoiceNumber: string;
      totalAmount: number;
      existingId?: string;
    }
  | { state: "error"; message: string };

interface UploadItem {
  id: string;
  file: File;
  status: FileStatus;
}

export default function UploadPage() {
  const profile = useProfile();
  const isStaff = profile.role === ROLES.STAFF;
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback((files: FileList | File[]) => {
    const pdfs = Array.from(files).filter(
      (f) => f.type === "application/pdf" || f.name.endsWith(".pdf"),
    );
    setItems((prev) => [
      ...prev,
      ...pdfs.map((file) => ({
        id: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`,
        file,
        status: { state: "pending" } as FileStatus,
      })),
    ]);
  }, []);

  function setStatus(id: string, status: FileStatus) {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, status } : it)),
    );
  }

  async function processItem(item: UploadItem, override = false) {
    // Animate steps while the (synchronous) request is in flight.
    let step = 0;
    setStatus(item.id, { state: "processing", step });
    const timer = setInterval(() => {
      step = Math.min(step + 1, STEPS.length - 2);
      setStatus(item.id, { state: "processing", step });
    }, 2500);

    try {
      const form = new FormData();
      form.append("file", item.file);
      if (override) form.append("override", "true");
      if (isStaff) form.append("submissionType", "STAFF");
      const res = await api.postForm<{
        invoiceId: string;
        approver: string;
        lineItemCount: number;
      }>("/api/invoices/upload", form);
      clearInterval(timer);
      setStatus(item.id, {
        state: "done",
        invoiceId: res.invoiceId,
        approver: res.approver,
        lineItemCount: res.lineItemCount,
      });
    } catch (err) {
      clearInterval(timer);
      if (err instanceof ApiError && err.status === 409) {
        const body = err.body as {
          vendor?: string;
          invoice_number?: string;
          total_amount?: number;
          existingInvoiceId?: string;
        };
        setStatus(item.id, {
          state: "duplicate",
          vendor: body.vendor ?? item.file.name,
          invoiceNumber: body.invoice_number ?? "—",
          totalAmount: body.total_amount ?? 0,
          existingId: body.existingInvoiceId,
        });
      } else {
        setStatus(item.id, {
          state: "error",
          message: err instanceof ApiError ? err.message : "Upload failed",
        });
      }
    }
  }

  async function processAll() {
    for (const item of items) {
      if (item.status.state === "pending") {
        await processItem(item);
      }
    }
  }

  const pendingCount = items.filter((i) => i.status.state === "pending").length;

  return (
    <div>
      <PageHeader
        title={isStaff ? "Submit Invoice" : "Upload Invoices"}
        subtitle={
          isStaff
            ? "Upload a pre-approved invoice for accountant review"
            : "Drag and drop PDF invoices to process them"
        }
      />

      <div className="mx-auto max-w-3xl space-y-4 p-6">
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed bg-surface px-6 py-14 text-center transition-colors",
            dragOver
              ? "border-accent bg-selected-bg"
              : "border-line hover:border-line-strong",
          )}
        >
          <UploadCloud className="mb-3 h-10 w-10 text-ink-subtle" />
          <p className="font-medium text-ink-muted">
            Drop PDF invoices here or click to browse
          </p>
          <p className="text-sm text-ink-subtle">
            PDF only · single or batch upload
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </div>

        {items.length > 0 && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-muted">
              {items.length} file{items.length === 1 ? "" : "s"}
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setItems([])}
              >
                Clear
              </Button>
              <Button
                size="sm"
                onClick={processAll}
                disabled={pendingCount === 0}
              >
                Process {pendingCount > 0 ? `(${pendingCount})` : "all"}
              </Button>
            </div>
          </div>
        )}

        {/* File list */}
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id} className="p-4">
              <div className="flex items-start gap-3">
                <FileText className="mt-0.5 h-5 w-5 shrink-0 text-ink-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">
                      {item.file.name}
                    </p>
                    <span className="shrink-0 text-xs text-ink-subtle">
                      {(item.file.size / 1024).toFixed(0)} KB
                    </span>
                  </div>

                  <FileStatusView
                    status={item.status}
                    onOverride={() => processItem(item, true)}
                    onRetry={() => processItem(item)}
                  />
                </div>
                {item.status.state === "pending" && (
                  <button
                    onClick={() =>
                      setItems((prev) => prev.filter((p) => p.id !== item.id))
                    }
                    className="text-ink-subtle hover:text-danger"
                    aria-label="Remove"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

function FileStatusView({
  status,
  onOverride,
  onRetry,
}: {
  status: FileStatus;
  onOverride: () => void;
  onRetry: () => void;
}) {
  if (status.state === "pending") {
    return <p className="mt-1 text-xs text-ink-subtle">Ready to process</p>;
  }
  if (status.state === "processing") {
    return (
      <div className="mt-2 flex items-center gap-1.5">
        {STEPS.slice(0, STEPS.length - 1).map((label, i) => {
          const done = i < status.step;
          const active = i === status.step;
          return (
            <div key={label} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "flex items-center gap-1 text-xs",
                  done
                    ? "text-success"
                    : active
                      ? "font-medium text-accent"
                      : "text-ink-subtle",
                )}
              >
                {done ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : active ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <span className="h-3.5 w-3.5 rounded-full border border-current" />
                )}
                {label}
              </span>
              {i < STEPS.length - 2 && <span className="text-ink-subtle">→</span>}
            </div>
          );
        })}
      </div>
    );
  }
  if (status.state === "done") {
    return (
      <div className="mt-1 flex items-center gap-2 text-xs text-success">
        <CheckCircle2 className="h-4 w-4" />
        <span>
          Routed to {status.approver} · {status.lineItemCount} line items
        </span>
        <Link
          to={`/invoices/${status.invoiceId}`}
          className="font-medium text-accent hover:underline"
        >
          View
        </Link>
      </div>
    );
  }
  if (status.state === "duplicate") {
    return (
      <div className="mt-2 rounded-lg bg-warning-soft-bg p-2.5 text-xs text-warning-soft-fg">
        <div className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-4 w-4" />
          Possible duplicate detected
        </div>
        <p className="mt-1">
          {status.vendor} · #{status.invoiceNumber} ·{" "}
          {formatCurrency(status.totalAmount)} already exists.
        </p>
        <div className="mt-2 flex gap-2">
          <Button size="sm" variant="danger" onClick={onOverride}>
            Upload anyway
          </Button>
          {status.existingId && (
            <Link
              to={`/invoices/${status.existingId}`}
              className="inline-flex items-center rounded-lg border border-warning-soft-fg/30 px-2.5 py-1.5 font-medium text-warning-soft-fg hover:bg-warning-soft-bg"
            >
              View existing
            </Link>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-danger">
      <AlertTriangle className="h-4 w-4" />
      <span>{status.message}</span>
      <button onClick={onRetry} className="font-medium underline">
        Retry
      </button>
    </div>
  );
}
