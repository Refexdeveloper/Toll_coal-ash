import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Field, Modal, Select } from "../components/ui.jsx";
import { allChecked, toggleAll, toggleId } from "../lib/rowSelect.js";

const ROLES = [
  { value: "admin", label: "Admin" },
  { value: "gps", label: "GPS Team" },
];

function permissionsForRole(role) {
  if (role === "admin") {
    return { admin: "1", superuser: "1", fastag: "1", routes: "1", gps: "1", checks: "1", users: "1", activity: "1" };
  }
  return { fastag: "1", routes: "1", gps: "0", checks: "1" };
}

function roleOf(user) {
  return user?.is_admin || user?.permissions?.admin || user?.permissions?.superuser ? "admin" : "gps";
}

const initialForm = {
  first_name: "",
  last_name: "",
  username: "",
  email: "",
  role: "gps",
  region_key: "central",
  password: "TempPassword123@",
  must_change_password: true,
};

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#$!";
  let pass = "";
  for (let i = 0; i < 12; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

export default function Users() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterRole, setFilterRole] = useState("all");
  const [selectedUsers, setSelectedUsers] = useState(() => new Set());
  const [exportingUsers, setExportingUsers] = useState(false);
  
  // Create User Modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [showFormPassword, setShowFormPassword] = useState(false);
  const [creating, setCreating] = useState(false);

  // Reset Password Modal state
  const [resetModalUser, setResetModalUser] = useState(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [mustChangeOnLogin, setMustChangeOnLogin] = useState(true);
  const [resetting, setResetting] = useState(false);
  const [lastResetInfo, setLastResetInfo] = useState(null);

  // Edit User Modal state
  const [editModalUser, setEditModalUser] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.users();
      setRows(r.rows || r || []);
    } catch (e) {
      toast.error(e.message || "Failed to load users");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleOpenCreate = () => {
    setForm({
      ...initialForm,
      password: generatePassword(),
    });
    setShowFormPassword(false);
    setCreateOpen(true);
  };

  const handleCreateSubmit = async (e) => {
    e.preventDefault();
    if (!form.first_name.trim() || !form.email.trim()) {
      toast.error("First name and email are required");
      return;
    }
    if (!form.password || form.password.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }

    setCreating(true);
    try {
      const role = form.role === "admin" ? "admin" : "gps";
      const payload = {
        ...form,
        username: form.username.trim() || form.email.split("@")[0],
        jobtitle: role === "admin" ? "Administrator" : "GPS Team",
        permissions: permissionsForRole(role),
      };
      await api.createUser(payload);
      toast.success(`User ${payload.first_name} created successfully`);
      setCreateOpen(false);
      load();
    } catch (err) {
      toast.error(err.message || "Could not create user");
    } finally {
      setCreating(false);
    }
  };

  const openResetModal = (user) => {
    setResetModalUser(user);
    const pwd = generatePassword();
    setNewPassword(pwd);
    setConfirmPassword(pwd);
    setShowResetPassword(true);
    setMustChangeOnLogin(true);
  };

  const handleResetSubmit = async (e) => {
    e.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }

    setResetting(true);
    try {
      await api.resetUserPassword(resetModalUser.id, newPassword, mustChangeOnLogin);
      toast.success(`Password reset for ${resetModalUser.name || resetModalUser.username}`);
      setLastResetInfo({
        username: resetModalUser.username || resetModalUser.email,
        password: newPassword,
      });
      setResetModalUser(null);
    } catch (err) {
      toast.error(err.message || "Failed to reset password");
    } finally {
      setResetting(false);
    }
  };

  const openEditModal = (user) => {
    setEditModalUser(user);
    setEditForm({
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      email: user.email || "",
      jobtitle: roleOf(user) === "admin" ? "Administrator" : "GPS Team",
      role: roleOf(user),
      region_key: user.region_key || "central",
      activated: user.activated ? 1 : 0,
    });
  };

  const handleEditSubmit = async (e) => {
    e.preventDefault();
    setSavingEdit(true);
    try {
      const role = editForm.role === "admin" ? "admin" : "gps";
      await api.patchUser(editModalUser.id, {
        ...editForm,
        jobtitle: role === "admin" ? "Administrator" : "GPS Team",
        permissions: permissionsForRole(role),
      });
      toast.success("User updated successfully");
      setEditModalUser(null);
      load();
    } catch (err) {
      toast.error(err.message || "Failed to update user");
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleActivate = async (user) => {
    const action = user.activated ? "deactivate" : "activate";
    if (!confirm(`Are you sure you want to ${action} ${user.name || user.username}?`)) return;
    try {
      if (user.activated) {
        await api.deleteUser(user.id);
        toast.success("User deactivated");
      } else {
        await api.patchUser(user.id, { activated: 1 });
        toast.success("User activated");
      }
      load();
    } catch (err) {
      toast.error(err.message || `Failed to ${action} user`);
    }
  };

  const filtered = rows.filter((u) => {
    const q = search.toLowerCase();
    const matchName = (u.name || `${u.first_name || ""} ${u.last_name || ""}`).toLowerCase().includes(q);
    const matchEmail = (u.email || "").toLowerCase().includes(q);
    const matchUsername = (u.username || "").toLowerCase().includes(q);
    const matchesSearch = !search || matchName || matchEmail || matchUsername;

    const matchesRole =
      filterRole === "all" ||
      (filterRole === "admin" && roleOf(u) === "admin") ||
      (filterRole === "gps" && roleOf(u) === "gps") ||
      (filterRole === "active" && u.activated) ||
      (filterRole === "inactive" && !u.activated);

    return matchesSearch && matchesRole;
  });

  const activeCount = rows.filter((u) => u.activated).length;
  const adminCount = rows.filter((u) => u.is_admin || u.permissions?.admin).length;

  return (
    <div className="rm-page" style={{ padding: "0 0 40px 0" }}>
      {/* Top Banner & KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 20 }}>
        <div style={{ background: "#fff", padding: "18px 20px", borderRadius: 10, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ color: "#64748B", fontSize: 13, fontWeight: 600, textTransform: "uppercase" }}>Total Accounts</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#0F172A", marginTop: 4 }}>{rows.length}</div>
        </div>
        <div style={{ background: "#fff", padding: "18px 20px", borderRadius: 10, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ color: "#16A34A", fontSize: 13, fontWeight: 600, textTransform: "uppercase" }}>Active Users</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#16A34A", marginTop: 4 }}>{activeCount}</div>
        </div>
        <div style={{ background: "#fff", padding: "18px 20px", borderRadius: 10, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ color: "#2563EB", fontSize: 13, fontWeight: 600, textTransform: "uppercase" }}>Administrators</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "#2563EB", marginTop: 4 }}>{adminCount}</div>
        </div>
        <div style={{ background: "#fff", padding: "18px 20px", borderRadius: 10, border: "1px solid #E2E8F0", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
          <div style={{ color: "#D97706", fontSize: 13, fontWeight: 600, textTransform: "uppercase" }}>Quick Action</div>
          <button
            type="button"
            className="btn btn-theme"
            style={{ marginTop: 6, width: "100%", padding: "7px 12px", fontSize: 13, fontWeight: 600 }}
            onClick={handleOpenCreate}
          >
            <i className="fas fa-user-plus" style={{ marginRight: 6 }} /> Create New User
          </button>
        </div>
      </div>

      {/* Copyable notification for last reset password */}
      {lastResetInfo ? (
        <div style={{ background: "#F0FDF4", border: "1px solid #86EFAC", padding: "14px 18px", borderRadius: 8, marginBottom: 20, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <strong style={{ color: "#166534" }}>Password successfully reset!</strong>
            <div style={{ fontSize: 13, color: "#15803D", marginTop: 2 }}>
              User: <strong>{lastResetInfo.username}</strong> | New Password: <code style={{ background: "#DCFCE7", padding: "2px 6px", borderRadius: 4, fontWeight: 700, fontSize: 13 }}>{lastResetInfo.password}</code>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="btn btn-default btn-xs"
              onClick={() => {
                navigator.clipboard.writeText(lastResetInfo.password);
                toast.success("Password copied to clipboard!");
              }}
            >
              <i className="fas fa-copy" /> Copy Password
            </button>
            <button
              type="button"
              className="btn btn-default btn-xs"
              onClick={() => setLastResetInfo(null)}
            >
              <i className="fas fa-times" />
            </button>
          </div>
        </div>
      ) : null}

      {/* Main panel */}
      <div className="rm-panel" style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", overflow: "hidden" }}>
        <div className="rm-panel__bar" style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#0F172A", display: "flex", alignItems: "center", gap: 8 }}>
              <i className="fas fa-users-cog" style={{ color: "#2079B7" }} />
              User Management
              <span style={{ fontSize: 13, color: "#64748B", fontWeight: 500, background: "#F1F5F9", padding: "2px 8px", borderRadius: 12 }}>
                {filtered.length} users
              </span>
            </h2>
          </div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ position: "relative" }}>
              <i className="fas fa-search" style={{ position: "absolute", left: 10, top: 10, color: "#94A3B8" }} />
              <input
                type="text"
                placeholder="Search name, email, username..."
                className="form-control input-sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{ paddingLeft: 30, width: 230 }}
              />
            </div>

            <select
              className="form-control input-sm"
              value={filterRole}
              onChange={(e) => setFilterRole(e.target.value)}
              style={{ width: 140 }}
            >
              <option value="all">All roles</option>
              <option value="admin">Admin</option>
              <option value="gps">GPS Team</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>

            <button
              type="button"
              className="btn btn-default btn-sm"
              disabled={!selectedUsers.size || exportingUsers}
              onClick={async () => {
                setExportingUsers(true);
                try {
                  const exported = await api.userExport([...selectedUsers]);
                  toast.success(`Exported ${selectedUsers.size} users in ${exported.filename}`);
                } catch (error) {
                  toast.error(error.message);
                } finally {
                  setExportingUsers(false);
                }
              }}
            >
              {selectedUsers.size ? `Export selected (${selectedUsers.size})` : "Export selected"}
            </button>
            <button type="button" className="btn btn-theme btn-sm" onClick={handleOpenCreate}>
              <i className="fas fa-plus" /> Add User
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="table-responsive">
          <table className="table table-striped table-hover data-list-table" style={{ margin: 0 }}>
            <thead>
              <tr style={{ background: "#F8FAFC" }}>
                <th className="pick-col">
                  <input type="checkbox" aria-label="Select all users" checked={allChecked(selectedUsers, filtered.map((user) => user.id))} onChange={() => setSelectedUsers((current) => toggleAll(current, filtered.map((user) => user.id)))} />
                </th>
                <th style={{ width: "24%" }}>User</th>
                <th style={{ width: "22%" }}>Email / Username</th>
                <th style={{ width: "16%" }}>Role / Title</th>
                <th style={{ width: "12%" }}>Region</th>
                <th style={{ width: "10%" }}>Status</th>
                <th style={{ width: "16%", textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 30, color: "#64748B" }}>
                    <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} /> Loading users...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: 35, color: "#64748B" }}>
                    No users found matching your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((u) => {
                  const isAdminUser = u.is_admin || u.permissions?.admin;
                  const initials = (u.name || `${u.first_name || "U"} ${u.last_name || ""}`)
                    .split(" ")
                    .map((n) => n[0])
                    .filter(Boolean)
                    .slice(0, 2)
                    .join("")
                    .toUpperCase();

                  return (
                    <tr key={u.id} style={{ verticalAlign: "middle" }}>
                      <td className="pick-col">
                        <input type="checkbox" aria-label={`Select ${u.email || u.name}`} checked={selectedUsers.has(u.id)} onChange={() => setSelectedUsers((current) => toggleId(current, u.id))} />
                      </td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: "50%",
                              background: isAdminUser ? "linear-gradient(135deg, #2079B7, #1E40AF)" : "#E2E8F0",
                              color: isAdminUser ? "#fff" : "#334155",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontWeight: 700,
                              fontSize: 13,
                              flexShrink: 0,
                            }}
                          >
                            {initials || "U"}
                          </div>
                          <div>
                            <div style={{ fontWeight: 700, color: "#0F172A" }}>
                              {u.name || `${u.first_name || ""} ${u.last_name || ""}`}
                            </div>
                            <div style={{ fontSize: 11, color: "#64748B" }}>
                              ID: #{u.id} {u.employee_num ? `• Emp: ${u.employee_num}` : ""}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 500, color: "#334155" }}>{u.email || "—"}</div>
                        <div style={{ fontSize: 11, color: "#64748B" }}>
                          <code>@{u.username}</code>
                        </div>
                      </td>
                      <td>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "3px 8px",
                            borderRadius: 6,
                            fontSize: 12,
                            fontWeight: 600,
                            background: isAdminUser ? "#EFF6FF" : "#F1F5F9",
                            color: isAdminUser ? "#1D4ED8" : "#475569",
                            border: isAdminUser ? "1px solid #BFDBFE" : "1px solid #E2E8F0",
                          }}
                        >
                          <i className={`fas ${isAdminUser ? "fa-shield-alt" : "fa-user"}`} style={{ marginRight: 4 }} />
                          {roleOf(u) === "admin" ? "Admin" : "GPS Team"}
                        </span>
                      </td>
                      <td>
                        <span style={{ fontSize: 12, color: "#64748B", textTransform: "capitalize" }}>
                          {u.region_key || "All Regions"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`label ${u.activated ? "label-success" : "label-danger"}`}
                          style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4 }}
                        >
                          {u.activated ? "Active" : "Disabled"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          <button
                            type="button"
                            className="btn btn-default btn-xs"
                            title="Reset Password"
                            onClick={() => openResetModal(u)}
                            style={{ color: "#D97706", borderColor: "#FCD34D", background: "#FFFBEB" }}
                          >
                            <i className="fas fa-key" style={{ marginRight: 3 }} /> Reset
                          </button>
                          <button
                            type="button"
                            className="btn btn-default btn-xs"
                            title="Edit User"
                            onClick={() => openEditModal(u)}
                          >
                            <i className="fas fa-edit" />
                          </button>
                          <button
                            type="button"
                            className={`btn btn-${u.activated ? "danger" : "success"} btn-xs`}
                            title={u.activated ? "Deactivate User" : "Activate User"}
                            onClick={() => toggleActivate(u)}
                          >
                            <i className={`fas ${u.activated ? "fa-user-slash" : "fa-user-check"}`} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CREATE USER MODAL */}
      {createOpen ? (
        <Modal title="Create New User" onClose={() => setCreateOpen(false)}>
          <form onSubmit={handleCreateSubmit}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="First Name *">
                <input
                  type="text"
                  required
                  className="form-control"
                  placeholder="e.g. Rahul"
                  value={form.first_name}
                  onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                />
              </Field>
              <Field label="Last Name">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Sharma"
                  value={form.last_name}
                  onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Email Address *">
                <input
                  type="email"
                  required
                  className="form-control"
                  placeholder="e.g. rahul@refex.co.in"
                  value={form.email}
                  onChange={(e) => {
                    const em = e.target.value;
                    setForm({
                      ...form,
                      email: em,
                      username: form.username || em.split("@")[0],
                    });
                  }}
                />
              </Field>
              <Field label="Username">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. rahul.sharma"
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Password *">
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type={showFormPassword ? "text" : "password"}
                  required
                  className="form-control"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setShowFormPassword(!showFormPassword)}
                  title="Toggle Show"
                >
                  <i className={`fas ${showFormPassword ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setForm({ ...form, password: generatePassword() })}
                  title="Generate Random Password"
                >
                  <i className="fas fa-random" />
                </button>
              </div>
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Role">
                <Select
                  value={form.role}
                  onChange={(value) => setForm({ ...form, role: value })}
                  options={ROLES}
                />
              </Field>
              <Field label="Region">
                <Select
                  value={form.region_key}
                  onChange={(v) => setForm({ ...form, region_key: v })}
                  options={[
                    { value: "central", label: "Central (Chhattisgarh/MP)" },
                    { value: "east", label: "East (Odisha/Bengal)" },
                    { value: "west", label: "West" },
                    { value: "north", label: "North" },
                    { value: "south", label: "South" },
                    { value: "all", label: "All Regions" },
                  ]}
                />
              </Field>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" className="btn btn-default" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </button>
              <button type="submit" className="btn btn-theme" disabled={creating}>
                {creating ? <><i className="fas fa-spinner fa-spin" /> Creating...</> : "Create User"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* RESET PASSWORD MODAL */}
      {resetModalUser ? (
        <Modal title={`Reset Password: ${resetModalUser.name || resetModalUser.username}`} onClose={() => setResetModalUser(null)}>
          <form onSubmit={handleResetSubmit}>
            <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", padding: "10px 14px", borderRadius: 6, marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "#92400E" }}>
                <i className="fas fa-exclamation-triangle" style={{ marginRight: 6 }} />
                You are setting a new password for <strong>{resetModalUser.email || resetModalUser.username}</strong>.
              </div>
            </div>

            <Field label="New Password *">
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type={showResetPassword ? "text" : "password"}
                  required
                  className="form-control"
                  placeholder="Enter new password (min 6 chars)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-default"
                  onClick={() => setShowResetPassword(!showResetPassword)}
                >
                  <i className={`fas ${showResetPassword ? "fa-eye-slash" : "fa-eye"}`} />
                </button>
                <button
                  type="button"
                  className="btn btn-default"
                  title="Generate Password"
                  onClick={() => {
                    const p = generatePassword();
                    setNewPassword(p);
                    setConfirmPassword(p);
                  }}
                >
                  <i className="fas fa-random" />
                </button>
              </div>
            </Field>

            <Field label="Confirm New Password *">
              <input
                type={showResetPassword ? "text" : "password"}
                required
                className="form-control"
                placeholder="Re-enter new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </Field>

            <div style={{ background: "#F8FAFC", padding: "10px 14px", borderRadius: 6, border: "1px solid #E2E8F0", marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", margin: 0, fontWeight: 500 }}>
                <input
                  type="checkbox"
                  checked={mustChangeOnLogin}
                  onChange={(e) => setMustChangeOnLogin(e.target.checked)}
                />
                <span>Require user to change password on their next sign-in</span>
              </label>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" className="btn btn-default" onClick={() => setResetModalUser(null)} disabled={resetting}>
                Cancel
              </button>
              <button type="submit" className="btn btn-theme" disabled={resetting}>
                {resetting ? <><i className="fas fa-spinner fa-spin" /> Saving...</> : "Confirm Password Reset"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* EDIT USER MODAL */}
      {editModalUser ? (
        <Modal title={`Edit User: ${editModalUser.name || editModalUser.username}`} onClose={() => setEditModalUser(null)}>
          <form onSubmit={handleEditSubmit}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="First Name">
                <input
                  type="text"
                  className="form-control"
                  value={editForm.first_name}
                  onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })}
                />
              </Field>
              <Field label="Last Name">
                <input
                  type="text"
                  className="form-control"
                  value={editForm.last_name}
                  onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Email Address">
              <input
                type="email"
                className="form-control"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Role">
                <Select
                  value={editForm.role}
                  onChange={(value) => setEditForm({ ...editForm, role: value })}
                  options={ROLES}
                />
              </Field>
              <Field label="Region">
                <Select
                  value={editForm.region_key}
                  onChange={(v) => setEditForm({ ...editForm, region_key: v })}
                  options={[
                    { value: "central", label: "Central" },
                    { value: "east", label: "East" },
                    { value: "west", label: "West" },
                    { value: "north", label: "North" },
                    { value: "south", label: "South" },
                    { value: "all", label: "All Regions" },
                  ]}
                />
              </Field>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" className="btn btn-default" onClick={() => setEditModalUser(null)} disabled={savingEdit}>
                Cancel
              </button>
              <button type="submit" className="btn btn-theme" disabled={savingEdit}>
                {savingEdit ? <><i className="fas fa-spinner fa-spin" /> Saving...</> : "Save Changes"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
