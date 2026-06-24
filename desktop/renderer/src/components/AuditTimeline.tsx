import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDate } from "@/lib/utils";

export interface AuditEntry {
  id: string;
  action: string;
  note: string | null;
  prev_value: unknown;
  new_value: unknown;
  created_at: string;
  user_name?: string;
}

const ACTION_LABELS: Record<string, string> = {
  INVOICE_UPLOADED: "Uploaded",
  AI_PROCESSED: "AI processed",
  AI_PROCESSING_FAILED: "AI processing failed",
  STATUS_CHANGED: "Status changed",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  GL_OVERRIDE: "GL override",
  LINE_ITEM_SPLIT: "Line item split",
  MANUAL_REVIEW_RESOLVED: "Manual review resolved",
  REMINDER_SENT: "Reminder sent",
  EXPORTED: "Exported",
  INVOICE_UPDATED: "Invoice updated",
};

function timestamp(iso: string) {
  const d = new Date(iso);
  return `${formatDate(iso)} ${d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

export function AuditTimeline({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-ink-subtle">No audit entries.</p>
    );
  }
  return (
    <ol className="relative space-y-1 px-4 py-2">
      {entries.map((e) => (
        <AuditRow key={e.id} entry={e} />
      ))}
    </ol>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!entry.prev_value || !!entry.new_value;
  return (
    <li className="border-l-2 border-line pl-4">
      <div
        className={`flex items-start gap-2 py-1.5 ${hasDetail ? "cursor-pointer" : ""}`}
        onClick={() => hasDetail && setOpen((o) => !o)}
      >
        {hasDetail ? (
          open ? (
            <ChevronDown className="mt-0.5 h-4 w-4 text-ink-subtle" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 text-ink-subtle" />
          )
        ) : (
          <span className="mt-1 h-2 w-2 rounded-full bg-ink-subtle" />
        )}
        <div className="flex-1">
          <p className="text-sm text-ink">
            <span className="font-medium">
              {ACTION_LABELS[entry.action] ?? entry.action}
            </span>{" "}
            <span className="text-ink-subtle">
              by {entry.user_name ?? "System"}
            </span>
          </p>
          {entry.note && <p className="text-xs text-ink-muted">{entry.note}</p>}
          <p className="text-xs text-ink-subtle">{timestamp(entry.created_at)}</p>
        </div>
      </div>
      {open && hasDetail && (
        <div className="mb-2 ml-6 grid grid-cols-2 gap-2 text-xs">
          <div className="rounded bg-surface-2 p-2">
            <p className="mb-1 font-medium text-ink-muted">Before</p>
            <pre className="whitespace-pre-wrap break-all text-ink-muted">
              {JSON.stringify(entry.prev_value ?? null, null, 2)}
            </pre>
          </div>
          <div className="rounded bg-surface-2 p-2">
            <p className="mb-1 font-medium text-ink-muted">After</p>
            <pre className="whitespace-pre-wrap break-all text-ink-muted">
              {JSON.stringify(entry.new_value ?? null, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </li>
  );
}
