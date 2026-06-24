import { useCallback, useEffect, useState } from "react";
import { BellRing } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button, Spinner } from "@/components/ui/primitives";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import type { ApproverPendingCount } from "@/lib/types";

interface RemindResult {
  sent: number;
  failed: number;
  emailConfigured: boolean;
  results: { name: string; ok: boolean; reason?: string }[];
}

/** Stable selection key for an approver row (userId when present, else name). */
function keyOf(a: ApproverPendingCount): string {
  return a.userId ?? a.name;
}

/**
 * Recipient-picker modal for executives/admins to nudge approvers who have
 * pending invoices. Fetches per-approver pending counts on open, pre-checks
 * every reachable approver with outstanding work, and POSTs the chosen
 * recipients (+ an optional note) to /api/invoices/remind-approvers.
 */
export function RemindApproversModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [approvers, setApprovers] = useState<ApproverPendingCount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ approvers: ApproverPendingCount[] }>(
        "/api/invoices/approvers/pending-counts",
      );
      const list = res.approvers ?? [];
      setApprovers(list);
      // Pre-check every reachable approver who has work waiting.
      setSelected(
        new Set(
          list
            .filter((a) => a.pendingCount > 0 && a.reachable)
            .map(keyOf),
        ),
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to load approvers",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load each time the modal opens; reset transient state on close.
  useEffect(() => {
    if (open) {
      setNote("");
      load();
    }
  }, [open, load]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const reachable = approvers.filter((a) => a.reachable);
  const allReachableSelected =
    reachable.length > 0 && reachable.every((a) => selected.has(keyOf(a)));

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const allOn =
        reachable.length > 0 && reachable.every((a) => prev.has(keyOf(a)));
      return allOn ? new Set() : new Set(reachable.map(keyOf));
    });
  }, [reachable]);

  async function send() {
    if (selected.size === 0) return;
    const recipients = approvers
      .filter((a) => selected.has(keyOf(a)))
      .map((a) => ({
        userId: a.userId ?? undefined,
        name: a.name,
      }));
    const trimmed = note.trim();
    setSending(true);
    try {
      const res = await api.post<RemindResult>(
        "/api/invoices/remind-approvers",
        { recipients, note: trimmed || undefined },
      );
      if (res.emailConfigured === false) {
        // Email isn't set up — nothing was sent. Keep the modal open so the
        // exec/admin isn't misled into thinking reminders went out.
        toast.error(
          "Email isn't configured — no reminders were sent. Ask your admin to set up email (Resend).",
        );
        return;
      }
      toast.success(
        `${res.sent} sent` + (res.failed ? `, ${res.failed} failed` : ""),
      );
      // Only dismiss when at least one reminder actually went out.
      if (res.sent > 0) onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Failed to send reminders",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Remind approvers">
      {loading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : error ? (
        <div className="space-y-4">
          <p className="text-sm text-danger">{error}</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-muted">
              Pick who to nudge about their pending approvals.
            </p>
            {reachable.length > 0 && (
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs font-medium text-accent hover:text-accent-hover"
              >
                {allReachableSelected ? "Select none" : "Select all"}
              </button>
            )}
          </div>

          {approvers.length === 0 ? (
            <p className="rounded-lg bg-surface-2 px-3 py-4 text-center text-sm text-ink-muted">
              No approvers with pending invoices.
            </p>
          ) : (
            <ul className="space-y-1">
              {approvers.map((a) => {
                const key = keyOf(a);
                const checked = selected.has(key);
                return (
                  <li key={key}>
                    <label
                      title={
                        a.reachable
                          ? undefined
                          : "No app user/email for this approver"
                      }
                      className={cn(
                        "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 transition-colors",
                        a.reachable
                          ? "cursor-pointer hover:bg-surface-2"
                          : "cursor-not-allowed opacity-50",
                        checked && a.reachable && "border-selected-border bg-selected-bg",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!a.reachable}
                        onChange={() => toggle(key)}
                        className="h-4 w-4 cursor-pointer rounded border-line accent-accent disabled:cursor-not-allowed"
                        aria-label={`Select ${a.name}`}
                      />
                      <span className="flex-1 truncate font-medium text-ink">
                        {a.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-muted tabular-nums">
                        {a.pendingCount} pending
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Optional note to include in the reminder…"
            className="w-full rounded-lg border border-line bg-surface p-3 text-sm text-ink placeholder:text-ink-subtle outline-none focus:border-accent focus:ring-1 focus:ring-ring"
          />

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={send}
              loading={sending}
              disabled={selected.size === 0}
            >
              <BellRing className="h-4 w-4" />
              Send reminders
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
