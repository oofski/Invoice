import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, UserX, Users, Download } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { CcSubNav } from "@/components/cc/CcSubNav";
import {
  Card,
  Button,
  Spinner,
  EmptyState,
  Input,
  Select,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { toast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { ApiError } from "@/lib/api";
import { downloadSheet, exportDateStamp } from "@/cc/ccExport";
import { ccApi, type Cardholder } from "@/cc/ccApi";

type CardSource = "CAPITAL_ONE" | "AMEX" | "BOTH";

interface FormState {
  first_name: string;
  last_name: string;
  email: string;
  card_source: CardSource;
  cap_one_last4: string;
  amex_last5: string;
  amex_sheet_name: string;
}

const EMPTY_FORM: FormState = {
  first_name: "",
  last_name: "",
  email: "",
  card_source: "CAPITAL_ONE",
  cap_one_last4: "",
  amex_last5: "",
  amex_sheet_name: "",
};

export default function CcCardholdersPage() {
  const [cardholders, setCardholders] = useState<Cardholder[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Cardholder | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ccApi.listCardholders();
      setCardholders(res.cardholders ?? []);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load cardholders");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(c: Cardholder) {
    setEditing(c);
    setForm({
      first_name: c.first_name,
      last_name: c.last_name ?? "",
      email: c.email ?? "",
      card_source: c.card_source,
      cap_one_last4: c.cap_one_last4 ?? "",
      amex_last5: c.amex_last5 ?? "",
      amex_sheet_name: c.amex_sheet_name ?? "",
    });
    setModalOpen(true);
  }

  async function save() {
    if (!form.first_name.trim()) {
      toast.error("First name is required");
      return;
    }
    if (form.cap_one_last4 && !/^\d{4}$/.test(form.cap_one_last4)) {
      toast.error("Capital One last-4 must be 4 digits");
      return;
    }
    if (form.amex_last5 && !/^\d{5}$/.test(form.amex_last5)) {
      toast.error("Amex last-5 must be 5 digits");
      return;
    }
    setSaving(true);
    const body = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim() || undefined,
      email: form.email.trim() || undefined,
      card_source: form.card_source,
      cap_one_last4: form.cap_one_last4.trim() || undefined,
      amex_last5: form.amex_last5.trim() || undefined,
      amex_sheet_name: form.amex_sheet_name.trim() || undefined,
    };
    try {
      if (editing) {
        await ccApi.patchCardholder(editing.id, body);
        toast.success("Cardholder updated");
      } else {
        await ccApi.createCardholder(body);
        toast.success("Cardholder added");
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save cardholder");
    } finally {
      setSaving(false);
    }
  }

  async function deactivate(c: Cardholder) {
    if (
      !window.confirm(
        `Deactivate ${c.first_name}${c.last_name ? " " + c.last_name : ""}? Historical transactions are kept; the cardholder is hidden from active lists.`,
      )
    )
      return;
    try {
      await ccApi.deleteCardholder(c.id);
      toast.success("Cardholder deactivated");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Deactivate failed");
    }
  }

  async function reactivate(c: Cardholder) {
    try {
      await ccApi.patchCardholder(c.id, { is_active: true });
      toast.success("Cardholder reactivated");
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Reactivate failed");
    }
  }

  const isActive = (c: Cardholder) => c.is_active === true || c.is_active === 1;
  const visible = cardholders.filter((c) => showInactive || isActive(c));

  function exportExcel() {
    if (visible.length === 0) {
      toast.info("Nothing to export.");
      return;
    }
    const header = [
      "Name",
      "Email",
      "Source",
      "CapOne L4",
      "Amex L5",
      "Amex Sheet",
      "Status",
    ];
    const rows = visible.map((c) => [
      `${c.first_name}${c.last_name ? ` ${c.last_name}` : ""}`,
      c.email ?? "",
      c.card_source,
      c.cap_one_last4 ?? "",
      c.amex_last5 ?? "",
      c.amex_sheet_name ?? "",
      isActive(c) ? "Active" : "Inactive",
    ]);
    downloadSheet(
      `CC_Cardholders_${exportDateStamp()}.xlsx`,
      "Cardholders",
      header,
      rows,
    );
  }

  return (
    <div>
      <PageHeader
        title="Cardholders"
        subtitle="Manage the credit-card cardholder registry"
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={exportExcel}
              disabled={visible.length === 0}
            >
              <Download className="h-4 w-4" />
              Export Excel
            </Button>
            <Button onClick={openAdd}>
              <Plus className="h-4 w-4" />
              Add cardholder
            </Button>
          </div>
        }
      />
      <CcSubNav />

      <div className="p-6">
        <Card>
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-ink-subtle" />
              <h2 className="font-display text-sm font-semibold text-ink">
                Registry ({visible.length})
              </h2>
            </div>
            <label className="inline-flex items-center gap-2 text-sm text-ink-muted">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
          </div>

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              title="No cardholders"
              description="Add a cardholder to start matching transactions."
            />
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Email</th>
                    <th className="px-4 py-2.5 font-medium">Source</th>
                    <th className="px-4 py-2.5 font-medium">CapOne L4</th>
                    <th className="px-4 py-2.5 font-medium">Amex L5</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <tr
                      key={c.id}
                      className={cn(
                        "border-b border-line hover:bg-surface-2",
                        !isActive(c) && "opacity-60",
                      )}
                    >
                      <td className="px-4 py-3 font-medium text-ink">
                        {c.first_name}
                        {c.last_name ? ` ${c.last_name}` : ""}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {c.email ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-ink-muted">
                        {c.card_source}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {c.cap_one_last4 ? `••${c.cap_one_last4}` : "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums text-ink-muted">
                        {c.amex_last5 ? `••${c.amex_last5}` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
                            isActive(c)
                              ? "bg-success-soft-bg text-success-soft-fg ring-success-soft-fg/15"
                              : "bg-surface-2 text-ink-muted ring-line",
                          )}
                        >
                          {isActive(c) ? "Active" : "Inactive"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => openEdit(c)}
                            className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit
                          </button>
                          {isActive(c) ? (
                            <button
                              onClick={() => deactivate(c)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline"
                            >
                              <UserX className="h-3.5 w-3.5" />
                              Deactivate
                            </button>
                          ) : (
                            <button
                              onClick={() => reactivate(c)}
                              className="text-xs font-medium text-ink-muted hover:underline"
                            >
                              Reactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? "Edit cardholder" : "Add cardholder"}
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">
                First name *
              </label>
              <Input
                value={form.first_name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, first_name: e.target.value }))
                }
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">
                Last name
              </label>
              <Input
                value={form.last_name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, last_name: e.target.value }))
                }
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Email
            </label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) =>
                setForm((f) => ({ ...f, email: e.target.value }))
              }
              placeholder="optional — reminders fall back to mailto when empty"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Card source
            </label>
            <Select
              value={form.card_source}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  card_source: e.target.value as CardSource,
                }))
              }
            >
              <option value="CAPITAL_ONE">Capital One</option>
              <option value="AMEX">Amex</option>
              <option value="BOTH">Both</option>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">
                Capital One last-4
              </label>
              <Input
                value={form.cap_one_last4}
                maxLength={4}
                inputMode="numeric"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    cap_one_last4: e.target.value.replace(/\D/g, "").slice(0, 4),
                  }))
                }
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">
                Amex last-5
              </label>
              <Input
                value={form.amex_last5}
                maxLength={5}
                inputMode="numeric"
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    amex_last5: e.target.value.replace(/\D/g, "").slice(0, 5),
                  }))
                }
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-muted">
              Amex sheet name
            </label>
            <Input
              value={form.amex_sheet_name}
              onChange={(e) =>
                setForm((f) => ({ ...f, amex_sheet_name: e.target.value }))
              }
              placeholder='e.g. "Lori 36158"'
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {editing ? "Save changes" : "Add cardholder"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
