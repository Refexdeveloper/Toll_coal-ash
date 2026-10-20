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
  const [gpsJob, setGpsJob] = useState(null);
  const [gpsHours, setGpsHours] = useState("2");
  const [gpsSpeed, setGpsSpeed] = useState("1");
  const [gpsEnabled, setGpsEnabled] = useState(true);
  const [savingGps, setSavingGps] = useState(false);

  useEffect(() => {
    api.gpsCollectionSettings()
      .then((data) => {
        setGpsJob(data);
        setGpsEnabled(Boolean(data.enabled));
        setGpsHours(String((Number(data.interval_minutes) || 120) / 60));
        setGpsSpeed(String(data.speed_threshold ?? 1));
      })
      .catch((error) => toast.error(error.message));
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

  async function saveGpsJob(event) {
    event.preventDefault();
    const hours = Number(gpsHours);
    const speed = Number(gpsSpeed);
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 24) {
      toast.error("Use an interval from 0.25 to 24 hours");
      return;
    }
    if (!Number.isFinite(speed) || speed < 0 || speed > 200) {
      toast.error("Use a speed from 0 to 200 km/h");
      return;
    }
    setSavingGps(true);
    try {
      const data = await api.saveGpsCollectionSettings({
        enabled: gpsEnabled,
        interval_minutes: Math.round(hours * 60),
        speed_threshold: speed,
      });
      setGpsJob(data);
      toast.success("Automatic GPS history saved");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingGps(false);
    }
  }

  async function collectNow() {
    setSavingGps(true);
    try {
      const data = await api.runGpsCollection();
      if (data.status) setGpsJob(data.status);
      toast.success(`Saved ${data.inserted || 0} moving vehicle snapshots`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSavingGps(false);
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

      <Box title="Automatic GPS history">
        <form onSubmit={saveGpsJob} className="ft-form">
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input type="checkbox" checked={gpsEnabled} onChange={(event) => setGpsEnabled(event.target.checked)} />
            <span>Collect moving vehicle locations automatically</span>
          </label>
          <div className="ft-filter-row">
            <div className="ft-field">
              <span>Interval (hours)</span>
              <input className="form-control" type="number" min="0.25" max="24" step="0.25" value={gpsHours} onChange={(event) => setGpsHours(event.target.value)} />
            </div>
            <div className="ft-field">
              <span>Moving at or above (km/h)</span>
              <input className="form-control" type="number" min="0" max="200" step="0.1" value={gpsSpeed} onChange={(event) => setGpsSpeed(event.target.value)} />
            </div>
          </div>
          <p className="text-muted">The server collects on this interval even when nobody has the site open. The default is 2 hours. A speed is used only when the live API does not already say whether the vehicle is moving. Previous snapshots stay in place.</p>
          <p className="text-muted">Last successful run: {gpsJob?.last_success_at || "not yet"}{gpsJob?.last_run?.status === "failed" ? `. Last error: ${gpsJob.last_run.error_message || "collection failed"}` : ""}</p>
          <div className="ft-actions">
            <button type="submit" className="btn btn-theme btn-sm" disabled={savingGps}>{savingGps ? "Saving…" : "Save GPS history settings"}</button>
            <button type="button" className="btn btn-default btn-sm" disabled={savingGps} onClick={collectNow}>Collect now</button>
          </div>
        </form>
        {gpsJob?.runs?.length ? (
          <div className="table-responsive" style={{ marginTop: 12 }}>
            <table className="table table-striped">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Seen</th>
                  <th>Moving</th>
                  <th>Saved</th>
                  <th>Duplicates skipped</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {gpsJob.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.started_at}</td>
                    <td>{run.status}</td>
                    <td>{run.vehicles_seen}</td>
                    <td>{run.moving}</td>
                    <td>{run.inserted}</td>
                    <td>{run.skipped_dup}</td>
                    <td>{run.error_message || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
