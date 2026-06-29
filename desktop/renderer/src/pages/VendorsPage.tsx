import { useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Tags,
} from "lucide-react";
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
import type { VendorAlias, VendorMappingRow } from "@/lib/types";

type Draft = Partial<VendorMappingRow>;

const TABLE_COLSPAN = 7;

export default function VendorsPage() {
  const { data, loading, refetch } = useApi<{ vendors: VendorMappingRow[] }>(
    "/api/vendors",
  );
  const {
    data: aliasData,
    loading: aliasesLoading,
    refetch: refetchAliases,
  } = useApi<{ aliases: VendorAlias[] }>("/api/vendors/aliases");
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [adding, setAdding] = useState(false);
  const [newRow, setNewRow] = useState<Draft>({ is_inventory: false });
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const vendors = useMemo(() => data?.vendors ?? [], [data]);
  const filtered = useMemo(
    () =>
      vendors.filter((v) =>
        v.vendor_name.toLowerCase().includes(search.toLowerCase()),
      ),
    [vendors, search],
  );

  // Group aliases under their canonical vendor for the per-row sub-list.
  const aliasesByVendor = useMemo(() => {
    const map = new Map<string, VendorAlias[]>();
    for (const a of aliasData?.aliases ?? []) {
      const list = map.get(a.canonical_id);
      if (list) list.push(a);
      else map.set(a.canonical_id, [a]);
    }
    return map;
  }, [aliasData]);

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        subtitle="Routing & GL defaults · expand a vendor to map name variants (aliases) · changes apply to the next invoice processed"
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
                    const aliases = aliasesByVendor.get(v.id) ?? [];
                    const isExpanded = expanded.has(v.id);
                    return (
                      <FragmentRow key={v.id}>
                      <tr
                        className="border-b border-line hover:bg-surface-2"
                      >
                        <td className="px-4 py-2.5 font-medium text-ink">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(v.id)}
                            className="inline-flex items-center gap-1.5 text-left hover:text-accent"
                            aria-expanded={isExpanded}
                            title="Manage aliases"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                            )}
                            <span>{v.vendor_name}</span>
                            {aliases.length > 0 && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                                <Tags className="h-3 w-3" />
                                {aliases.length}
                              </span>
                            )}
                          </button>
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
                      {isExpanded && (
                        <AliasRow
                          vendor={v}
                          aliases={aliases}
                          loading={aliasesLoading}
                          onChanged={refetchAliases}
                        />
                      )}
                      </FragmentRow>
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

/**
 * Tiny fragment wrapper so each vendor maps to two sibling <tr>s (the data row
 * + its expandable alias row) under one keyed element — <> can't take a key
 * inline in the map without this.
 */
function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * The expandable per-vendor alias sub-list: existing aliases (variant text) each
 * with a delete (X), plus an inline "Add alias" input that POSTs
 * { alias_text, canonical_id }. Mirrors the inline add/edit idiom of the main
 * table. A 409 (duplicate normalized alias) surfaces as a clear toast.
 */
function AliasRow({
  vendor,
  aliases,
  loading,
  onChanged,
}: {
  vendor: VendorMappingRow;
  aliases: VendorAlias[];
  loading: boolean;
  onChanged: () => void;
}) {
  const [aliasText, setAliasText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function addAlias() {
    const text = aliasText.trim();
    if (!text) {
      toast.error("Alias text is required");
      return;
    }
    setSaving(true);
    try {
      await api.createVendorAlias(text, vendor.id);
      toast.success(`Alias “${text}” → ${vendor.vendor_name}`);
      setAliasText("");
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(
          `“${text}” is already mapped as an alias. Remove the existing mapping first.`,
        );
      } else {
        toast.error(err instanceof ApiError ? err.message : "Add alias failed");
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteAlias(alias: VendorAlias) {
    setDeletingId(alias.id);
    try {
      await api.deleteVendorAlias(alias.id);
      toast.success(`Alias “${alias.alias_text}” removed`);
      onChanged();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Remove alias failed",
      );
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <tr className="border-b border-line bg-surface-2/40">
      <td colSpan={TABLE_COLSPAN} className="px-4 py-3">
        <div className="ml-5 border-l-2 border-line pl-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-[0.1em] text-ink-muted">
            <Tags className="h-3.5 w-3.5" />
            Aliases for {vendor.vendor_name}
          </p>
          <p className="mb-3 text-xs text-ink-subtle">
            Variant / misspelled names that should inherit this vendor’s GL
            coding · applies to the next invoice processed.
          </p>

          {loading ? (
            <Spinner className="h-4 w-4" />
          ) : aliases.length === 0 ? (
            <p className="mb-3 text-xs text-ink-subtle">No aliases yet.</p>
          ) : (
            <ul className="mb-3 flex flex-col gap-1.5">
              {aliases.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-2 text-sm text-ink"
                >
                  <span className="rounded-md bg-surface px-2 py-1 font-medium">
                    {a.alias_text}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => deleteAlias(a)}
                    loading={deletingId === a.id}
                    aria-label={`Remove alias ${a.alias_text}`}
                    title="Remove alias"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex max-w-md items-center gap-1.5">
            <Input
              placeholder={`Add alias (e.g. a misspelling of ${vendor.vendor_name})`}
              value={aliasText}
              onChange={(e) => setAliasText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void addAlias();
                }
              }}
            />
            <Button size="sm" onClick={addAlias} loading={saving}>
              <Check className="h-4 w-4" /> Add
            </Button>
          </div>
        </div>
      </td>
    </tr>
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
