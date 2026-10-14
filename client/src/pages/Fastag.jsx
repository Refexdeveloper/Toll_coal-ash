import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../api/AuthContext.jsx";
import { useToast } from "../components/Toast.jsx";
import { Box, DateField, Modal } from "../components/ui.jsx";
import TollMap, { formatCoord, mapsHref, parseGeocode } from "../components/TollMap.jsx";
import { allChecked, toggleAll, toggleId } from "../lib/rowSelect.js";

function readDay(row) {
  const raw = String(row.reader_read_time || row.fetched_at || row.created_at || "");
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function entryStamp(row) {
  const raw = String(row.reader_read_time || "").trim();
  if (!raw) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T"));
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function clockBound(time, end) {
  const parts = String(time || "").split(":");
  const hour = parts[0] || "00";
  const minute = parts[1] || "00";
  const second = parts[2] || (end ? "59" : "00");
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}:${second.padStart(2, "0")}`;
}

function splitSite(value) {
  const text = String(value || "").trim();
  const match = text.match(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!match) return { place: text, coordinates: "" };
  const coordinates = `${match[1]}, ${match[2]}`;
  const place = text.replace(match[0], "").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return { place, coordinates };
}

function joinSite(place, coordinates) {
  return [String(place || "").trim(), String(coordinates || "").trim()].filter(Boolean).join(" ");
}

function coordinatesLookValid(value) {
  const text = String(value || "").trim();
  if (!text) return true;
  const match = text.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return false;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function statusLabel(status) {
  if (status === "ok") return { text: "Stored", cls: "label label-success" };
  if (status === "empty") return { text: "No reads", cls: "label label-warning" };
  if (status === "error") return { text: "Failed", cls: "label label-danger" };
  if (status === "running") return { text: "Fetching", cls: "label label-info" };
  if (status === "done") return { text: "Done", cls: "label label-success" };
  if (status === "failed") return { text: "Failed", cls: "label label-danger" };
  if (status === "pending") return { text: "Waiting", cls: "label label-default" };
  return { text: "Ready", cls: "label label-primary" };
}

export default function Fastag() {
  const toast = useToast();
  const { can, isAdmin } = useAuth();
  const [batches, setBatches] = useState([]);
  const [detail, setDetail] = useState(null);
  const [activity, setActivity] = useState([]);
  const [plate, setPlate] = useState("");
  const [listVehicle, setListVehicle] = useState("");
  const [listChallan, setListChallan] = useState("");
  const [listProject, setListProject] = useState("");
  const [listDate, setListDate] = useState("");
  const [priorRows, setPriorRows] = useState([]);
  const [priorOpen, setPriorOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [challanId, setChallanId] = useState("");
  const [fromPlace, setFromPlace] = useState("");
  const [fromCoordinates, setFromCoordinates] = useState("");
  const [toPlace, setToPlace] = useState("");
  const [toCoordinates, setToCoordinates] = useState("");
  const [fetchFrom, setFetchFrom] = useState("");
  const [fetchTo, setFetchTo] = useState("");
  const [routeChoice, setRouteChoice] = useState("");
  const [routes, setRoutes] = useState([]);
  const [storedRows, setStoredRows] = useState(null);
  const [file, setFile] = useState(null);
  const [uploadErrors, setUploadErrors] = useState([]);
  const [preview, setPreview] = useState(null);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [headingFilter, setHeadingFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedRead, setSelectedRead] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [activityTotal, setActivityTotal] = useState(0);
  const [loadState, setLoadState] = useState("loading");
  const searchRef = useRef(null);
  const uploadRef = useRef(null);
  const recordsRef = useRef(null);
  const vehiclesRef = useRef(null);
  const searchGen = useRef(0);
  const [dateFrom, setDateFrom] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState("");
  const mapRef = useRef(null);

  async function loadActivity(offset = 0) {
    const data = await api.fastagActivity(8, offset);
    setActivityTotal(Number(data.total || 0));
    const rows = data.rows || [];
    setActivity((current) => (offset ? [...current, ...rows] : rows));
  }

  async function loadList() {
    const data = await api.fastagBatches();
    const rows = data.rows || [];
    setBatches(rows);
    return rows;
  }

  async function openBatch(id) {
    const data = await api.fastagBatch(id);
    setDetail(data);
    return data;
  }

  useEffect(() => {
    loadList()
      .then((rows) => { if (rows[0]) return openBatch(rows[0].id); })
      .catch((error) => { setLoadState("error"); toast.error(error.message); })
      .finally(() => setLoadState("ready"));
    if (can("activity")) loadActivity().catch((error) => toast.error(error.message));
    api.routes().then((data) => setRoutes(data.rows || [])).catch(() => undefined);
  }, []);

  const batch = detail?.batch;
  const running = batch?.status === "running" || busy === "fetch";

  useEffect(() => {
    if (!batch || batch.status !== "running") return undefined;
    const timer = window.setInterval(() => {
      openBatch(batch.id)
        .then((data) => {
          if (data.batch.status !== "running") {
            if (can("activity")) loadActivity().catch(() => undefined);
            return loadList();
          }
        })
        .catch((error) => toast.error(error.message));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [batch?.id, batch?.status]);

  async function previewSheet(event) {
    event.preventDefault();
    if (!file) {
      toast.error("Choose an Excel or CSV file");
      return;
    }
    setBusy("preview");
    try {
      const data = await api.fastagPreview(file);
      const problems = [...(data.errors || []), ...(data.duplicates || [])];
      setPreview(data);
      setUploadErrors(problems.map((item) => item.message));
      if (problems.length) {
        toast.flag(`Trip sheet flagged. ${problems.length} row${problems.length === 1 ? "" : "s"} need attention.`);
      }
    } catch (error) {
      const messages = error.messages || [error.message];
      setPreview(null);
      setUploadErrors(messages);
      if (messages.length > 1) toast.flag(`Trip sheet flagged. ${messages.length} rows need attention.`);
      else toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  async function confirmImport() {
    if (!file || !preview?.valid_rows || busy === "upload") return;
    setBusy("upload");
    try {
      const data = await api.fastagUpload(file);
      const rejected = data.rejected || [];
      setDetail(data);
      setUploadErrors(rejected.map((item) => item.message));
      setPreview(null);
      setFile(null);
      await loadList();
      if (can("activity")) await loadActivity();
      toast.success(`${data.batch.vehicle_count} vehicle${data.batch.vehicle_count === 1 ? "" : "s"} imported`);
      if (rejected.length) toast.flag(`Trip sheet flagged. ${rejected.length} row${rejected.length === 1 ? "" : "s"} were not imported.`);
    } catch (error) {
      setUploadErrors(error.messages || [error.message]);
      toast.error(error.messages?.length > 1 ? `${error.messages.length} rows were not imported` : error.message);
    } finally {
      setBusy("");
    }
  }

  async function retryFailed() {
    if (!batch) return;
    setBusy("retry");
    try {
      const data = await api.fastagRetryFailed(batch.id);
      await openBatch(batch.id);
      toast.info(`Re-running ${data.count} failed vehicle${data.count === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  async function fetchBatch() {
    if (!batch || running) return;
    setBusy("fetch");
    try {
      await api.fastagFetch(batch.id);
      await openBatch(batch.id);
      toast.info("Fetching toll data");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      api.fastagEntered({
        vehicle: listVehicle.trim(),
        challan: listChallan.trim(),
        project: listProject.trim(),
        date: listDate,
      })
        .then((data) => setPriorRows(data.rows || []))
        .catch(() => setPriorRows([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [listVehicle, listChallan, listProject, listDate]);

  useEffect(() => {
    if (!priorOpen) return undefined;
    function close(event) {
      if (!event.target.closest(".ft-prior") && !event.target.closest(".date-picker")) setPriorOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [priorOpen]);

  async function openStoredVehicle(row) {
    const value = row.vehicle_reg_no;
    setPlate(value);
    setPriorOpen(false);
    if (listDate) {
      setDateFrom(listDate);
      setDateTo(listDate);
      setTimeFrom("");
      setTimeTo("");
    }
    searchGen.current += 1;
    try {
      const data = await api.fastagRecords(value);
      const rows = (data.rows || []).filter((item) => {
        if (row.project_name && item.project_name !== row.project_name) return false;
        if (row.challan_id && item.challan_id !== row.challan_id) return false;
        return true;
      });
      setStoredRows(rows);
      setPage(1);
      setPicked(null);
      recordsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      toast.success(rows.length ? `Showing ${rows.length} stored toll${rows.length === 1 ? "" : "s"} for ${value}` : `No stored tolls for ${value}`);
    } catch (error) {
      toast.error(error.message);
    }
  }

  useEffect(() => {
    const value = plate.trim();
    const compact = value.replace(/[^A-Za-z0-9]/g, "");
    if (compact.length < 4) {
      setStoredRows(null);
      return undefined;
    }
    const gen = searchGen.current + 1;
    searchGen.current = gen;
    const timer = window.setTimeout(async () => {
      try {
        const data = await api.fastagRecords(value);
        if (searchGen.current !== gen) return;
        setStoredRows(data.rows || []);
        setPage(1);
      } catch (error) {
        if (searchGen.current === gen) toast.error(error.message);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [plate]);

  async function lookup(event) {
    event.preventDefault();
    const value = plate.trim();
    if (value.replace(/[^A-Za-z0-9]/g, "").length < 4) {
      toast.error("Enter a vehicle number like CG13BF6032");
      return;
    }
    if (!projectName.trim()) {
      toast.error("Enter a project name");
      return;
    }
    if (!challanId.trim()) {
      toast.error("Enter a challan ID");
      return;
    }
    if (busy === "lookup" || running) return;
    if (!coordinatesLookValid(fromCoordinates) || !coordinatesLookValid(toCoordinates)) {
      toast.error("Enter coordinates as latitude, longitude, such as 21.2500, 81.6300");
      return;
    }
    if (fetchFrom && fetchTo && fetchFrom > fetchTo) {
      toast.error("The from date must be on or before the to date");
      return;
    }
    searchGen.current += 1;
    setBusy("lookup");
    try {
      const data = await api.fastagLookup(value, {
        projectName: projectName.trim(),
        challanId: challanId.trim(),
        fromLocation: joinSite(fromPlace, fromCoordinates),
        toLocation: joinSite(toPlace, toCoordinates),
        fromDate: fetchFrom,
        toDate: fetchTo,
      });
      setDetail(data);
      await loadList();
      if (fetchFrom || fetchTo) {
        setDateFrom(fetchFrom);
        setDateTo(fetchTo);
      }
      const stored = await api.fastagRecords(value);
      setStoredRows(stored.rows || []);
      setPage(1);
      const vehicle = data.vehicles?.[0];
      if (vehicle?.status === "error") toast.error(vehicle.error_message || "Lookup failed");
      else if (vehicle?.status === "empty") toast.info("No toll reads returned");
      else toast.success(`Stored ${data.batch.read_count} toll read${data.batch.read_count === 1 ? "" : "s"}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy("");
    }
  }

  const typedPlate = plate.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const query = filter.trim().toUpperCase();
  const vehicles = detail?.vehicles || [];
  const reads = detail?.reads || [];
  const dateActive = Boolean(dateFrom || dateTo);
  function inDateRange(row) {
    const day = readDay(row);
    const at = entryStamp(row);
    if (dateFrom) {
      if (timeFrom) {
        const from = Date.parse(`${dateFrom}T${clockBound(timeFrom, false)}`);
        if (at === Number.NEGATIVE_INFINITY || at < from) return false;
      } else if (!day || day < dateFrom) return false;
    }
    if (dateTo) {
      if (timeTo) {
        const to = Date.parse(`${dateTo}T${clockBound(timeTo, true)}`);
        if (at === Number.NEGATIVE_INFINITY || at > to) return false;
      } else if (!day || day > dateTo) return false;
    }
    return true;
  }
  const platesInRange = useMemo(() => {
    if (!dateActive) return null;
    return new Set(reads.filter(inDateRange).map((row) => row.vehicle_reg_no));
  }, [reads, dateFrom, timeFrom, dateTo, timeTo, dateActive]);
  const shownVehicles = useMemo(
    () => vehicles.filter((row) => {
      if (typedPlate.length >= 4 && !row.vehicle_reg_no.replace(/[^A-Z0-9]/g, "").includes(typedPlate)) return false;
      if (platesInRange && !platesInRange.has(row.vehicle_reg_no)) return false;
      if (projectFilter && (row.project_name || "") !== projectFilter) return false;
      if (!query) return true;
      return [row.vehicle_reg_no, row.project_name, row.challan_id, row.trip_id, row.from_location, row.to_location, row.error_message]
        .join(" ")
        .toUpperCase()
        .includes(query);
    }),
    [vehicles, typedPlate, platesInRange, projectFilter, query],
  );
  const projectOptions = useMemo(
    () => [...new Set([...vehicles, ...reads, ...(storedRows || [])].map((row) => row.project_name).filter(Boolean))].sort(),
    [vehicles, reads, storedRows],
  );
  const shownReads = useMemo(
    () => (storedRows || reads).filter((row) => {
      if (!inDateRange(row)) return false;
      if (projectFilter && (row.project_name || "") !== projectFilter) return false;
      if (headingFilter && (row.heading_code || "unknown") !== headingFilter) return false;
      if (!query) return true;
      return [row.vehicle_reg_no, row.project_name, row.challan_id, row.trip_id, row.toll_plaza_name, row.toll_plaza_geocode]
        .join(" ")
        .toUpperCase()
        .includes(query);
    }).sort((a, b) => entryStamp(b) - entryStamp(a) || Number(b.id) - Number(a.id)),
    [reads, storedRows, dateFrom, timeFrom, dateTo, timeTo, projectFilter, headingFilter, query],
  );
  const tableReads = shownReads;
  const pageSize = 15;
  const pageCount = Math.max(1, Math.ceil(tableReads.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = tableReads.slice((safePage - 1) * pageSize, safePage * pageSize);
  const mapPoints = useMemo(() => {
    const groups = new Map();
    for (const row of tableReads) {
      const geo = parseGeocode(row.toll_plaza_geocode);
      if (!geo) continue;
      const key = `${geo.lat.toFixed(5)},${geo.lng.toFixed(5)}`;
      const current = groups.get(key) || {
        key,
        lat: geo.lat,
        lng: geo.lng,
        name: row.toll_plaza_name || "Toll plaza",
        count: 0,
        vehicles: new Set(),
        when: row.reader_read_time || "",
        whenStamp: entryStamp(row),
        direction: isAdmin ? (row.lane_direction || "") : "",
        vehicle: row.vehicle_reg_no,
      };
      current.count += 1;
      current.vehicles.add(row.vehicle_reg_no);
      if (row.toll_plaza_name) current.name = row.toll_plaza_name;
      if (entryStamp(row) >= current.whenStamp) {
        current.whenStamp = entryStamp(row);
        current.when = row.reader_read_time || current.when;
        current.direction = isAdmin ? (row.lane_direction || current.direction) : "";
        current.vehicle = row.vehicle_reg_no;
      }
      groups.set(key, current);
    }
    return [...groups.values()].map((group) => ({ ...group, vehicles: [...group.vehicles] }));
  }, [tableReads, isAdmin]);

  function runSearch() {
    setPage(1);
    setPicked(null);
    recordsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function clearFilters() {
    setFilter("");
    setPlate("");
    setDateFrom("");
    setTimeFrom("");
    setDateTo("");
    setTimeTo("");
    setProjectFilter("");
    setHeadingFilter("");
    setStoredRows(null);
    setPicked(null);
    setPage(1);
  }

  function pickLocation(location) {
    setPicked(location);
    mapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function pickRead(row) {
    const geo = parseGeocode(row.toll_plaza_geocode);
    if (!geo) return;
    pickLocation({
      ...geo,
      label: row.toll_plaza_name || row.vehicle_reg_no,
      name: row.toll_plaza_name || "Toll plaza",
      vehicle: row.vehicle_reg_no,
      when: row.reader_read_time || "",
      direction: isAdmin ? (row.lane_direction || "") : "",
    });
  }
  const failedCount = vehicles.filter((row) => row.status === "error").length;
  const finished = vehicles.filter((row) => row.status !== "pending").length;
  const progress = batch?.vehicle_count ? Math.round((finished / batch.vehicle_count) * 100) : 0;

  return (
    <div className="rm-page">
      {loadState === "error" ? <p className="text-danger">The dashboard could not load the latest sheet. Refresh the page and try again.</p> : null}

      <Box title="Quick actions">
        <div className="ft-actions">
          <button type="button" className="btn btn-theme btn-sm" disabled={!batch || running} onClick={fetchBatch}>{running ? "Fetching…" : "Fetch toll data"}</button>
          <button type="button" className="btn btn-default btn-sm" onClick={() => uploadRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Upload vehicle sheet</button>
          <button type="button" className="btn btn-default btn-sm" onClick={() => recordsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>Export toll records</button>
          <Link className="btn btn-default btn-sm" to="/checks">View reconciliation exceptions</Link>
        </div>
      </Box>

      <Box title="Vehicle list">
        <div className="ft-prior">
          <div className="ft-filter-row">
            <label className="ft-field">
              <span>Vehicle number</span>
              <input
                className="form-control"
                value={listVehicle}
                aria-label="Vehicle number"
                onFocus={() => setPriorOpen(true)}
                onChange={(event) => { setListVehicle(event.target.value.toUpperCase()); setPriorOpen(true); }}
              />
            </label>
            <label className="ft-field">
              <span>Challan ID</span>
              <input
                className="form-control"
                value={listChallan}
                aria-label="Challan ID"
                onFocus={() => setPriorOpen(true)}
                onChange={(event) => { setListChallan(event.target.value); setPriorOpen(true); }}
              />
            </label>
            <label className="ft-field" onMouseDown={() => setPriorOpen(true)}>
              <span>Date</span>
              <DateField value={listDate} onChange={(value) => { setListDate(value); setPriorOpen(true); }} placeholder="" />
            </label>
            <label className="ft-field">
              <span>Project</span>
              <input
                className="form-control"
                value={listProject}
                aria-label="Project"
                onFocus={() => setPriorOpen(true)}
                onChange={(event) => { setListProject(event.target.value); setPriorOpen(true); }}
              />
            </label>
          </div>
          {priorOpen ? (
            <ul className="ft-prior-list">
              {priorRows.length ? priorRows.map((row) => (
                <li key={`${row.vehicle_reg_no}|${row.project_name || ""}|${row.challan_id || ""}`}>
                  <button type="button" onClick={() => openStoredVehicle(row)}>
                    <strong>{row.vehicle_reg_no}</strong>
                    <span>{[row.project_name, row.challan_id].filter(Boolean).join(" · ") || "No project"}</span>
                    <span>{row.toll_count} toll{Number(row.toll_count) === 1 ? "" : "s"}{row.last_entry ? ` · last entry ${row.last_entry}` : ""}</span>
                  </button>
                </li>
              )) : <li><button type="button" disabled>No stored vehicles match.</button></li>}
            </ul>
          ) : null}
        </div>
      </Box>

      <div className="ft-grid" ref={searchRef}>
        <Box title="Vehicle">
          <form onSubmit={lookup} className="ft-lookup">
            <input
              className="form-control"
              value={plate}
              onChange={(event) => setPlate(event.target.value.toUpperCase())}
              placeholder="Vehicle number"
              aria-label="Vehicle number"
            />
            <select
              className="form-control"
              value={routeChoice}
              aria-label="Route"
              onChange={(event) => {
                const id = event.target.value;
                setRouteChoice(id);
                const route = routes.find((row) => String(row.id) === id);
                if (!route) return;
                const from = splitSite(route.from_location);
                const to = splitSite(route.to_location);
                setFromPlace(from.place);
                setFromCoordinates(from.coordinates);
                setToPlace(to.place);
                setToCoordinates(to.coordinates);
              }}
            >
              <option value="">Choose a route</option>
              {routes.filter((row) => row.status !== "inactive").map((row) => (
                <option key={row.id} value={row.id}>{row.from_location} → {row.to_location}</option>
              ))}
            </select>
            <div className="ft-lookup-sites">
              <label className="ft-field">
                <span>Project name</span>
                <input
                  className="form-control"
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="Project name"
                  aria-label="Project name"
                  required
                />
              </label>
              <label className="ft-field">
                <span>Challan ID</span>
                <input
                  className="form-control"
                  value={challanId}
                  onChange={(event) => setChallanId(event.target.value)}
                  placeholder="Challan ID"
                  aria-label="Challan ID"
                  required
                />
              </label>
              <label className="ft-field">
                <span>From location</span>
                <input
                  className="form-control"
                  value={fromPlace}
                  onChange={(event) => { setFromPlace(event.target.value); setRouteChoice(""); }}
                  placeholder="Raipur"
                  aria-label="From location"
                />
              </label>
              <label className="ft-field">
                <span>From coordinates</span>
                <input
                  className="form-control"
                  value={fromCoordinates}
                  onChange={(event) => { setFromCoordinates(event.target.value); setRouteChoice(""); }}
                  placeholder="21.2500, 81.6300"
                  aria-label="From coordinates"
                />
              </label>
              <label className="ft-field">
                <span>To location</span>
                <input
                  className="form-control"
                  value={toPlace}
                  onChange={(event) => { setToPlace(event.target.value); setRouteChoice(""); }}
                  placeholder="Korba"
                  aria-label="To location"
                />
              </label>
              <label className="ft-field">
                <span>To coordinates</span>
                <input
                  className="form-control"
                  value={toCoordinates}
                  onChange={(event) => { setToCoordinates(event.target.value); setRouteChoice(""); }}
                  placeholder="22.3500, 82.7500"
                  aria-label="To coordinates"
                />
              </label>
              <label className="ft-field">
                <span>From date</span>
                <DateField value={fetchFrom} onChange={setFetchFrom} placeholder="Entry from" />
              </label>
              <label className="ft-field">
                <span>To date</span>
                <DateField value={fetchTo} onChange={setFetchTo} placeholder="Entry to" />
              </label>
            </div>
            <button className="btn btn-theme" type="submit" disabled={busy === "lookup" || running}>
              {busy === "lookup" ? "Fetching…" : "Fetch from FASTag"}
            </button>
          </form>
        </Box>

        <Box title="Vehicle sheet">
          <form onSubmit={previewSheet} className="ft-form" ref={uploadRef}>
            <input
              className="form-control"
              type="file"
              accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              aria-label="Vehicle sheet"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
            <button className="btn btn-theme" type="submit" disabled={busy === "preview" || busy === "upload"}>
              {busy === "preview" ? "Checking…" : "Check sheet"}
            </button>
          </form>
          {preview ? (
            <>
              <div className="ft-preview">
                <div><strong>{preview.total_rows}</strong><span>Total rows</span></div>
                <div><strong>{preview.valid_rows}</strong><span>Valid</span></div>
                <div><strong>{preview.duplicate_rows}</strong><span>Duplicates</span></div>
                <div><strong>{preview.invalid_rows}</strong><span>Invalid</span></div>
              </div>
              <div className="ft-actions" style={{ marginTop: 10 }}>
                <button type="button" className="btn btn-theme btn-sm" disabled={!preview.valid_rows || busy === "upload"} onClick={confirmImport}>
                  {busy === "upload" ? "Importing…" : `Import ${preview.valid_rows} valid row${preview.valid_rows === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  className="btn btn-default btn-sm"
                  disabled={!(preview.errors?.length || preview.duplicates?.length) || busy === "reject"}
                  onClick={async () => {
                    setBusy("reject");
                    try {
                      const downloaded = await api.fastagRejectedExport({ errors: preview.errors || [], duplicates: preview.duplicates || [] });
                      toast.success(`Downloaded ${downloaded.filename}`);
                    } catch (error) {
                      toast.error(error.message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  Download rejected rows
                </button>
              </div>
            </>
          ) : null}
          {uploadErrors.length ? (
            <div className="ft-note text-danger">
              {uploadErrors.map((message, index) => <div key={`${message}-${index}`}>{message}</div>)}
            </div>
          ) : null}
        </Box>
      </div>

      <div ref={vehiclesRef}>
      <Box
        title={batch ? batch.filename : "Toll responses"}
        tools={batch ? (
          <div className="ft-tools">
            <span className={statusLabel(batch.status).cls}>{statusLabel(batch.status).text}</span>
            <button type="button" className="btn btn-theme btn-sm" onClick={runSearch}>Search</button>
            <button type="button" className="btn btn-theme btn-sm" disabled={running || busy === "lookup"} onClick={fetchBatch}>
              {running ? "Fetching…" : "Fetch toll data"}
            </button>
            {failedCount > 0 ? (
              <button type="button" className="btn btn-default btn-sm" disabled={running || busy === "retry"} onClick={retryFailed}>
                {busy === "retry" ? "Re-running…" : `Re-run failed (${failedCount})`}
              </button>
            ) : null}
          </div>
        ) : null}
      >
        {batch ? (
          <>
            <div className="ft-filter-row">
              <div className="ft-field">
                <span>Search</span>
                <input
                  className="form-control"
                  value={filter}
                  onChange={(event) => { setFilter(event.target.value); setPicked(null); setPage(1); }}
                  onKeyDown={(event) => { if (event.key === "Enter") runSearch(); }}
                  placeholder="Vehicle, plaza, project, trip"
                  aria-label="Search stored records"
                />
              </div>
              <div className="ft-field">
                <span>Sheet</span>
                <select
                  className="form-control"
                  value={batch.id}
                  onChange={(event) => openBatch(event.target.value).catch((error) => toast.error(error.message))}
                >
                  {batches.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.filename} · {row.vehicle_count} vehicles · {row.created_at}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ft-field">
                <span>Project</span>
                <select className="form-control" value={projectFilter} onChange={(event) => { setProjectFilter(event.target.value); setPicked(null); }}>
                  <option value="">All projects</option>
                  {projectOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </div>
              <div className="ft-field ft-field-action">
                <span className="ft-field-spacer">Clear</span>
                <button type="button" className="btn btn-default" onClick={clearFilters}>Clear filters</button>
              </div>
            </div>
            {batch.status === "running" ? (
              <div className="ft-progress" aria-label="Fetch progress">
                <div style={{ width: `${progress}%` }} />
                <span>{finished} of {batch.vehicle_count}</span>
              </div>
            ) : null}
            {batch.error_message ? <p className="text-danger">{batch.error_message}</p> : null}
          </>
        ) : null}

        {batch ? (
          <div className="table-responsive ft-table">
            <table className="table table-striped">
              <thead>
                <tr>
                  <th>Vehicle</th>
                  <th>Project</th>
                  <th>Challan ID</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Fetched</th>
                </tr>
              </thead>
              <tbody>
                {shownVehicles.map((row) => (
                    <tr key={row.id}>
                      <td>{row.vehicle_reg_no}</td>
                      <td>{row.project_name || "—"}</td>
                      <td>{row.challan_id || "—"}</td>
                      <td>{row.from_location || "—"}</td>
                      <td>{row.to_location || "—"}</td>
                      <td>{row.fetched_at || "—"}</td>
                    </tr>
                ))}
                {!shownVehicles.length ? (
                  <tr><td colSpan={6} className="text-muted">No vehicles match this filter.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </Box>
      </div>

      {batch || storedRows ? (
        <Box title="Toll map" tools={<span className="text-muted">{mapPoints.length} plaza{mapPoints.length === 1 ? "" : "s"}</span>}>
          <div ref={mapRef}>
            <TollMap points={mapPoints} picked={picked} onPick={pickLocation} />
          </div>
        </Box>
      ) : null}

      {batch || storedRows ? (
        <div ref={recordsRef}>
        <Box
          title="Toll crossed"
          tools={(
            <div className="ft-tools">
              <span className="text-muted">{tableReads.length} shown</span>
              <button
                type="button"
                className="btn btn-theme btn-sm"
                disabled={!batch || !reads.length || busy === "export" || Boolean(storedRows)}
                onClick={async () => {
                  setBusy("export");
                  try {
                    const params = new URLSearchParams();
                    if (filter.trim()) params.set("q", filter.trim());
                    else if (typedPlate.length >= 4) params.set("q", plate.trim());
                    if (projectFilter) params.set("project", projectFilter);
                    if (dateFrom) params.set("from", dateFrom);
                    if (dateFrom && timeFrom) params.set("fromTime", timeFrom);
                    if (dateTo) params.set("to", dateTo);
                    if (dateTo && timeTo) params.set("toTime", timeTo);
                    if (headingFilter) params.set("heading", headingFilter);
                    const query = params.toString();
                    const exported = await api.fastagExport(batch.id, query);
                    toast.success(query ? `Exported filtered rows in ${exported.filename}` : `Exported all rows in ${exported.filename}`);
                  } catch (error) {
                    toast.error(error.message);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {busy === "export" ? "Exporting…" : (filter.trim() || typedPlate.length >= 4 || projectFilter || dateFrom || timeFrom || dateTo || timeTo || headingFilter) ? "Export filtered" : "Export all"}
              </button>
              <button
                type="button"
                className="btn btn-default btn-sm"
                disabled={!selectedIds.size || busy === "export"}
                onClick={async () => {
                  setBusy("export");
                  try {
                    const exported = await api.fastagSelectedExport([...selectedIds]);
                    toast.success(`Exported ${selectedIds.size} selected records in ${exported.filename}`);
                  } catch (error) {
                    toast.error(error.message);
                  } finally {
                    setBusy("");
                  }
                }}
              >
                {selectedIds.size ? `Export selected (${selectedIds.size})` : "Export selected"}
              </button>
            </div>
          )}
        >
          <div className="ft-filter-row">
            <div className="ft-field">
              <span>Heading Towards</span>
              <select className="form-control" value={headingFilter} aria-label="Heading Towards" onChange={(event) => { setHeadingFilter(event.target.value); setPicked(null); setPage(1); }}>
                <option value="">All</option>
                <option value="loading">Towards Loading Point</option>
                <option value="unloading">Towards Unloading Point</option>
                <option value="unknown">Unknown / Unverified</option>
              </select>
            </div>
            <div className="ft-field">
              <span>From date</span>
              <DateField value={dateFrom} onChange={(value) => { setDateFrom(value); setPicked(null); setPage(1); }} placeholder="Entry from" />
            </div>
            <div className="ft-field">
              <span>From time</span>
              <input className="form-control" type="time" step="1" value={timeFrom} aria-label="From time" onChange={(event) => { setTimeFrom(event.target.value); setPicked(null); setPage(1); }} />
            </div>
            <div className="ft-field">
              <span>To date</span>
              <DateField value={dateTo} onChange={(value) => { setDateTo(value); setPicked(null); setPage(1); }} placeholder="Entry to" />
            </div>
            <div className="ft-field">
              <span>To time</span>
              <input className="form-control" type="time" step="1" value={timeTo} aria-label="To time" onChange={(event) => { setTimeTo(event.target.value); setPicked(null); setPage(1); }} />
            </div>
            <div className="ft-field ft-field-action">
              <span className="ft-field-spacer">Clear</span>
              <button type="button" className="btn btn-default" onClick={() => { setDateFrom(""); setTimeFrom(""); setDateTo(""); setTimeTo(""); setPicked(null); setPage(1); }}>Clear dates</button>
            </div>
          </div>
          <div className="table-responsive">
            <table className="table table-striped">
              <thead>
                <tr>
                  <th className="pick-col">
                    <input
                      type="checkbox"
                      aria-label="Select all toll records"
                      checked={allChecked(selectedIds, tableReads.map((row) => row.id))}
                      onChange={() => setSelectedIds((current) => toggleAll(current, tableReads.map((row) => row.id)))}
                    />
                  </th>
                  <th>Vehicle</th>
                  <th>Project</th>
                  <th>Challan ID</th>
                  <th>Toll entry time</th>
                  {isAdmin ? <th>Direction</th> : null}
                  <th>Heading Towards</th>
                  <th>Toll plaza</th>
                  <th>Geocode</th>
                  <th>Fetched at</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const geo = parseGeocode(row.toll_plaza_geocode);
                  return (
                    <tr key={row.id}>
                      <td className="pick-col">
                        <input
                          type="checkbox"
                          aria-label={`Select ${row.vehicle_reg_no}`}
                          checked={selectedIds.has(row.id)}
                          onChange={() => setSelectedIds((current) => toggleId(current, row.id))}
                        />
                      </td>
                      <td>{row.vehicle_reg_no}</td>
                      <td>{row.project_name || "—"}</td>
                      <td>{row.challan_id || "—"}</td>
                      <td>{row.reader_read_time || "—"}</td>
                      {isAdmin ? <td>{row.lane_direction || "—"}</td> : null}
                      <td>{row.heading_towards || "Unknown / Unverified"}</td>
                      <td>{row.toll_plaza_name || "—"}</td>
                      <td>
                        {geo ? (
                          <span className="ft-geo-cell">
                            <button type="button" className="ft-geo-link" onClick={() => pickRead(row)}>
                              {formatCoord(geo.lat)}, {formatCoord(geo.lng)}
                            </button>
                            <a
                              className="ft-geo-ext"
                              href={mapsHref(geo.lat, geo.lng)}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open ${row.toll_plaza_name || "coordinates"} in Google Maps`}
                            >
                              <i className="fas fa-external-link-alt" aria-hidden="true" />
                            </a>
                          </span>
                        ) : "—"}
                      </td>
                      <td>{row.fetched_at || row.created_at || "—"}</td>
                      <td><button type="button" className="btn btn-default btn-sm" onClick={() => setSelectedRead(row)}>Details</button></td>
                    </tr>
                  );
                })}
                {!pageRows.length ? (
                  <tr><td colSpan={isAdmin ? 11 : 10} className="text-muted">{tableReads.length || reads.length || storedRows ? "No toll reads match these filters." : "No stored toll reads."}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="ft-pager">
            <span className="text-muted">Page {safePage} of {pageCount}</span>
            <div className="ft-actions">
              <button type="button" className="btn btn-default btn-sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
              <button type="button" className="btn btn-default btn-sm" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Next</button>
            </div>
          </div>
        </Box>
        </div>
      ) : null}

      {can("activity") ? (
      <Box title="Activity log" tools={<span className="text-muted">{activity.length} of {activityTotal}</span>}>
        <div className="table-responsive">
          <table className="table table-striped">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Reference</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {activity.map((row) => (
                <tr key={row.id}>
                  <td>{row.at}</td>
                  <td>{row.email || "—"}</td>
                  <td>{row.action}</td>
                  <td>{row.item_id || row.item_type || "—"}</td>
                  <td>{row.note || "—"}</td>
                </tr>
              ))}
              {!activity.length ? (
                <tr><td colSpan={5} className="text-muted">No activity yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {activity.length < activityTotal ? (
          <button type="button" className="btn btn-default btn-sm" style={{ marginTop: 10 }} onClick={() => loadActivity(activity.length).catch((error) => toast.error(error.message))}>
            View older entries
          </button>
        ) : null}
      </Box>
      ) : null}
      {selectedRead ? (
        <Modal title={`${selectedRead.vehicle_reg_no} · ${selectedRead.toll_plaza_name || "Toll record"}`} onClose={() => setSelectedRead(null)}>
          <p><strong>Project</strong> {selectedRead.project_name || "—"}</p>
          <p><strong>Challan ID</strong> {selectedRead.challan_id || "—"}</p>
          <p><strong>Toll entry time</strong> {selectedRead.reader_read_time || "—"}</p>
          {isAdmin ? <p><strong>Direction</strong> {selectedRead.lane_direction || "—"}</p> : null}
          <p><strong>Heading Towards</strong> {selectedRead.heading_towards || "Unknown / Unverified"}</p>
          <p><strong>Type</strong> {selectedRead.vehicle_type || "—"}</p>
          <p><strong>Coordinates</strong> {selectedRead.toll_plaza_geocode || "No coordinates on this record"}</p>
          <p><strong>Fetched at</strong> {selectedRead.fetched_at || selectedRead.created_at || "—"}</p>
        </Modal>
      ) : null}
    </div>
  );
}
