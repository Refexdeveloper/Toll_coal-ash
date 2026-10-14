import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Field, Kpi, Modal, Select } from "../components/ui.jsx";
import { allChecked, toggleAll, toggleId } from "../lib/rowSelect.js";

const POPULAR_CORRIDORS = [
  { name: "Raipur → Korba", from: "Raipur", to: "Korba", highway: "NH-130" },
  { name: "Bilaspur → Raigarh", from: "Bilaspur", to: "Raigarh", highway: "NH-49" },
  { name: "Raipur → Sambalpur", from: "Raipur", to: "Sambalpur", highway: "NH-53" },
  { name: "Korba → Bilaspur", from: "Korba", to: "Bilaspur", highway: "SH-4 / NH-130" },
  { name: "Delhi → Jaipur", from: "Delhi", to: "Jaipur", highway: "NH-48" },
];

export default function RouteMaster() {
  const toast = useToast();
  const [routes, setRoutes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("list"); // "list" | "create"
  const [search, setSearch] = useState("");

  // Directory of known plazas for quick autocomplete
  const [directoryPlazas, setDirectoryPlazas] = useState([]);
  const [savedOpen, setSavedOpen] = useState(false);
  const [selectedRoutes, setSelectedRoutes] = useState(() => new Set());
  const [selectedTolls, setSelectedTolls] = useState(() => new Set());
  const [exporting, setExporting] = useState("");
  const [savedTolls, setSavedTolls] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedQuery, setSavedQuery] = useState("");
  const savedRef = useRef(null);

  // Route Form State
  const [editingRouteId, setEditingRouteId] = useState(null);
  const [formName, setFormName] = useState("");
  const [formFrom, setFormFrom] = useState("");
  const [formTo, setFormTo] = useState("");
  const [formHighway, setFormHighway] = useState("");
  const [formDistance, setFormDistance] = useState("");
  const [formTime, setFormTime] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formStatus, setFormStatus] = useState("active");
  const [formTolls, setFormTolls] = useState([]);

  // Fetching state
  const [isFetchingTolls, setIsFetchingTolls] = useState(false);
  const [fetchedSummary, setFetchedSummary] = useState(null);

  // Manual Add Toll Modal
  const [addTollModalOpen, setAddTollModalOpen] = useState(false);
  const [editingTollIndex, setEditingTollIndex] = useState(null);
  const [tollForm, setTollForm] = useState({
    toll_plaza_name: "",
    location: "",
    highway: "",
    toll_plaza_geocode: "",
    plaza_code: "",
    fee_single: 100,
    fee_return: 150,
    fee_commercial: 350,
    source_type: "manual",
  });

  // View Details Modal
  const [viewingRoute, setViewingRoute] = useState(null);
  const [savingRoute, setSavingRoute] = useState(false);

  const loadRoutes = async () => {
    setLoading(true);
    try {
      const res = await api.routes();
      setRoutes(res.rows || res || []);
    } catch (err) {
      toast.error(err.message || "Failed to load routes");
    } finally {
      setLoading(false);
    }
  };

  const loadDirectory = async () => {
    try {
      const res = await api.tollPlazasDirectory();
      setDirectoryPlazas(res.rows || res || []);
    } catch {
      // directory is non-critical
    }
  };

  const loadSavedTolls = async () => {
    const res = await api.savedTolls();
    setSavedTolls(res.rows || []);
  };

  useEffect(() => {
    loadRoutes();
    loadDirectory();
    loadSavedTolls().catch((err) => toast.error(err.message || "Failed to load saved tolls"));
  }, []);

  const shownSaved = useMemo(() => {
    const query = savedQuery.trim().toLowerCase();
    if (!query) return savedTolls;
    return savedTolls.filter((row) =>
      [row.toll_plaza_name, row.location, row.highway, row.toll_plaza_geocode, row.routes]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [savedTolls, savedQuery]);

  function openSavedTolls() {
    setSavedOpen((open) => {
      const next = !open;
      if (next) {
        requestAnimationFrame(() => savedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
      }
      return next;
    });
  }

  const resetForm = () => {
    setEditingRouteId(null);
    setFormName("");
    setFormFrom("");
    setFormTo("");
    setFormHighway("");
    setFormDistance("");
    setFormTime("");
    setFormDescription("");
    setFormStatus("active");
    setFormTolls([]);
    setFetchedSummary(null);
  };

  const startCreateNew = () => {
    resetForm();
    setActiveTab("create");
  };

  const startEditRoute = async (route) => {
    try {
      const full = await api.route(route.id);
      const r = full.item || full;
      setEditingRouteId(r.id);
      setFormName(r.name || "");
      setFormFrom(r.from_location || "");
      setFormTo(r.to_location || "");
      setFormHighway(r.highway || "");
      setFormDistance(r.distance_km || "");
      setFormTime(r.est_time_hours || "");
      setFormDescription(r.description || "");
      setFormStatus(r.status || "active");
      setFormTolls(r.tolls || []);
      setFetchedSummary(null);
      setActiveTab("create");
    } catch (err) {
      toast.error(err.message || "Could not load route details");
    }
  };

  // --- PROVISION 1: FETCH TOLLS AUTOMATICALLY ---
  const handleFetchTolls = async () => {
    if (!formFrom.trim() || !formTo.trim()) {
      toast.error("Please enter both 'From Location' and 'To Location' to fetch tolls");
      return;
    }

    setIsFetchingTolls(true);
    try {
      const res = await api.fetchTollsForRoute({
        from_location: formFrom.trim(),
        to_location: formTo.trim(),
        highway: formHighway.trim(),
      });

      const data = res.item || res;
      if (data) {
        if (!formName.trim()) {
          setFormName(`${formFrom.trim()} to ${formTo.trim()} Route`);
        }
        if (data.highway && !formHighway.trim()) {
          setFormHighway(data.highway);
        }
        if (data.distance_km && !formDistance) {
          setFormDistance(data.distance_km);
        }
        if (data.est_time_hours && !formTime) {
          setFormTime(data.est_time_hours);
        }

        const newTolls = (data.tolls || []).map((t, idx) => ({
          ...t,
          seq_order: idx + 1,
          source_type: "fetched",
        }));

        setFormTolls(newTolls);
        setFetchedSummary({
          count: newTolls.length,
          distance: data.distance_km,
          highway: data.highway,
        });
        if (!newTolls.length) toast.info("No stored toll plazas between these coordinates");
        else toast.success(`Fetched ${newTolls.length} toll plazas for route ${formFrom} → ${formTo}`);
      }
    } catch (err) {
      toast.error(err.message || "Failed to fetch tolls for this route");
    } finally {
      setIsFetchingTolls(false);
    }
  };

  // --- PROVISION 2: ADD / EDIT TOLL MANUALLY ---
  const handleOpenAddToll = () => {
    setEditingTollIndex(null);
    setTollForm({
      toll_plaza_name: "",
      location: "",
      highway: formHighway || "",
      toll_plaza_geocode: "",
      plaza_code: "",
      fee_single: 100,
      fee_return: 150,
      fee_commercial: 350,
      source_type: "manual",
    });
    setAddTollModalOpen(true);
  };

  const handleOpenEditToll = (toll, index) => {
    setEditingTollIndex(index);
    setTollForm({
      ...toll,
      source_type: toll.source_type || "manual",
    });
    setAddTollModalOpen(true);
  };

  const handleSaveToll = (e) => {
    e.preventDefault();
    if (!tollForm.toll_plaza_name.trim()) {
      toast.error("Toll Plaza Name is required");
      return;
    }

    if (editingTollIndex !== null) {
      const updated = [...formTolls];
      updated[editingTollIndex] = {
        ...tollForm,
        seq_order: tollForm.seq_order || editingTollIndex + 1,
      };
      setFormTolls(updated);
      toast.success("Toll plaza updated");
    } else {
      const newToll = {
        ...tollForm,
        seq_order: formTolls.length + 1,
      };
      setFormTolls([...formTolls, newToll]);
      toast.success("Toll plaza added manually");
    }
    setAddTollModalOpen(false);
  };

  const handleDeleteToll = (index) => {
    const updated = formTolls.filter((_, i) => i !== index).map((t, i) => ({ ...t, seq_order: i + 1 }));
    setFormTolls(updated);
    toast.success("Toll removed from route");
  };

  const moveToll = (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= formTolls.length) return;
    const copy = [...formTolls];
    const temp = copy[index];
    copy[index] = copy[target];
    copy[target] = temp;
    setFormTolls(copy.map((t, i) => ({ ...t, seq_order: i + 1 })));
  };

  // Save the complete route to backend
  const handleSaveRoute = async (e) => {
    e.preventDefault();
    if (!formFrom.trim() || !formTo.trim()) {
      toast.error("From and To locations are required");
      return;
    }

    setSavingRoute(true);
    const payload = {
      name: formName.trim() || `${formFrom.trim()} to ${formTo.trim()}`,
      from_location: formFrom.trim(),
      to_location: formTo.trim(),
      highway: formHighway.trim() || null,
      distance_km: formDistance ? Number(formDistance) : null,
      est_time_hours: formTime ? Number(formTime) : null,
      description: formDescription.trim() || null,
      status: formStatus,
      tolls: formTolls,
    };

    try {
      if (editingRouteId) {
        await api.updateRoute(editingRouteId, payload);
        toast.success(`Route "${payload.name}" updated successfully`);
      } else {
        await api.createRoute(payload);
        toast.success(`Route "${payload.name}" created with ${formTolls.length} tolls`);
      }
      resetForm();
      setActiveTab("list");
      loadRoutes();
    } catch (err) {
      toast.error(err.message || "Failed to save route");
    } finally {
      setSavingRoute(false);
    }
  };

  const handleDeleteRoute = async (route) => {
    if (!confirm(`Are you sure you want to delete route "${route.name}"?`)) return;
    try {
      await api.deleteRoute(route.id);
      toast.success("Route deleted successfully");
      loadRoutes();
    } catch (err) {
      toast.error(err.message || "Failed to delete route");
    }
  };

  const handleViewRoute = async (route) => {
    try {
      const full = await api.route(route.id);
      setViewingRoute(full.item || full);
    } catch (err) {
      toast.error(err.message || "Could not load route details");
    }
  };

  // Calculations for current form
  const totalSingle = formTolls.reduce((acc, t) => acc + (Number(t.fee_single) || 0), 0);
  const totalReturn = formTolls.reduce((acc, t) => acc + (Number(t.fee_return) || 0), 0);
  const totalCommercial = formTolls.reduce((acc, t) => acc + (Number(t.fee_commercial) || 0), 0);

  const filteredRoutes = routes.filter((r) => {
    const q = search.toLowerCase();
    return (
      !search ||
      (r.name || "").toLowerCase().includes(q) ||
      (r.from_location || "").toLowerCase().includes(q) ||
      (r.to_location || "").toLowerCase().includes(q) ||
      (r.highway || "").toLowerCase().includes(q)
    );
  });

  return (
    <div className="rm-page" style={{ padding: "0 0 50px 0" }}>
      {/* Top Header & Tab Navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ background: "#EFF6FF", color: "#2079B7", padding: "8px 12px", borderRadius: 8, fontSize: 18 }}>
              <i className="fas fa-route" />
            </span>
            <div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: "#0F172A" }}>Route Master</h2>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            type="button"
            className={`btn tfx-tab ${activeTab === "list" ? "btn-theme is-active" : "btn-default"}`}
            onClick={() => setActiveTab("list")}
          >
            <i className="fas fa-list" style={{ marginRight: 6 }} /> Saved Routes ({routes.length})
          </button>
          <button
            type="button"
            className={`btn tfx-tab ${activeTab === "create" ? "btn-theme is-active" : "btn-default"}`}
            onClick={startCreateNew}
          >
            <i className="fas fa-plus" style={{ marginRight: 6 }} /> {editingRouteId ? "Edit Route" : "New Route"}
          </button>
        </div>
      </div>

      {/* TAB 1: SAVED ROUTES DIRECTORY */}
      {activeTab === "list" && (
        <div>
          {/* Quick Metrics */}
          <div className="rm-kpi-row" style={{ marginBottom: 20 }}>
            <Kpi label="Total master routes" hint="Saved routes" value={routes.length} icon="fa-route" />
            <Kpi
              label="Mapped toll plazas"
              hint="Saved plazas"
              value={savedTolls.length || routes.reduce((acc, r) => acc + (Number(r.total_tolls) || 0), 0)}
              icon="fa-road"
              tone="teal"
              active={savedOpen}
              onClick={openSavedTolls}
            />
            <Kpi label="New route" hint="Add a route" value="Create" icon="fa-plus" tone="green" onClick={startCreateNew} />
          </div>

          {savedOpen ? (
            <div ref={savedRef} className="tfx-panel" style={{ marginBottom: 20, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, color: "#0F172A" }}>Saved toll plazas</div>
                  <div style={{ fontSize: 12, color: "#64748B" }}>{shownSaved.length} of {savedTolls.length}</div>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  className="form-control input-sm"
                  placeholder="Search plaza, route, highway..."
                  value={savedQuery}
                  onChange={(event) => setSavedQuery(event.target.value)}
                  style={{ width: 260 }}
                />
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  disabled={!selectedTolls.size || exporting === "tolls"}
                  onClick={async () => {
                    setExporting("tolls");
                    try {
                      const exported = await api.savedTollExport([...selectedTolls]);
                      toast.success(`Exported ${selectedTolls.size} toll plazas in ${exported.filename}`);
                    } catch (error) {
                      toast.error(error.message);
                    } finally {
                      setExporting("");
                    }
                  }}
                >
                  {selectedTolls.size ? `Export selected (${selectedTolls.size})` : "Export selected"}
                </button>
                </div>
              </div>
              <div className="table-responsive">
                <table className="table table-striped" style={{ margin: 0 }}>
                  <thead>
                    <tr>
                      <th className="pick-col">
                        <input type="checkbox" aria-label="Select all saved tolls" checked={allChecked(selectedTolls, shownSaved.map((row) => row.toll_plaza_name))} onChange={() => setSelectedTolls((current) => toggleAll(current, shownSaved.map((row) => row.toll_plaza_name)))} />
                      </th>
                      <th>Toll plaza</th>
                      <th>Location</th>
                      <th>Highway</th>
                      <th>Coordinates</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {savedLoading ? (
                      <tr><td colSpan={6} className="text-muted">Loading saved tolls...</td></tr>
                    ) : shownSaved.length === 0 ? (
                      <tr><td colSpan={6} className="text-muted">No saved tolls match this search.</td></tr>
                    ) : shownSaved.map((row) => (
                      <tr key={`${row.source}-${row.toll_plaza_name}`}>
                        <td className="pick-col">
                          <input type="checkbox" aria-label={`Select ${row.toll_plaza_name}`} checked={selectedTolls.has(row.toll_plaza_name)} onChange={() => setSelectedTolls((current) => toggleId(current, row.toll_plaza_name))} />
                        </td>
                        <td style={{ fontWeight: 700 }}>{row.toll_plaza_name}</td>
                        <td>{row.location || "—"}</td>
                        <td>{row.highway || "—"}</td>
                        <td>{row.toll_plaza_geocode || "—"}</td>
                        <td>{row.routes || (row.source === "fastag" ? "Individual search" : "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {/* Search bar */}
          <div className="rm-panel tfx-panel">
            <div className="rm-panel__bar" style={{ padding: "14px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontWeight: 700, color: "#0F172A", fontSize: 16 }}>All Corridors & Routes</span>
                <span style={{ fontSize: 12, color: "#64748B", background: "#F1F5F9", padding: "2px 8px", borderRadius: 12 }}>
                  {filteredRoutes.length} found
                </span>
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  disabled={!selectedRoutes.size || exporting === "routes"}
                  onClick={async () => {
                    setExporting("routes");
                    try {
                      const exported = await api.routeExport([...selectedRoutes]);
                      toast.success(`Exported ${selectedRoutes.size} routes in ${exported.filename}`);
                    } catch (error) {
                      toast.error(error.message);
                    } finally {
                      setExporting("");
                    }
                  }}
                >
                  {selectedRoutes.size ? `Export selected (${selectedRoutes.size})` : "Export selected"}
                </button>
              </div>
              <div style={{ position: "relative" }}>
                <i className="fas fa-search" style={{ position: "absolute", left: 10, top: 10, color: "#94A3B8" }} />
                <input
                  type="text"
                  placeholder="Filter by route, city, highway..."
                  className="form-control input-sm"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ paddingLeft: 30, width: 260 }}
                />
              </div>
            </div>

            <div className="table-responsive">
              <table className="table table-striped table-hover data-list-table" style={{ margin: 0 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    <th className="pick-col">
                      <input type="checkbox" aria-label="Select all routes" checked={allChecked(selectedRoutes, filteredRoutes.map((row) => row.id))} onChange={() => setSelectedRoutes((current) => toggleAll(current, filteredRoutes.map((row) => row.id)))} />
                    </th>
                    <th style={{ width: "26%" }}>Route / Corridor</th>
                    <th style={{ width: "24%" }}>From → To Location</th>
                    <th style={{ width: "12%" }}>Highway</th>
                    <th style={{ width: "10%" }}>Distance</th>
                    <th style={{ width: "10%" }}>Toll Plazas</th>
                    <th style={{ width: "18%", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 30, color: "#64748B" }}>
                        <i className="fas fa-spinner fa-spin" style={{ marginRight: 8 }} /> Loading routes...
                      </td>
                    </tr>
                  ) : filteredRoutes.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 35, color: "#64748B" }}>
                        No routes found.
                      </td>
                    </tr>
                  ) : (
                    filteredRoutes.map((r) => (
                      <tr key={r.id} style={{ verticalAlign: "middle" }}>
                        <td className="pick-col">
                          <input type="checkbox" aria-label={`Select ${r.name}`} checked={selectedRoutes.has(r.id)} onChange={() => setSelectedRoutes((current) => toggleId(current, r.id))} />
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, color: "#0F172A" }}>{r.name}</div>
                          {r.description ? (
                            <div style={{ fontSize: 12, color: "#64748B" }}>{r.description}</div>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontWeight: 600, color: "#1E293B" }}>{r.from_location}</span>
                            <i className="fas fa-arrow-right" style={{ color: "#2079B7", fontSize: 12 }} />
                            <span style={{ fontWeight: 600, color: "#1E293B" }}>{r.to_location}</span>
                          </div>
                        </td>
                        <td>
                          <span style={{ background: "#F1F5F9", padding: "3px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600, color: "#334155" }}>
                            {r.highway || "NH/SH"}
                          </span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 600, color: "#334155" }}>
                            {r.distance_km ? `${r.distance_km} km` : "—"}
                          </div>
                          {r.est_time_hours ? (
                            <div style={{ fontSize: 11, color: "#64748B" }}>~{r.est_time_hours} hrs</div>
                          ) : null}
                        </td>
                        <td>
                          <span
                            style={{
                              display: "inline-block",
                              padding: "3px 8px",
                              borderRadius: 12,
                              fontSize: 12,
                              fontWeight: 700,
                              background: r.total_tolls > 0 ? "#DCFCE7" : "#FEE2E2",
                              color: r.total_tolls > 0 ? "#166534" : "#991B1B",
                            }}
                          >
                            <i className="fas fa-archway" style={{ marginRight: 4 }} />
                            {r.total_tolls || 0} tolls
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 6 }}>
                            <button
                              type="button"
                              className="btn btn-default btn-xs"
                              title="View Toll Breakdown"
                              onClick={() => handleViewRoute(r)}
                            >
                              <i className="fas fa-eye" style={{ marginRight: 4 }} /> View Tolls
                            </button>
                            <button
                              type="button"
                              className="btn btn-default btn-xs"
                              title="Edit Route"
                              onClick={() => startEditRoute(r)}
                            >
                              <i className="fas fa-edit" /> Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-xs"
                              title="Delete Route"
                              onClick={() => handleDeleteRoute(r)}
                            >
                              <i className="fas fa-trash" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: CREATE / EDIT ROUTE SCREEN (FROM & TO + TOLL PROVISIONS) */}
      {activeTab === "create" && (
        <form onSubmit={handleSaveRoute}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
            {/* Left Box: Route Information & From / To */}
            <div style={{ background: "#fff", padding: 20, borderRadius: 10, border: "1px solid #E2E8F0" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0F172A", display: "flex", alignItems: "center", gap: 8 }}>
                  <i className="fas fa-map-marker-alt" style={{ color: "#2079B7" }} />
                  Route Details
                </h3>
                {editingRouteId ? (
                  <span style={{ fontSize: 12, background: "#EFF6FF", color: "#2563EB", padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>
                    Editing Route #{editingRouteId}
                  </span>
                ) : null}
              </div>

              {/* Quick Preset Buttons */}
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", display: "block", marginBottom: 6 }}>
                  Quick Corridor Presets
                </label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {POPULAR_CORRIDORS.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      className="btn btn-default btn-xs"
                      style={{ fontSize: 11 }}
                      onClick={() => {
                        setFormName(`${c.from} to ${c.to} Coal Corridor`);
                        setFormFrom(c.from);
                        setFormTo(c.to);
                        setFormHighway(c.highway);
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="From Location (Source) *">
                  <input
                    type="text"
                    required
                    className="form-control"
                    placeholder="Raipur or 21.2500, 81.6300"
                    value={formFrom}
                    onChange={(e) => setFormFrom(e.target.value)}
                  />
                </Field>
                <Field label="To Location (Destination) *">
                  <input
                    type="text"
                    required
                    className="form-control"
                    placeholder="Korba or 22.3500, 82.7500"
                    value={formTo}
                    onChange={(e) => setFormTo(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Route Master Name">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Raipur to Korba Coal Corridor"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                />
              </Field>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <Field label="Highway / NH">
                  <input
                    type="text"
                    className="form-control"
                    placeholder="e.g. NH-130"
                    value={formHighway}
                    onChange={(e) => setFormHighway(e.target.value)}
                  />
                </Field>
                <Field label="Distance (km)">
                  <input
                    type="number"
                    step="0.1"
                    className="form-control"
                    placeholder="e.g. 215"
                    value={formDistance}
                    onChange={(e) => setFormDistance(e.target.value)}
                  />
                </Field>
                <Field label="Est. Transit (hrs)">
                  <input
                    type="number"
                    step="0.1"
                    className="form-control"
                    placeholder="e.g. 4.5"
                    value={formTime}
                    onChange={(e) => setFormTime(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="Description / Transit Notes">
                <textarea
                  className="form-control"
                  rows={2}
                  placeholder="Details regarding coal/ash loading points, vehicle restrictions, or bypasses..."
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                />
              </Field>

              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: "#334155" }}>Status:</label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
                  <input
                    type="radio"
                    name="route_status"
                    checked={formStatus === "active"}
                    onChange={() => setFormStatus("active")}
                  /> Active
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 13 }}>
                  <input
                    type="radio"
                    name="route_status"
                    checked={formStatus === "inactive"}
                    onChange={() => setFormStatus("inactive")}
                  /> Inactive
                </label>
              </div>
            </div>

            {/* Right Box: Action Center & Provisions Banner */}
            <div style={{ background: "#fff", padding: 20, borderRadius: 10, border: "1px solid #E2E8F0", display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0F172A", display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <i className="fas fa-charging-station" style={{ color: "#2079B7" }} />
                  Toll Plaza Mapping Provisions
                </h3>
                {/* Provision 1 Card */}
                <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", padding: "14px 16px", borderRadius: 8, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: "#166534", fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                        <i className="fas fa-bolt" /> Fetch tolls
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-success"
                      style={{ flexShrink: 0, fontWeight: 600 }}
                      disabled={isFetchingTolls || !formFrom || !formTo}
                      onClick={handleFetchTolls}
                    >
                      {isFetchingTolls ? (
                        <><i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} /> Fetching...</>
                      ) : (
                        <><i className="fas fa-cloud-download-alt" style={{ marginRight: 6 }} /> Fetch Tolls</>
                      )}
                    </button>
                  </div>
                </div>

                {/* Provision 2 Card */}
                <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", padding: "14px 16px", borderRadius: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
                    <div>
                      <div style={{ fontWeight: 700, color: "#1E40AF", fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                        <i className="fas fa-edit" /> Add toll manually
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ flexShrink: 0, fontWeight: 600 }}
                      onClick={handleOpenAddToll}
                    >
                      <i className="fas fa-plus" style={{ marginRight: 6 }} /> Add Toll Manually
                    </button>
                  </div>
                </div>
              </div>

              {/* Toll Summary Counters */}
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #E2E8F0", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, textAlign: "center" }}>
                <div style={{ background: "#F8FAFC", padding: "10px", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>Tolls on Route</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#0F172A" }}>{formTolls.length}</div>
                </div>
                <div style={{ background: "#F8FAFC", padding: "10px", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>Single Journey</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#2563EB" }}>₹{totalSingle}</div>
                </div>
                <div style={{ background: "#F8FAFC", padding: "10px", borderRadius: 6 }}>
                  <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>Commercial Truck</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#16A34A" }}>₹{totalCommercial}</div>
                </div>
              </div>
            </div>
          </div>

          {/* Tolls Sequence Breakdown / Table */}
          <div className="rm-panel" style={{ background: "#fff", borderRadius: 10, border: "1px solid #E2E8F0", marginBottom: 20 }}>
            <div className="rm-panel__bar" style={{ padding: "14px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#0F172A", display: "flex", alignItems: "center", gap: 8 }}>
                  <i className="fas fa-list-ol" style={{ color: "#2079B7" }} />
                  Toll Plazas Sequence in Route
                  <span style={{ fontSize: 12, background: "#F1F5F9", color: "#475569", padding: "2px 8px", borderRadius: 10 }}>
                    {formTolls.length} plazas configured
                  </span>
                </h3>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  onClick={handleOpenAddToll}
                >
                  <i className="fas fa-plus" style={{ marginRight: 4 }} /> Add Toll
                </button>
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  disabled={isFetchingTolls || !formFrom || !formTo}
                  onClick={handleFetchTolls}
                >
                  <i className="fas fa-sync" style={{ marginRight: 4 }} /> Re-Fetch Tolls
                </button>
              </div>
            </div>

            {/* Visual Route Corridor Ribbon */}
            {formFrom && formTo ? (
              <div style={{ background: "#F8FAFC", padding: "12px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", alignItems: "center", gap: 10, overflowX: "auto" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#DCFCE7", color: "#166534", padding: "4px 10px", borderRadius: 6, fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>
                  <i className="fas fa-play-circle" /> {formFrom} (Start)
                </div>

                {formTolls.map((t, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
                    <i className="fas fa-chevron-right" style={{ color: "#94A3B8", fontSize: 11 }} />
                    <div style={{ background: "#fff", border: "1px solid #CBD5E1", padding: "4px 10px", borderRadius: 6, fontSize: 12, boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                      <span style={{ fontWeight: 700, color: "#0F172A" }}>#{t.seq_order} {t.toll_plaza_name}</span>
                      <span style={{ color: "#2563EB", fontWeight: 600, marginLeft: 6 }}>₹{t.fee_single}</span>
                    </div>
                  </div>
                ))}

                <i className="fas fa-chevron-right" style={{ color: "#94A3B8", fontSize: 11 }} />
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#FEE2E2", color: "#991B1B", padding: "4px 10px", borderRadius: 6, fontWeight: 700, fontSize: 12, whiteSpace: "nowrap" }}>
                  <i className="fas fa-flag-checkered" /> {formTo} (End)
                </div>
              </div>
            ) : null}

            {/* Toll Plazas Table */}
            <div className="table-responsive">
              <table className="table table-striped table-hover data-list-table" style={{ margin: 0 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    <th style={{ width: "6%", textAlign: "center" }}>Seq</th>
                    <th style={{ width: "24%" }}>Toll Plaza Name</th>
                    <th style={{ width: "22%" }}>Location / Marker</th>
                    <th style={{ width: "10%" }}>Highway</th>
                    <th style={{ width: "12%" }}>Single (₹)</th>
                    <th style={{ width: "12%" }}>Commercial (₹)</th>
                    <th style={{ width: "16%", textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {formTolls.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: "center", padding: 35, color: "#64748B" }}>
                        No tolls added yet.
                      </td>
                    </tr>
                  ) : (
                    formTolls.map((t, idx) => (
                      <tr key={idx} style={{ verticalAlign: "middle" }}>
                        <td style={{ textAlign: "center", fontWeight: 700, color: "#2079B7" }}>
                          #{t.seq_order || idx + 1}
                        </td>
                        <td>
                          <div style={{ fontWeight: 700, color: "#0F172A" }}>{t.toll_plaza_name}</div>
                          {t.toll_plaza_geocode ? (
                            <div style={{ fontSize: 11, color: "#64748B" }}>
                              <i className="fas fa-map-pin" style={{ marginRight: 3, color: "#EF6A31" }} />
                              {t.toll_plaza_geocode}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ color: "#475569", fontSize: 13 }}>{t.location || "—"}</div>
                        </td>
                        <td>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#334155" }}>{t.highway || "—"}</span>
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "#2563EB", fontSize: 13 }}>
                            ₹{t.fee_single || 0}
                          </span>
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: "#16A34A", fontSize: 13 }}>
                            ₹{t.fee_commercial || 0}
                          </span>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <div style={{ display: "inline-flex", gap: 4 }}>
                            <button
                              type="button"
                              className="btn btn-default btn-xs"
                              disabled={idx === 0}
                              onClick={() => moveToll(idx, -1)}
                              title="Move Up"
                            >
                              <i className="fas fa-arrow-up" />
                            </button>
                            <button
                              type="button"
                              className="btn btn-default btn-xs"
                              disabled={idx === formTolls.length - 1}
                              onClick={() => moveToll(idx, 1)}
                              title="Move Down"
                            >
                              <i className="fas fa-arrow-down" />
                            </button>
                            <button
                              type="button"
                              className="btn btn-default btn-xs"
                              onClick={() => handleOpenEditToll(t, idx)}
                              title="Edit Toll"
                            >
                              <i className="fas fa-edit" />
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-xs"
                              onClick={() => handleDeleteToll(idx)}
                              title="Remove Toll"
                            >
                              <i className="fas fa-trash" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Form Actions footer */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", padding: "16px 20px", borderRadius: 10, border: "1px solid #E2E8F0" }}>
            <button
              type="button"
              className="btn btn-default"
              onClick={() => {
                resetForm();
                setActiveTab("list");
              }}
            >
              Cancel & Return to List
            </button>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="submit"
                className="btn btn-theme"
                disabled={savingRoute || !formFrom || !formTo}
              >
                {savingRoute ? (
                  <><i className="fas fa-spinner fa-spin" style={{ marginRight: 6 }} /> Saving Route...</>
                ) : (
                  <><i className="fas fa-save" style={{ marginRight: 6 }} /> {editingRouteId ? "Update Route Master" : "Save Route Master"}</>
                )}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* MODAL: ADD / EDIT TOLL PLAZA MANUALLY */}
      {addTollModalOpen ? (
        <Modal
          title={editingTollIndex !== null ? "Edit Toll Plaza" : "Add Toll Plaza Manually"}
          onClose={() => setAddTollModalOpen(false)}
        >
          <form onSubmit={handleSaveToll}>
            {/* Quick Autocomplete Suggestions from Directory */}
            {directoryPlazas.length > 0 && editingTollIndex === null ? (
              <div style={{ marginBottom: 14 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: "#64748B", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                  Pick from Existing Toll Plazas
                </label>
                <select
                  className="form-control input-sm"
                  onChange={(e) => {
                    const sel = directoryPlazas.find((p) => p.toll_plaza_name === e.target.value);
                    if (sel) {
                      setTollForm({
                        ...tollForm,
                        toll_plaza_name: sel.toll_plaza_name,
                        location: sel.location || tollForm.location,
                        highway: sel.highway || tollForm.highway,
                        toll_plaza_geocode: sel.toll_plaza_geocode || tollForm.toll_plaza_geocode,
                        fee_single: sel.fee_single || tollForm.fee_single,
                        fee_commercial: sel.fee_commercial || tollForm.fee_commercial,
                      });
                    }
                  }}
                  defaultValue=""
                >
                  <option value="" disabled>-- Select a known plaza to autofill --</option>
                  {directoryPlazas.map((p, i) => (
                    <option key={i} value={p.toll_plaza_name}>
                      {p.toll_plaza_name} ({p.highway || "NH"})
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <Field label="Toll Plaza Name *">
              <input
                type="text"
                required
                className="form-control"
                placeholder="e.g. Dhank Toll Plaza"
                value={tollForm.toll_plaza_name}
                onChange={(e) => setTollForm({ ...tollForm, toll_plaza_name: e.target.value })}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Location / District">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. Arang, Raipur District"
                  value={tollForm.location || ""}
                  onChange={(e) => setTollForm({ ...tollForm, location: e.target.value })}
                />
              </Field>
              <Field label="Highway / NH">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. NH-53"
                  value={tollForm.highway || ""}
                  onChange={(e) => setTollForm({ ...tollForm, highway: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Coordinates / Geocode (lat, lng)">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. 21.227203, 82.42025"
                  value={tollForm.toll_plaza_geocode || ""}
                  onChange={(e) => setTollForm({ ...tollForm, toll_plaza_geocode: e.target.value })}
                />
              </Field>
              <Field label="Plaza Code / ID">
                <input
                  type="text"
                  className="form-control"
                  placeholder="e.g. TP-CG-01"
                  value={tollForm.plaza_code || ""}
                  onChange={(e) => setTollForm({ ...tollForm, plaza_code: e.target.value })}
                />
              </Field>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <Field label="Single Journey (₹)">
                <input
                  type="number"
                  className="form-control"
                  value={tollForm.fee_single}
                  onChange={(e) => setTollForm({ ...tollForm, fee_single: Number(e.target.value) })}
                />
              </Field>
              <Field label="Return Journey (₹)">
                <input
                  type="number"
                  className="form-control"
                  value={tollForm.fee_return}
                  onChange={(e) => setTollForm({ ...tollForm, fee_return: Number(e.target.value) })}
                />
              </Field>
              <Field label="Commercial / Truck (₹)">
                <input
                  type="number"
                  className="form-control"
                  value={tollForm.fee_commercial}
                  onChange={(e) => setTollForm({ ...tollForm, fee_commercial: Number(e.target.value) })}
                />
              </Field>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
              <button type="button" className="btn btn-default" onClick={() => setAddTollModalOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="btn btn-theme">
                {editingTollIndex !== null ? "Update Plaza" : "Add Plaza to Route"}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {/* MODAL: VIEW ROUTE DETAILS & TOLL BREAKDOWN */}
      {viewingRoute ? (
        <Modal
          title={`Route Details: ${viewingRoute.name}`}
          onClose={() => setViewingRoute(null)}
        >
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, background: "#F8FAFC", padding: 14, borderRadius: 8, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>From Location</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>{viewingRoute.from_location}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>To Location</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#0F172A" }}>{viewingRoute.to_location}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#64748B", fontWeight: 600 }}>Highway & Distance</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#2563EB" }}>
                  {viewingRoute.highway || "NH"} • {viewingRoute.distance_km ? `${viewingRoute.distance_km} km` : "—"}
                </div>
              </div>
            </div>

            <h4 style={{ fontSize: 14, fontWeight: 700, color: "#0F172A", margin: "14px 0 10px 0" }}>
              Toll Plazas along Route ({viewingRoute.tolls?.length || 0})
            </h4>

            <div style={{ maxHeight: 320, overflowY: "auto", border: "1px solid #E2E8F0", borderRadius: 6 }}>
              <table className="table table-striped" style={{ margin: 0, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    <th>#</th>
                    <th>Plaza Name</th>
                    <th>Location</th>
                    <th>Single Fee</th>
                    <th>Commercial Truck</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewingRoute.tolls || []).map((t) => (
                    <tr key={t.id || t.seq_order}>
                      <td style={{ fontWeight: 700, color: "#2079B7" }}>#{t.seq_order}</td>
                      <td>
                        <strong>{t.toll_plaza_name}</strong>
                        {t.toll_plaza_geocode ? (
                          <div style={{ fontSize: 11, color: "#64748B" }}>{t.toll_plaza_geocode}</div>
                        ) : null}
                      </td>
                      <td>{t.location || t.highway || "—"}</td>
                      <td style={{ color: "#2563EB", fontWeight: 700 }}>₹{t.fee_single}</td>
                      <td style={{ color: "#16A34A", fontWeight: 700 }}>₹{t.fee_commercial}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 20 }}>
              <button
                type="button"
                className="btn btn-default"
                onClick={() => setViewingRoute(null)}
              >
                Close
              </button>
              <button
                type="button"
                className="btn btn-theme"
                onClick={() => {
                  const r = viewingRoute;
                  setViewingRoute(null);
                  startEditRoute(r);
                }}
              >
                <i className="fas fa-edit" style={{ marginRight: 6 }} /> Edit This Route
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
