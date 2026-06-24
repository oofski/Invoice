import { useMemo, useState } from "react";
import { Plus, Pencil, Check, X } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  Button,
  Input,
  Select,
  Spinner,
  EmptyState,
} from "@/components/ui/primitives";
import { GLCategorySelect } from "@/components/GLCategorySelect";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { APPROVERS, BUSINESS_ENTITIES, CLASSES } from "@/lib/constants";
import type { VendorMappingRow } from "@/lib/types";

type Draft = Partial<VendorMappingRow>;

export default function VendorsPage() {
  const { data, loading, refetch } = useApi<{ vendors: VendorMappingRow[] }>(
    "/api/vendors",
  );
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Draft>({ is_inventory: false });
  const [saving, setSaving] = useState(false);

  const vendors = useMemo(() => data?.vendors ?? [], [data]);
  const filtered = useMemo(
    () =>
      vendors.filter((v) =>
        v.vendor_name.toLowerCase().includes(search.toLowerCase()),
      ),
    [vendors, search],
  );

  function startEdit(v: VendorMappingRow) {
    setEditingId(v.id);
    setDraft({ ...v });
  }

  async function saveEdit() {
    if (!editingId) return;
    setSaving(true);
    try {
      await api.patch(`/api/vendors/${editingId}`, draft);
      toast.success("Vendor mapping updated");
      setEditingId(null);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  async function addVendor() {
    if (!newRow.vendor_name?.trim()) {
      toast.error("Vendor name is required");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/vendors", newRow);
      toast.success("Vendor mapping added");
      setNewRow({ is_inventory: false });
      setAdding(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Add failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Vendor Mappings"
        subtitle="Routing & GL defaults · changes apply to the next invoice processed"
        actions={
          <Button onClick={() => setAdding((a) => !a)} size="sm">
            <Plus className="h-4 w-4" /> Add vendor
          </Button>
        }
      />

      <div className="p-6">
        <Card>
          <div className="border-b border-line p-4">
            <Input
              placeholder="Search vendors…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-xs"
            />
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-[0.12em] text-ink-muted">
                    <th className="px-4 py-2.5 font-medium">Vendor</th>
                    <th className="px-4 py-2.5 font-medium">Entity</th>
                    <th className="px-4 py-2.5 font-medium">Class</th>
                    <th className="px-4 py-2.5 font-medium">Approver</th>
                    <th className="px-4 py-2.5 font-medium">Inventory</th>
                    <th className="px-4 py-2.5 font-medium">GL Override</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {adding && (
                    <tr className="border-b border-line bg-selected-bg">
                      <td className="px-4 py-2">
                        <Input
                          placeholder="Vendor name"
                          value={newRow.vendor_name ?? ""}
                          onChange={(e) =>
                            setNewRow((r) => ({
                              ...r,
                              vendor_name: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <EntitySelect
                          value={newRow.business_entity}
                          onChange={(v) =>
                            setNewRow((r) => ({ ...r, business_entity: v }))
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <ClassSelect
                          value={newRow.class}
                          onChange={(v) => setNewRow((r) => ({ ...r, class: v }))}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <ApproverSelect
                          value={newRow.default_approver}
                          onChange={(v) =>
                            setNewRow((r) => ({ ...r, default_approver: v }))
                          }
                        />
                      </td>
                      <td className="px-4 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={!!newRow.is_inventory}
                          onChange={(e) =>
                            setNewRow((r) => ({
                              ...r,
                              is_inventory: e.target.checked,
                            }))
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <GLCategorySelect
                          value={newRow.gl_override ?? null}
                          includeReview={false}
                          entity={newRow.business_entity}
                          onChange={(v) =>
                            setNewRow((r) => ({ ...r, gl_override: v }))
                          }
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex gap-1">
                          <Button size="sm" onClick={addVendor} loading={saving}>
                            <Check className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setAdding(false)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )}

                  {filtered.map((v) => {
                    const editing = editingId === v.id;
                    return (
                      <tr
                        key={v.id}
                        className="border-b border-line hover:bg-surface-2"
                      >
                        <td className="px-4 py-2.5 font-medium text-ink">
                          {v.vendor_name}
                        </td>
                        <td className="px-4 py-2.5">
                          {editing ? (
                            <EntitySelect
                              value={draft.business_entity}
                              onChange={(val) =>
                                setDraft((d) => ({ ...d, business_entity: val }))
                              }
                            />
                          ) : (
                            (v.business_entity ?? "—")
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {editing ? (
                            <ClassSelect
                              value={draft.class}
                              onChange={(val) =>
                                setDraft((d) => ({ ...d, class: val }))
                              }
                            />
                          ) : v.class && v.class !== "None" ? (
                            v.class
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {editing ? (
                            <ApproverSelect
                              value={draft.default_approver}
                              onChange={(val) =>
                                setDraft((d) => ({ ...d, default_approver: val }))
                              }
                            />
                          ) : (
                            (v.default_approver ?? "—")
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {editing ? (
                            <input
                              type="checkbox"
                              checked={!!draft.is_inventory}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  is_inventory: e.target.checked,
                                }))
                              }
                            />
                          ) : v.is_inventory ? (
                            "Yes"
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          {editing ? (
                            <GLCategorySelect
                              value={draft.gl_override ?? null}
                              includeReview={false}
                              entity={draft.business_entity}
                              onChange={(val) =>
                                setDraft((d) => ({ ...d, gl_override: val }))
                              }
                            />
                          ) : (
                            (v.gl_override ?? "—")
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          {editing ? (
                            <div className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                onClick={saveEdit}
                                loading={saving}
                              >
                                <Check className="h-4 w-4" />
                              </Button>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => setEditingId(null)}
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => startEdit(v)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filtered.length === 0 && !adding && (
                <EmptyState title="No vendors match your search" />
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function EntitySelect({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {BUSINESS_ENTITIES.map((b) => (
        <option key={b} value={b}>
          {b}
        </option>
      ))}
    </Select>
  );
}

function ClassSelect({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {CLASSES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </Select>
  );
}

function ApproverSelect({
  value,
  onChange,
}: {
  value?: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <Select value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {APPROVERS.map((a) => (
        <option key={a} value={a}>
          {a}
        </option>
      ))}
    </Select>
  );
}
