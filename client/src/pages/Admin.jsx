import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Box } from "../components/ui.jsx";
import Users from "./Users.jsx";

export default function Admin() {
  const toast = useToast();
  const [roles, setRoles] = useState(null);
  const [gps, setGps] = useState({});
  const [saving, setSaving] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [migration, setMigration] = useState(null);

  useEffect(() => {
    api.adminRoles()
      .then((data) => {
        setRoles(data);
        const team = (data.roles || []).find((role) => role.role_key === "gps");
        setGps(team?.permissions || {});
      })
      .catch((error) => toast.error(error.message));
  }, []);

  function toggle(key) {
    setGps((current) => ({ ...current, [key]: current[key] === "1" ? "0" : "1" }));
  }

  async function saveRoles(event) {
    event.preventDefault();
    setSaving(true);
    try {
      const data = await api.saveAdminRoles(gps);
      setRoles(data);
      const team = (data.roles || []).find((role) => role.role_key === "gps");
      setGps(team?.permissions || {});
      toast.success("GPS Team access saved");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function runMigrations() {
    if (!window.confirm("Apply database creation and pending updates? Existing toll records and users stay in place.")) return;
    setMigrating(true);
    try {
      const data = await api.runMigrations();
      setMigration(data);
      const applied = data.applied?.length || 0;
      toast.success(applied ? `Applied ${applied} database update${applied === 1 ? "" : "s"}` : "Database is already up to date");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setMigrating(false);
    }
  }

  const modules = roles?.modules || [];

  return (
    <div className="rm-page">
      <Box
        title="Database"
        tools={(
          <button type="button" className="btn btn-theme btn-sm" disabled={migrating} onClick={runMigrations}>
            {migrating ? "Updating database…" : "Run database updates"}
          </button>
        )}
      >
        <p className="text-muted">Creates the database if needed, applies pending schema files, and updates columns and indexes.</p>
        {migration ? (
          <div>
            <p><strong>{migration.table_count}</strong> tables. Column updates checked.</p>
            <p>Applied: {migration.applied?.length ? migration.applied.join(", ") : "none, already current"}</p>
            <p>Already applied: {migration.skipped?.length ? migration.skipped.join(", ") : "none"}</p>
          </div>
        ) : null}
      </Box>

      <Box title="Role configuration">
        {!roles ? <p className="text-muted">Loading roles…</p> : (
          <form onSubmit={saveRoles}>
            <div className="table-responsive">
              <table className="table table-striped">
                <thead>
                  <tr>
                    <th>Module</th>
                    <th>Admin</th>
                    <th>GPS Team</th>
                  </tr>
                </thead>
                <tbody>
                  {modules.map((mod) => (
                    <tr key={mod.key}>
                      <td>{mod.label}</td>
                      <td><input type="checkbox" checked disabled aria-label={`${mod.label} for Admin`} /></td>
                      <td>
                        <input
                          type="checkbox"
                          checked={mod.key === "gps" ? false : gps[mod.key] === "1"}
                          onChange={() => toggle(mod.key)}
                          disabled={mod.key === "gps"}
                          aria-label={`${mod.label} for GPS Team`}
                        />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>Admin panel</td>
                    <td><input type="checkbox" checked disabled aria-label="Admin panel for Admin" /></td>
                    <td><input type="checkbox" checked={false} disabled aria-label="Admin panel for GPS Team" /></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <button type="submit" className="btn btn-theme btn-sm" disabled={saving}>
              {saving ? "Saving…" : "Save GPS Team access"}
            </button>
          </form>
        )}
      </Box>

      <Users />
    </div>
  );
}
