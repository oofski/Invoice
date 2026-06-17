import { useState } from "react";
import { UserPlus, Copy, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import {
  Card,
  Button,
  Input,
  Select,
  Spinner,
} from "@/components/ui/primitives";
import { Modal } from "@/components/ui/Modal";
import { useApi } from "@/hooks/useApi";
import { api, ApiError } from "@/lib/api";
import { toast } from "@/components/ui/Toast";
import { ALL_ROLES, BUSINESS_ENTITIES, type Role } from "@/lib/constants";
import type { UserRow, AuthUser } from "@/lib/types";

export default function AdminUsersPage() {
  const { data, loading, refetch } = useApi<{ users: UserRow[] }>("/api/users");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "executive" });
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const users = data?.users ?? [];

  async function createUser() {
    if (!form.name || !form.email) {
      toast.error("Name and email are required");
      return;
    }
    setSaving(true);
    try {
      const res = await api.post<{ user: AuthUser; tempPassword: string }>(
        "/api/users",
        form,
      );
      toast.success("User created");
      setTempPassword(res.tempPassword);
      setForm({ name: "", email: "", role: "executive" });
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  function closeAdd() {
    setAddOpen(false);
    setTempPassword(null);
    setCopied(false);
  }

  async function copyTemp() {
    if (!tempPassword) return;
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed — select the password manually");
    }
  }

  async function patchUser(id: string, update: Partial<UserRow>) {
    setBusyId(id);
    try {
      await api.patch(`/api/users/${id}`, update);
      refetch();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  function toggleEntity(user: UserRow, entity: string) {
    const current = user.entity_access ?? [];
    const next = current.includes(entity)
      ? current.filter((e) => e !== entity)
      : [...current, entity];
    patchUser(user.id, { entity_access: next.length ? next : null });
  }

  return (
    <div>
      <PageHeader
        title="User Management"
        subtitle="Manage roles, entity access, and account status"
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="h-4 w-4" /> New user
          </Button>
        }
      />

      <div className="p-6">
        <Card>
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : (
            <div className="scroll-thin overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2.5 font-medium">Name</th>
                    <th className="px-4 py-2.5 font-medium">Email</th>
                    <th className="px-4 py-2.5 font-medium">Role</th>
                    <th className="px-4 py-2.5 font-medium">Entity Access</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-slate-100 align-top"
                    >
                      <td className="px-4 py-3 font-medium text-slate-900">
                        {u.name}
                      </td>
                      <td className="px-4 py-3 text-slate-600">{u.email}</td>
                      <td className="px-4 py-3">
                        <Select
                          value={u.role}
                          disabled={busyId === u.id}
                          onChange={(e) =>
                            patchUser(u.id, { role: e.target.value as Role })
                          }
                          className="w-36"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {BUSINESS_ENTITIES.map((b) => {
                            const on = (u.entity_access ?? []).includes(b);
                            return (
                              <button
                                key={b}
                                onClick={() => toggleEntity(u, b)}
                                disabled={busyId === u.id}
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                                  on
                                    ? "bg-blue-100 text-blue-700"
                                    : "bg-slate-100 text-slate-400"
                                }`}
                              >
                                {b}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-1 text-xs text-slate-400">
                          {(u.entity_access ?? []).length === 0
                            ? "All entities"
                            : ""}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() =>
                            patchUser(u.id, { is_active: !u.is_active })
                          }
                          disabled={busyId === u.id}
                          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                            u.is_active
                              ? "bg-emerald-100 text-emerald-700"
                              : "bg-slate-200 text-slate-500"
                          }`}
                        >
                          {u.is_active ? "Active" : "Inactive"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Modal open={addOpen} onClose={closeAdd} title="Create user">
        {tempPassword ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              User created. Share this temporary password — they will be asked to
              change it on first sign-in.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <code className="flex-1 break-all font-mono text-sm text-slate-800">
                {tempPassword}
              </code>
              <Button size="sm" variant="secondary" onClick={copyTemp}>
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex justify-end">
              <Button onClick={closeAdd}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                Name
              </label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Jane Doe"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                Email
              </label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, email: e.target.value }))
                }
                placeholder="jane@company.com"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">
                Role
              </label>
              <Select
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={closeAdd}>
                Cancel
              </Button>
              <Button onClick={createUser} loading={saving}>
                Create user
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
