import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Box, DateField, Kpi } from "../components/ui.jsx";
import { allChecked, toggleAll, toggleId } from "../lib/rowSelect.js";

function skippedKey(trip, plaza) {
  return `skipped:${trip.vehicle_reg_no}|${trip.challan_id || ""}|${trip.trip_id || ""}|${plaza.seq_order}|${plaza.toll_plaza_name || ""}`;
}

const EMPTY = {
  overlaps: [],
  skipped: [],
  summary: {
    multi_project_vehicles: 0,
    overlap_trips: 0,
    skipped_trips: 0,
    skipped_plazas: 0,
    gps_confirmed: 0,
  },
};

export default function TripChecks() {
  const toast = useToast();
  const [vehicle, setVehicle] = useState("");
  const [report, setReport] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [focus, setFocus] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const overlapsRef = useRef(null);
  const skippedRef = useRef(null);

  async function load(plate = vehicle) {
    setBusy(true);
    try {
      const data = await api.fastagAudit(plate.trim());
      setReport({
        overlaps: data.overlaps || [],
        skipped: data.skipped || [],
        summary: data.summary || EMPTY.summary,
      });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load("");
  }, []);

  function tripDay(value) {
    const match = String(value || "").match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : "";
  }
  const skippedRows = report.skipped.filter((trip) => {
    if (!dateFrom && !dateTo) return true;
    const start = tripDay(trip.first_entry);
    const end = tripDay(trip.last_entry) || start;
    if (!start) return false;
    if (dateFrom && end < dateFrom) return false;
    if (dateTo && start > dateTo) return false;
    return true;
  });
  const summary = report.summary;
  const showOverlaps = !focus || focus === "multi" || focus === "trips";
  const showSkipped = !focus || focus === "skipped";
  const overlapKeys = report.overlaps.flatMap((group) => group.trips.map((trip) => `overlap:${trip.vehicle_id}`));
  const skippedList = skippedRows.flatMap((trip) => trip.skipped.map((plaza) => ({ trip, plaza })));
  const skippedKeys = skippedList.map(({ trip, plaza }) => skippedKey(trip, plaza));
  const pageCount = Math.max(1, Math.ceil(skippedList.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pageRows = skippedList.slice(pageStart, pageStart + pageSize);

  async function exportSkipped() {
    if (!skippedKeys.length) return;
    setExporting(true);
    try {
      const exported = await api.fastagAuditExport(vehicle.trim(), "skipped", skippedKeys);
      toast.success(`Exported ${skippedKeys.length} skipped toll${skippedKeys.length === 1 ? "" : "s"} in ${exported.filename}`);
    } catch (error) {
      toast.error(error.message);
    } finally {
      setExporting(false);
    }
  }

  async function closeIssues(keys) {
    if (!keys.length) return;
    setBusy(true);
    try {
      await api.fastagAuditClose(keys);
      toast.success(keys.length === 1 ? "Issue closed" : `Closed ${keys.length} issues`);
      setSelected((current) => {
        const next = new Set(current);
        keys.forEach((key) => next.delete(key));
        return next;
      });
      await load(vehicle);
    } catch (error) {
      toast.error(error.message);
      setBusy(false);
    }
  }

  function pickFocus(next) {
    setFocus((current) => (current === next ? "" : next));
  }

  useEffect(() => {
    const ref = focus === "skipped" ? skippedRef : focus ? overlapsRef : null;
    ref?.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [focus]);

  return (
    <div className="rm-page">
      <div className="rm-kpi-row">
        <Kpi label="Trips to confirm" hint="Overlapping trips" value={summary.overlap_trips} icon="fa-code-branch" tone="rose" active={focus === "trips"} onClick={() => pickFocus("trips")} />
        <Kpi label="Multi-project vehicles" hint="More than one project" value={summary.multi_project_vehicles} icon="fa-truck" tone="orange" active={focus === "multi"} onClick={() => pickFocus("multi")} />
        <Kpi label="Trips with skipped tolls" hint="Missed tolls" value={summary.skipped_trips} icon="fa-flag" tone="orange" active={focus === "skipped"} onClick={() => pickFocus("skipped")} />
      </div>

      <Box title="Vehicle">
        <form
          className="ft-form"
          onSubmit={(event) => {
            event.preventDefault();
            load(vehicle);
          }}
        >
          <input
            className="form-control"
            value={vehicle}
            onChange={(event) => setVehicle(event.target.value.toUpperCase())}
            placeholder="Vehicle number, or leave blank for every vehicle"
            aria-label="Vehicle number"
          />
          <button className="btn btn-theme" type="submit" disabled={busy}>
            {busy ? "Checking…" : "Run checks"}
          </button>
          <button
            className="btn btn-default"
            type="button"
            disabled={busy || exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const exported = await api.fastagAuditExport(vehicle.trim(), focus);
                toast.success(`Exported ${exported.filename}`);
              } catch (error) {
                toast.error(error.message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? "Exporting…" : "Export"}
          </button>
          <button
            className="btn btn-default"
            type="button"
            disabled={busy || exporting || !selected.size}
            onClick={async () => {
              setExporting(true);
              try {
                const exported = await api.fastagAuditExport(vehicle.trim(), focus, [...selected]);
                toast.success(`Exported ${selected.size} selected rows in ${exported.filename}`);
              } catch (error) {
                toast.error(error.message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {selected.size ? `Export selected (${selected.size})` : "Export selected"}
          </button>
        </form>
      </Box>

      {showOverlaps ? (
      <Box
        title="Same vehicle in multiple projects"
        tools={<span className="text-muted">{report.overlaps.length} vehicle{report.overlaps.length === 1 ? "" : "s"}</span>}
      >
        <div className="table-responsive ft-table" ref={overlapsRef}>
          <table className="table table-striped">
            <thead>
              <tr>
                <th className="pick-col">
                  <input type="checkbox" aria-label="Select all overlapping trips" checked={allChecked(selected, overlapKeys)} onChange={() => setSelected((current) => toggleAll(current, overlapKeys))} />
                </th>
                <th>Vehicle</th>
                <th>Project</th>
                <th>Challan ID</th>
                <th>Trip ID</th>
                <th>From</th>
                <th>To</th>
                <th>Toll window</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {report.overlaps.flatMap((group) => group.trips.map((trip) => (
                <tr key={`${group.vehicle_reg_no}-${trip.vehicle_id}`}>
                  <td className="pick-col">
                    <input type="checkbox" aria-label={`Select ${group.vehicle_reg_no}`} checked={selected.has(`overlap:${trip.vehicle_id}`)} onChange={() => setSelected((current) => toggleId(current, `overlap:${trip.vehicle_id}`))} />
                  </td>
                  <td>{group.vehicle_reg_no}</td>
                  <td>{trip.project_name || "—"}</td>
                  <td>{trip.challan_id || "—"}</td>
                  <td>{trip.trip_id || "—"}</td>
                  <td>{trip.from_location || "—"}</td>
                  <td>{trip.to_location || "—"}</td>
                  <td>{trip.first_entry ? `${trip.first_entry} to ${trip.last_entry}` : "—"}</td>
                  <td>
                    {trip.flags.map((flag) => (
                      <div key={flag}><span className="label label-warning">{flag}</span></div>
                    ))}
                  </td>
                </tr>
              )))}
              {!report.overlaps.length ? (
                <tr><td colSpan={9} className="text-muted">{busy ? "Checking trips…" : "No vehicle is active in more than one project."}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Box>
      ) : null}

      {showSkipped ? (
      <Box
        title="Skipped tolls on the route"
        tools={<span className="text-muted">{skippedRows.length} trip{skippedRows.length === 1 ? "" : "s"}</span>}
      >
        <div className="ft-filter-row">
          <div className="ft-field">
            <span>From date</span>
            <DateField value={dateFrom} onChange={(value) => { setDateFrom(value); setPage(1); }} placeholder="" />
          </div>
          <div className="ft-field">
            <span>To date</span>
            <DateField value={dateTo} onChange={(value) => { setDateTo(value); setPage(1); }} placeholder="" />
          </div>
          <div className="ft-field ft-field-action">
            <span className="ft-field-spacer">Clear</span>
            <button type="button" className="btn btn-default" onClick={() => { setDateFrom(""); setDateTo(""); setPage(1); }}>Clear dates</button>
          </div>
          <div className="ft-field ft-field-action">
            <span className="ft-field-spacer">Export</span>
            <button type="button" className="btn btn-default" disabled={busy || exporting || !skippedKeys.length} onClick={exportSkipped}>
              {exporting ? "Exporting…" : "Export"}
            </button>
          </div>
          <div className="ft-field ft-field-action">
            <span className="ft-field-spacer">Close</span>
            <button
              type="button"
              className="btn btn-theme"
              disabled={busy || !skippedKeys.some((key) => selected.has(key))}
              onClick={() => closeIssues(skippedKeys.filter((key) => selected.has(key)))}
            >
              Close selected
            </button>
          </div>
        </div>
        <div className="table-responsive ft-table" ref={skippedRef}>
          <table className="table table-striped">
            <thead>
              <tr>
                <th className="pick-col">
                  <input type="checkbox" aria-label="Select all skipped tolls" checked={allChecked(selected, skippedKeys)} onChange={() => setSelected((current) => toggleAll(current, skippedKeys))} />
                </th>
                <th>S.No</th>
                <th>Vehicle</th>
                <th>Project</th>
                <th>Challan ID</th>
                <th>Trip ID</th>
                <th>From</th>
                <th>To</th>
                <th>Date</th>
                <th>Check</th>
                <th>Route</th>
                <th>Recorded</th>
                <th>Skipped plaza</th>
                <th>GPS</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ trip, plaza }, index) => (
                <tr key={`${trip.vehicle_reg_no}-${trip.trip_id}-${trip.challan_id}-${plaza.seq_order}-${plaza.toll_plaza_name}`}>
                  <td className="pick-col">
                    <input type="checkbox" aria-label={`Select ${plaza.toll_plaza_name}`} checked={selected.has(skippedKey(trip, plaza))} onChange={() => setSelected((current) => toggleId(current, skippedKey(trip, plaza)))} />
                  </td>
                  <td>{pageStart + index + 1}</td>
                  <td>{trip.vehicle_reg_no}</td>
                  <td>{trip.project_name || "—"}</td>
                  <td>{trip.challan_id || "—"}</td>
                  <td>{trip.trip_id || "—"}</td>
                  <td>{trip.from_location || "—"}</td>
                  <td>{trip.to_location || "—"}</td>
                  <td>{trip.first_entry ? (trip.last_entry && trip.last_entry !== trip.first_entry ? `${trip.first_entry} to ${trip.last_entry}` : trip.first_entry) : "—"}</td>
                  <td>{trip.basis === "excel" ? "Excel sites" : "Route master"}</td>
                  <td>
                    <div>{trip.route_name}</div>
                    <div className="text-muted">{trip.route_label}</div>
                  </td>
                  <td>{trip.basis === "excel" ? `${trip.skipped.length} exception${trip.skipped.length === 1 ? "" : "s"}` : `${trip.recorded_count} of ${trip.expected_count}`}</td>
                  <td>{plaza.seq_order ? `#${plaza.seq_order} ` : ""}{plaza.toll_plaza_name}</td>
                  <td>
                    <span className={plaza.gps_passed ? "label label-danger" : "label label-warning"}>{plaza.gps_note}</span>
                  </td>
                  <td>
                    <button type="button" className="btn btn-default btn-sm" disabled={busy} onClick={() => closeIssues([skippedKey(trip, plaza)])}>Close issue</button>
                  </td>
                </tr>
              ))}
              {!pageRows.length ? (
                <tr><td colSpan={15} className="text-muted">{busy ? "Checking routes…" : dateFrom || dateTo ? "No skipped tolls in this date range." : "No toll exception for these trips."}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="ft-pager">
          <span className="text-muted">Page {safePage} of {pageCount}</span>
          <div className="ft-actions">
            <label className="ft-field" style={{ margin: 0 }}>
              <span>Rows</span>
              <select
                className="form-control"
                aria-label="Rows per page"
                value={pageSize}
                onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
              >
                {[20, 50, 100, 200, 500, 1000, 2000].map((size) => (
                  <option key={size} value={size}>{size} / page</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-default btn-sm" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
            <button type="button" className="btn btn-default btn-sm" disabled={safePage >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>Next</button>
          </div>
        </div>
      </Box>
      ) : null}
    </div>
  );
}
