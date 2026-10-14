import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Box, Kpi } from "../components/ui.jsx";
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

  const summary = report.summary;
  const showOverlaps = !focus || focus === "multi" || focus === "trips";
  const showSkipped = !focus || focus === "skipped";
  const overlapKeys = report.overlaps.flatMap((group) => group.trips.map((trip) => `overlap:${trip.vehicle_id}`));
  const skippedKeys = report.skipped.flatMap((trip) => trip.skipped.map((plaza) => skippedKey(trip, plaza)));

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
        tools={<span className="text-muted">{report.skipped.length} trip{report.skipped.length === 1 ? "" : "s"}</span>}
      >
        <div className="table-responsive ft-table" ref={skippedRef}>
          <table className="table table-striped">
            <thead>
              <tr>
                <th className="pick-col">
                  <input type="checkbox" aria-label="Select all skipped tolls" checked={allChecked(selected, skippedKeys)} onChange={() => setSelected((current) => toggleAll(current, skippedKeys))} />
                </th>
                <th>Vehicle</th>
                <th>Project</th>
                <th>Challan ID</th>
                <th>Trip ID</th>
                <th>From</th>
                <th>To</th>
                <th>Check</th>
                <th>Route</th>
                <th>Recorded</th>
                <th>Skipped plaza</th>
                <th>GPS</th>
              </tr>
            </thead>
            <tbody>
              {report.skipped.flatMap((trip) => trip.skipped.map((plaza) => (
                <tr key={`${trip.vehicle_reg_no}-${trip.trip_id}-${trip.challan_id}-${plaza.seq_order}-${plaza.toll_plaza_name}`}>
                  <td className="pick-col">
                    <input type="checkbox" aria-label={`Select ${plaza.toll_plaza_name}`} checked={selected.has(skippedKey(trip, plaza))} onChange={() => setSelected((current) => toggleId(current, skippedKey(trip, plaza)))} />
                  </td>
                  <td>{trip.vehicle_reg_no}</td>
                  <td>{trip.project_name || "—"}</td>
                  <td>{trip.challan_id || "—"}</td>
                  <td>{trip.trip_id || "—"}</td>
                  <td>{trip.from_location || "—"}</td>
                  <td>{trip.to_location || "—"}</td>
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
                </tr>
              )))}
              {!report.skipped.length ? (
                <tr><td colSpan={12} className="text-muted">{busy ? "Checking routes…" : "No toll exception for these trips."}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Box>
      ) : null}
    </div>
  );
}
