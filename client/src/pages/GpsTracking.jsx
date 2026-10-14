import { useEffect, useState, useMemo, useRef } from "react";
import { api } from "../api.js";
import { useToast } from "../components/Toast.jsx";
import { Box, Kpi } from "../components/ui.jsx";
import { allChecked, toggleAll, toggleId } from "../lib/rowSelect.js";

const SAMPLE_PAYLOAD = `{
  "vid": 81509,
  "vno": "CG04NU2465",
  "lat": 24.201772,
  "lon": 82.670205,
  "spd": 0,
  "crs": 4,
  "ign": 0,
  "fuel": "disconnected",
  "time": "2026-09-16 02:12:43"
}`;

const TILE_SIZE = 256;
const MIN_ZOOM = 4;
const MAX_ZOOM = 17;

function project(lat, lng, zoom) {
  const n = 2 ** zoom;
  const x = ((lng + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y };
}

function unproject(x, y, zoom) {
  const n = 2 ** zoom;
  const lng = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lat: (latRad * 180) / Math.PI, lng };
}

function headingDirection(crs) {
  if (crs == null || isNaN(crs)) return "—";
  const deg = ((Number(crs) % 360) + 360) % 360;
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const idx = Math.round(deg / 22.5) % 16;
  return `${deg}° ${dirs[idx]}`;
}

function mapsHref(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${lat},${lon}`)}`;
}

/** Interactive Tile Map with Animated Moving Vehicle */
function LiveMovingMap({
  lat,
  lon,
  heading = 0,
  speed = 0,
  ignition = false,
  vehicleNo = "Vehicle",
  time = "",
  historyPings = [],
  isSimulatingMotion = false,
  onToggleMotionSimulation,
}) {
  const containerRef = useRef(null);
  const dragRef = useRef(null);

  const [dimensions, setDimensions] = useState({ width: 800, height: 460 });
  const [zoom, setZoom] = useState(13);
  const [center, setCenter] = useState(() => ({
    lat: Number(lat) || 24.201772,
    lng: Number(lon) || 82.670205,
  }));

  // Animated vehicle position offset during simulation
  const [simOffset, setSimOffset] = useState({ latOffset: 0, lngOffset: 0, distanceMovedKm: 0 });

  // Update center when vehicle coordinates change
  useEffect(() => {
    if (lat != null && lon != null && !isNaN(Number(lat)) && !isNaN(Number(lon))) {
      setCenter({ lat: Number(lat), lng: Number(lon) });
      setSimOffset({ latOffset: 0, lngOffset: 0, distanceMovedKm: 0 });
    }
  }, [lat, lon]);

  // Measure container dimensions
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      if (el.clientWidth > 50 && el.clientHeight > 50) {
        setDimensions({ width: el.clientWidth, height: el.clientHeight });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Motion simulation loop: visibly moves vehicle forward along its heading
  useEffect(() => {
    if (!isSimulatingMotion) return;
    const interval = setInterval(() => {
      setSimOffset((prev) => {
        const rad = ((Number(heading) || 0) * Math.PI) / 180;
        // Move ~0.00015 deg per tick (approx ~35-45 km/h visual scale)
        const step = 0.00012;
        const dLat = Math.cos(rad) * step;
        const dLng = Math.sin(rad) * step;
        return {
          latOffset: prev.latOffset + dLat,
          lngOffset: prev.lngOffset + dLng,
          distanceMovedKm: prev.distanceMovedKm + 0.015,
        };
      });
    }, 150);
    return () => clearInterval(interval);
  }, [isSimulatingMotion, heading]);

  const activeLat = (Number(lat) || 24.201772) + simOffset.latOffset;
  const activeLng = (Number(lon) || 82.670205) + simOffset.lngOffset;
  const displaySpeed = isSimulatingMotion
    ? Math.max(38, Number(speed) || 42)
    : Number(speed) || 0;
  const isMoving = isSimulatingMotion || displaySpeed > 0;

  // Compute map tiles and screen positions
  const { tiles, vehicleScreen, historyScreenPoints } = useMemo(() => {
    const { width, height } = dimensions;
    const centerProj = project(center.lat, center.lng, zoom);
    const originX = centerProj.x * TILE_SIZE - width / 2;
    const originY = centerProj.y * TILE_SIZE - height / 2;
    const scale = 2 ** zoom;

    const x0 = Math.floor(originX / TILE_SIZE);
    const y0 = Math.floor(originY / TILE_SIZE);
    const x1 = Math.floor((originX + width) / TILE_SIZE);
    const y1 = Math.floor((originY + height) / TILE_SIZE);

    const tileList = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= scale) continue;
        const wrappedX = ((x % scale) + scale) % scale;
        tileList.push({
          key: `${zoom}/${x}/${y}`,
          url: `https://tile.openstreetmap.org/${zoom}/${wrappedX}/${y}.png`,
          left: x * TILE_SIZE - originX,
          top: y * TILE_SIZE - originY,
        });
      }
    }

    const vehProj = project(activeLat, activeLng, zoom);
    const vScreen = {
      x: vehProj.x * TILE_SIZE - originX,
      y: vehProj.y * TILE_SIZE - originY,
    };

    const hPoints = (historyPings || [])
      .filter((p) => p.lat != null && p.lon != null)
      .slice(0, 40)
      .map((p, idx) => {
        const hp = project(Number(p.lat), Number(p.lon), zoom);
        return {
          id: p.id || idx,
          x: hp.x * TILE_SIZE - originX,
          y: hp.y * TILE_SIZE - originY,
          time: p.gps_time,
          speed: p.spd,
        };
      });

    return { tiles: tileList, vehicleScreen: vScreen, historyScreenPoints: hPoints };
  }, [center, zoom, dimensions, activeLat, activeLng, historyPings]);

  // Mouse pan handlers
  function handlePointerDown(e) {
    if (e.target.closest("button, a")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      centerStart: { ...center },
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const startP = project(dragRef.current.centerStart.lat, dragRef.current.centerStart.lng, zoom);
    const nextGeo = unproject(startP.x - dx / TILE_SIZE, startP.y - dy / TILE_SIZE, zoom);
    setCenter(nextGeo);
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function zoomBy(delta) {
    setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z + delta)));
  }

  function recenter() {
    setCenter({ lat: activeLat, lng: activeLng });
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        height: 460,
        width: "100%",
        borderRadius: 12,
        overflow: "hidden",
        border: "1px solid #CBD5E1",
        backgroundColor: "#E2E8F0",
        userSelect: "none",
        cursor: "grab",
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={(e) => {
        e.preventDefault();
        zoomBy(e.deltaY > 0 ? -1 : 1);
      }}
    >
      <style>{`
        @keyframes gpsRadarWave {
          0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0.9; }
          100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; }
        }
        @keyframes vehicleMovingGlow {
          0%, 100% { filter: drop-shadow(0 0 6px rgba(16, 185, 129, 0.8)); }
          50% { filter: drop-shadow(0 0 16px rgba(16, 185, 129, 1)); }
        }
        @keyframes truckTireRumble {
          0%, 100% { transform: translate(-50%, -50%) translateY(0); }
          50% { transform: translate(-50%, -50%) translateY(-2px); }
        }
      `}</style>

      {/* Render OpenStreetMap Tiles directly as images */}
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          draggable={false}
          style={{
            position: "absolute",
            left: t.left,
            top: t.top,
            width: TILE_SIZE,
            height: TILE_SIZE,
            pointerEvents: "none",
          }}
        />
      ))}

      {/* Historical Breadcrumb Line / Trail */}
      <svg
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      >
        {historyScreenPoints.length > 1 && (
          <polyline
            points={historyScreenPoints.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="none"
            stroke="#2563EB"
            strokeWidth="3.5"
            strokeDasharray="6,4"
            opacity="0.75"
          />
        )}
        {historyScreenPoints.map((p, i) => (
          <circle
            key={p.id}
            cx={p.x}
            cy={p.y}
            r={i === 0 ? 5 : 3.5}
            fill={i === 0 ? "#10B981" : "#3B82F6"}
            stroke="#fff"
            strokeWidth="1.5"
            opacity="0.85"
          />
        ))}
      </svg>

      {/* Animated Moving Vehicle Marker */}
      <div
        style={{
          position: "absolute",
          left: vehicleScreen.x,
          top: vehicleScreen.y,
          pointerEvents: "none",
          zIndex: 20,
        }}
      >
        {/* Radar wave ripples when active/moving */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 48,
            height: 48,
            borderRadius: "50%",
            background: isMoving
              ? "radial-gradient(circle, rgba(16, 185, 129, 0.4) 0%, rgba(16, 185, 129, 0) 70%)"
              : "radial-gradient(circle, rgba(37, 99, 235, 0.3) 0%, rgba(37, 99, 235, 0) 70%)",
            animation: "gpsRadarWave 2s infinite ease-out",
          }}
        />

        {/* Vehicle Body Marker */}
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            transform: "translate(-50%, -50%)",
            animation: isMoving ? "truckTireRumble 0.4s infinite ease-in-out" : "none",
          }}
        >
          {/* Circular Badge with Refex Moving Truck Icon */}
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              backgroundColor: isMoving ? "#059669" : ignition ? "#2563EB" : "#475569",
              border: "3px solid #FFFFFF",
              boxShadow: "0 6px 18px rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#FFFFFF",
              position: "relative",
              animation: isMoving ? "vehicleMovingGlow 1.5s infinite" : "none",
            }}
          >
            <i
              className={`fas ${isMoving ? "fa-truck-moving" : "fa-truck"}`}
              style={{ fontSize: 18 }}
            />

            {/* Heading direction pointer needle */}
            <div
              style={{
                position: "absolute",
                top: -8,
                left: "50%",
                width: 0,
                height: 0,
                borderLeft: "5px solid transparent",
                borderRight: "5px solid transparent",
                borderBottom: `9px solid ${isMoving ? "#059669" : "#2563EB"}`,
                transform: `translateX(-50%) rotate(${Number(heading) || 0}deg)`,
                transformOrigin: "center 22px",
              }}
            />
          </div>

          {/* Floating Speed / Vehicle Plate Pill */}
          <div
            style={{
              position: "absolute",
              top: -34,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#0F172A",
              color: "#FFFFFF",
              borderRadius: 6,
              padding: "2px 8px",
              fontSize: 11,
              fontWeight: 800,
              whiteSpace: "nowrap",
              boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span>{vehicleNo}</span>
            <span style={{ color: isMoving ? "#34D399" : "#94A3B8" }}>
              {displaySpeed} km/h
            </span>
          </div>
        </div>
      </div>

      {/* Top Left Status Overlay */}
      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          background: "rgba(255, 255, 255, 0.95)",
          backdropFilter: "blur(6px)",
          boxShadow: "0 4px 14px rgba(0,0,0,0.12)",
          borderRadius: 8,
          padding: "8px 14px",
          fontSize: 12,
          zIndex: 30,
          display: "flex",
          alignItems: "center",
          gap: 10,
          border: "1px solid #E2E8F0",
        }}
      >
        <span style={{ fontWeight: 800, color: "#0F172A" }}>{vehicleNo}</span>
        <span
          style={{
            background: isMoving ? "#DCFCE7" : ignition ? "#E0F2FE" : "#F1F5F9",
            color: isMoving ? "#166534" : ignition ? "#0369A1" : "#475569",
            fontWeight: 700,
            padding: "2px 8px",
            borderRadius: 6,
            fontSize: 11,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <i className="fas fa-circle" style={{ fontSize: 7, color: isMoving ? "#10B981" : "#64748B" }} />
          {isMoving ? "MOVING IN TRANSIT" : ignition ? "IGNITION ON (IDLE)" : "IGNITION OFF"}
        </span>
        <span style={{ color: "#2563EB", fontWeight: 700 }}>
          {displaySpeed} km/h
        </span>
        <span style={{ color: "#64748B", fontSize: 11 }}>
          <i className="fas fa-compass" style={{ marginRight: 4 }} />
          {headingDirection(heading)}
        </span>
      </div>

      {/* Top Right Motion Simulator Toggle & Recenter */}
      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          zIndex: 30,
          display: "flex",
          gap: 6,
        }}
      >
        <button
          type="button"
          onClick={onToggleMotionSimulation}
          className={`btn btn-xs ${isSimulatingMotion ? "btn-success" : "btn-default"}`}
          style={{
            fontWeight: 700,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
          title="Simulate live vehicle motion along route"
        >
          <i className={`fas fa-truck-moving ${isSimulatingMotion ? "fa-bounce" : ""}`} />
          <span>{isSimulatingMotion ? "Moving: Active" : "Simulate Motion"}</span>
        </button>

        <button
          type="button"
          onClick={recenter}
          className="btn btn-xs btn-default"
          style={{
            fontWeight: 700,
            padding: "6px 10px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
          }}
          title="Center on Vehicle"
        >
          <i className="fas fa-crosshairs" />
        </button>
      </div>

      {/* Bottom Right Map Navigation Tools */}
      <div
        style={{
          position: "absolute",
          bottom: 12,
          right: 12,
          zIndex: 30,
          display: "flex",
          gap: 6,
          background: "rgba(255, 255, 255, 0.95)",
          padding: 4,
          borderRadius: 8,
          boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
        }}
      >
        <button
          type="button"
          onClick={() => zoomBy(1)}
          className="btn btn-xs btn-default"
          title="Zoom In"
          style={{ fontWeight: 800, padding: "4px 10px" }}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => zoomBy(-1)}
          className="btn btn-xs btn-default"
          title="Zoom Out"
          style={{ fontWeight: 800, padding: "4px 10px" }}
        >
          −
        </button>
        <a
          href={mapsHref(activeLat, activeLng)}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-xs btn-primary"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, padding: "4px 10px" }}
        >
          <i className="fas fa-external-link-alt" />
          <span>Google Maps</span>
        </a>
      </div>

      {/* Bottom Left OpenStreetMap Attribution */}
      <div
        style={{
          position: "absolute",
          bottom: 6,
          left: 10,
          fontSize: 10,
          color: "rgba(15, 23, 42, 0.6)",
          zIndex: 10,
          pointerEvents: "none",
        }}
      >
        © OpenStreetMap contributors · Live Refex GPS
      </div>
    </div>
  );
}

export default function GpsTracking() {
  const toast = useToast();

  // Primary input: Vehicle Number
  const [vehicleNo, setVehicleNo] = useState("CG04NU2465");
  const [activeVehicle, setActiveVehicle] = useState("CG04NU2465");
  const [activeTab, setActiveTab] = useState("live"); // 'live' | 'history'

  // Data states
  const [liveData, setLiveData] = useState(null);
  const [historyRows, setHistoryRows] = useState([]);
  const [selectedGps, setSelectedGps] = useState(() => new Set());
  const [exportingGps, setExportingGps] = useState(false);
  const [knownVehicles, setKnownVehicles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [savingRecord, setSavingRecord] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [isSimulatingMotion, setIsSimulatingMotion] = useState(false);
  const [vehicleFilterStatus, setVehicleFilterStatus] = useState("all");

  // History filters
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [historyLimit, setHistoryLimit] = useState(200);

  // Ingest / Simulate Modal
  const [showIngestModal, setShowIngestModal] = useState(false);
  const [ingestPayload, setIngestPayload] = useState(SAMPLE_PAYLOAD);
  const [ingesting, setIngesting] = useState(false);

  // Picked ping for historical map view
  const [pickedPing, setPickedPing] = useState(null);

  // Safe notify helper
  const notify = {
    success: (msg) => (toast?.success ? toast.success(msg) : alert(msg)),
    error: (msg) => (toast?.error ? toast.error(msg) : alert(msg)),
    info: (msg) => (toast?.info ? toast.info(msg) : console.log(msg)),
  };

  // Load distinct vehicles list
  async function loadKnownVehicles() {
    try {
      const res = await api.gpsVehicles();
      if (res?.vehicles) {
        setKnownVehicles(res.vehicles);
      }
    } catch {
      // silent
    }
  }

  // Explicit Save to Database Button
  async function handleManualSaveToDb() {
    setSavingRecord(true);
    try {
      const res = await api.gpsSave(activeVehicle);
      notify.success(`✓ Saved ${activeVehicle} location to database! (Total records: ${historyRows.length + 1})`);
      await reloadHistory(activeVehicle);
      await loadKnownVehicles();
    } catch (err) {
      notify.error("Failed to save: " + (err.message || "Server error"));
    } finally {
      setSavingRecord(false);
    }
  }

  // Reload history without altering live view
  async function reloadHistory(vno) {
    try {
      const histRes = await api.gpsHistory(vno, dateFrom, dateTo, historyLimit);
      setHistoryRows(histRes?.rows || []);
    } catch {
      // silent
    }
  }

  // Sync Live fleet from ktt.io API
  async function handleSyncFleet() {
    setSyncing(true);
    try {
      const res = await api.gpsSync();
      notify.success(`Synced ${res.total_vehicles || 0} fleet vehicles into database!`);
      await loadKnownVehicles();
      if (activeVehicle) {
        await fetchGpsData(activeVehicle, false);
      }
    } catch (err) {
      notify.error("GPS Sync failed: " + (err.message || "Server error"));
    } finally {
      setSyncing(false);
    }
  }

  // Main search & fetch: always saves the searched ping into database
  async function fetchGpsData(vnoToFetch, isUserSearch = false) {
    const vno = (vnoToFetch || vehicleNo || "").trim().toUpperCase();
    if (!vno) {
      notify.info("Please enter a vehicle number");
      return;
    }
    setLoading(true);
    try {
      // 1. Live Data (save=1 tells backend to store this search)
      const liveRes = await api.gpsLive(vno, true);
      if (liveRes?.found && liveRes.data) {
        setLiveData(liveRes.data);
        setPickedPing(liveRes.data);
        if (isUserSearch) {
          notify.success(`✓ Saved & tracking ${vno}! Live position recorded to database.`);
        }
      } else {
        setLiveData(null);
        setPickedPing(null);
        if (isUserSearch) {
          notify.info(`Vehicle ${vno} not currently active in live fleet.`);
        }
      }

      // 2. Old / History Data
      const histRes = await api.gpsHistory(vno, dateFrom, dateTo, historyLimit);
      const rows = histRes?.rows || [];
      setHistoryRows(rows);
      if (!liveRes?.data && rows.length > 0) {
        setPickedPing(rows[0]);
      }

      setActiveVehicle(vno);
      loadKnownVehicles();
    } catch (err) {
      notify.error(err.message || "Failed to fetch GPS data");
    } finally {
      setLoading(false);
    }
  }

  // Initial load
  useEffect(() => {
    fetchGpsData("CG04NU2465", false);
    loadKnownVehicles();
  }, []);

  // Auto-refresh interval (every 15 seconds)
  useEffect(() => {
    if (!autoRefresh || !activeVehicle) return;
    const interval = setInterval(() => {
      api.gpsLive(activeVehicle, true)
        .then((res) => {
          if (res?.found && res.data) {
            setLiveData(res.data);
            reloadHistory(activeVehicle);
          }
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [autoRefresh, activeVehicle]);

  // Handle Search submit
  function handleSearch(e) {
    e.preventDefault();
    fetchGpsData(vehicleNo, true);
  }

  // Ingest / Store live response
  async function handleStorePayload() {
    setIngesting(true);
    try {
      const parsed = JSON.parse(ingestPayload);
      const res = await api.gpsPing(parsed);
      notify.success(`✓ Stored ${res.stored_count || 1} GPS ping(s) into database!`);
      setShowIngestModal(false);

      const targetVno = (Array.isArray(parsed) ? parsed[0]?.vno : parsed.vno) || vehicleNo;
      if (targetVno) {
        setVehicleNo(targetVno);
        fetchGpsData(targetVno, false);
      }
    } catch (err) {
      notify.error("Invalid JSON or server error: " + err.message);
    } finally {
      setIngesting(false);
    }
  }

  // Filtered vehicle pills
  const filteredVehicles = useMemo(() => {
    if (vehicleFilterStatus === "moving") return knownVehicles.filter((v) => Number(v.last_spd) > 0);
    if (vehicleFilterStatus === "stopped") return knownVehicles.filter((v) => Number(v.last_spd) === 0);
    return knownVehicles;
  }, [knownVehicles, vehicleFilterStatus]);

  const currentMapData = useMemo(() => {
    if (activeTab === "live") {
      return liveData;
    }
    return pickedPing || liveData || historyRows[0] || null;
  }, [activeTab, liveData, pickedPing, historyRows]);

  return (
    <div className="gps-tracking-page">
      {/* Datalist for autocomplete on vehicle number */}
      <datalist id="gps-vehicle-list">
        {knownVehicles.map((v) => (
          <option key={v.vno} value={v.vno}>
            {v.vno} — {Number(v.last_spd) > 0 ? `${Number(v.last_spd).toFixed(0)} km/h` : "Stopped"} | Ign: {v.last_ign ? "ON" : "OFF"}
          </option>
        ))}
      </datalist>

      {/* Search Header Bar */}
      <div className="box box-default" style={{ marginBottom: 16 }}>
        <div className="box-body" style={{ padding: "16px 20px" }}>
          <form onSubmit={handleSearch} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <div style={{ flex: "1 1 280px", maxWidth: 420 }}>
              <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, display: "block" }}>
                Vehicle Number
              </label>
              <div style={{ position: "relative" }}>
                <input
                  type="text"
                  list="gps-vehicle-list"
                  className="form-control"
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: "0.05em",
                    textTransform: "uppercase",
                    paddingLeft: 38,
                    height: 42,
                    borderColor: "var(--main-theme-color)",
                  }}
                  placeholder="e.g. CG04NU2465, CG10BM7229..."
                  value={vehicleNo}
                  onChange={(e) => setVehicleNo(e.target.value.toUpperCase())}
                />
                <i className="fas fa-truck" style={{ position: "absolute", left: 14, top: 13, color: "var(--main-theme-color)" }} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 18 }}>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
                style={{ height: 42, padding: "0 22px", display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700 }}
              >
                <i className={loading ? "fas fa-spinner fa-spin" : "fas fa-search-location"} />
                <span>Track & Save</span>
              </button>

              <button
                type="button"
                className="btn btn-success"
                disabled={savingRecord || !liveData}
                onClick={handleManualSaveToDb}
                style={{ height: 42, display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 700 }}
                title="Explicitly save this live location into history log"
              >
                <i className={savingRecord ? "fas fa-spinner fa-spin" : "fas fa-save"} />
                <span>Save to DB</span>
              </button>

              <button
                type="button"
                className="btn btn-default"
                disabled={syncing}
                onClick={handleSyncFleet}
                style={{ height: 42, display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}
                title="Fetch latest live positions of all 117 Refex vehicles from ktt.io API"
              >
                <i className={`fas fa-sync-alt ${syncing ? "fa-spin" : ""}`} style={{ color: "var(--main-theme-color)" }} />
                <span>{syncing ? "Syncing..." : "Sync Live Fleet"}</span>
              </button>

              <button
                type="button"
                className="btn btn-default"
                onClick={() => setAutoRefresh(!autoRefresh)}
                style={{
                  height: 42,
                  borderColor: autoRefresh ? "var(--accent-lime)" : "#CBD5E1",
                  backgroundColor: autoRefresh ? "rgba(140, 188, 67, 0.15)" : "#fff",
                  color: autoRefresh ? "#2b6b15" : "inherit",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                }}
                title="Toggle live auto polling every 15 seconds"
              >
                <i className={`fas fa-satellite-dish ${autoRefresh ? "fa-spin" : ""}`} />
                <span>{autoRefresh ? "Live Polling (15s)" : "Auto-Refresh"}</span>
              </button>

              <button
                type="button"
                className="btn btn-default"
                onClick={() => setShowIngestModal(true)}
                style={{ height: 42, display: "inline-flex", alignItems: "center", gap: 8, fontWeight: 600 }}
                title="Test live JSON response ingestion into database"
              >
                <i className="fas fa-file-import" />
                <span>Simulator</span>
              </button>
            </div>
          </form>

          {/* Quick select pills */}
          {knownVehicles.length > 0 && (
            <div style={{ marginTop: 14, borderTop: "1px solid #F1F5F9", paddingTop: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                <span style={{ color: "var(--color-muted)", fontSize: 12, fontWeight: 700 }}>
                  Fleet Vehicles ({knownVehicles.length} connected):
                </span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    onClick={() => setVehicleFilterStatus("all")}
                    className={`btn btn-xs ${vehicleFilterStatus === "all" ? "btn-primary" : "btn-default"}`}
                  >
                    All ({knownVehicles.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setVehicleFilterStatus("moving")}
                    className={`btn btn-xs ${vehicleFilterStatus === "moving" ? "btn-success" : "btn-default"}`}
                  >
                    Moving ({knownVehicles.filter((v) => Number(v.last_spd) > 0).length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setVehicleFilterStatus("stopped")}
                    className={`btn btn-xs ${vehicleFilterStatus === "stopped" ? "btn-default active" : "btn-default"}`}
                  >
                    Stopped ({knownVehicles.filter((v) => Number(v.last_spd) === 0).length})
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", maxHeight: 72, overflowY: "auto", padding: 2 }}>
                {filteredVehicles.slice(0, 40).map((v) => (
                  <button
                    key={v.vno}
                    type="button"
                    onClick={() => {
                      setVehicleNo(v.vno);
                      fetchGpsData(v.vno, true);
                    }}
                    style={{
                      border: v.vno === activeVehicle ? "1px solid var(--main-theme-color)" : "1px solid #E2E8F0",
                      background: v.vno === activeVehicle ? "rgba(32, 121, 183, 0.1)" : "#F8FAFC",
                      color: v.vno === activeVehicle ? "var(--main-theme-color)" : "#475569",
                      padding: "2px 8px",
                      borderRadius: 99,
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                  >
                    <i className="fas fa-circle" style={{ fontSize: 6, marginRight: 5, color: Number(v.last_spd) > 0 ? "#10B981" : "#94A3B8" }} />
                    {v.vno}
                  </button>
                ))}
                {filteredVehicles.length > 40 && (
                  <span style={{ fontSize: 11, color: "var(--color-muted)", fontStyle: "italic", marginLeft: 4 }}>
                    +{filteredVehicles.length - 40} more (use search input above)
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* KPI Status Strip for Selected Vehicle */}
      <div className="rm-kpi-row" style={{ marginBottom: 16 }}>
        <Kpi
          label="Tracked Vehicle"
          value={activeVehicle || "—"}
          hint={liveData ? `VID: ${liveData.vid || "—"} (Saved to DB)` : "No live ping"}
          icon="fa-truck"
          tone="blue"
        />
        <Kpi
          label="Live Speed"
          value={liveData ? `${Number(liveData.spd || 0).toFixed(0)} km/h` : "—"}
          hint={isSimulatingMotion ? "Simulating In-Transit Motion" : liveData && Number(liveData.spd) > 0 ? "In Transit" : "Stationary / Idle"}
          icon="fa-tachometer-alt"
          tone={isSimulatingMotion || (liveData && Number(liveData.spd) > 0) ? "green" : ""}
        />
        <Kpi
          label="Ignition Status"
          value={liveData ? (liveData.ign ? "ON" : "OFF") : "—"}
          hint={liveData?.ign ? "Engine Running" : "Engine Switched Off"}
          icon="fa-key"
          tone={liveData?.ign ? "green" : "orange"}
        />
        <Kpi
          label="Fuel Sensor"
          value={liveData ? (liveData.fuel || "unknown") : "—"}
          hint="Telemetry Status"
          icon="fa-gas-pump"
          tone={liveData?.fuel === "connected" ? "green" : ""}
        />
        <Kpi
          label="Saved Historical Logs"
          value={historyRows.length}
          hint="Stored in DB"
          icon="fa-database"
          tone="green"
        />
      </div>

      {/* Tabs navigation: Live Data vs Old Data */}
      <div style={{ display: "flex", borderBottom: "2px solid #E2E8F0", marginBottom: 16, gap: 8 }}>
        <button
          type="button"
          onClick={() => setActiveTab("live")}
          style={{
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 700,
            border: "none",
            background: "none",
            cursor: "pointer",
            borderBottom: activeTab === "live" ? "3px solid var(--main-theme-color)" : "3px solid transparent",
            color: activeTab === "live" ? "var(--main-theme-color)" : "var(--color-muted)",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <i className="fas fa-satellite" />
          <span>Live Telemetry & Moving Map</span>
          {liveData && (
            <span style={{ fontSize: 10, background: "#10B981", color: "#fff", padding: "2px 6px", borderRadius: 10 }}>
              LIVE
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("history")}
          style={{
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 700,
            border: "none",
            background: "none",
            cursor: "pointer",
            borderBottom: activeTab === "history" ? "3px solid var(--main-theme-color)" : "3px solid transparent",
            color: activeTab === "history" ? "var(--main-theme-color)" : "var(--color-muted)",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <i className="fas fa-history" />
          <span>Old Data / Stored Logs</span>
          <span style={{ fontSize: 11, background: "#E2E8F0", color: "#475569", padding: "2px 8px", borderRadius: 10 }}>
            {historyRows.length} saved
          </span>
        </button>
      </div>

      {/* TAB 1: LIVE DATA & MOVING MAP */}
      {activeTab === "live" && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(320px, 380px) 1fr", gap: 16 }}>
          {/* Telemetry Card */}
          <Box
            title={`Live Status: ${activeVehicle}`}
            tools={
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {liveData && (
                  <span className={`label ${liveData.ign ? "label-success" : "label-default"}`}>
                    {liveData.ign ? "IGN ON" : "IGN OFF"}
                  </span>
                )}
                <button
                  type="button"
                  className="btn btn-xs btn-success"
                  onClick={handleManualSaveToDb}
                  disabled={savingRecord || !liveData}
                  style={{ fontWeight: 700 }}
                  title="Save current live reading to database"
                >
                  <i className="fas fa-save" style={{ marginRight: 4 }} />
                  <span>Save Record</span>
                </button>
              </div>
            }
          >
            {liveData ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ background: "#F8FAFC", borderRadius: 10, padding: 14, border: "1px solid #E2E8F0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", textTransform: "uppercase" }}>
                      Last GPS Ping Recorded
                    </div>
                    <span style={{ fontSize: 11, color: "#166534", background: "#DCFCE7", padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>
                      ✓ Saved in DB
                    </span>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#0F172A", marginTop: 4 }}>
                    <i className="far fa-clock" style={{ marginRight: 6, color: "var(--main-theme-color)" }} />
                    {liveData.gps_time || "—"}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--color-muted)", marginTop: 4 }}>
                    Logged in system: {liveData.recorded_at || "—"}
                  </div>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: 11, color: "var(--color-muted)", fontWeight: 600 }}>Vehicle ID (VID)</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>{liveData.vid || "—"}</div>
                  </div>

                  <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: 11, color: "var(--color-muted)", fontWeight: 600 }}>Current Speed</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4, color: isSimulatingMotion || Number(liveData.spd) > 0 ? "#059669" : "#64748B" }}>
                      {isSimulatingMotion ? "42 km/h (Sim)" : `${Number(liveData.spd || 0).toFixed(0)} km/h`}
                    </div>
                  </div>

                  <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: 11, color: "var(--color-muted)", fontWeight: 600 }}>Heading / Course</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>
                      <i className="fas fa-compass" style={{ marginRight: 5, color: "#6366F1" }} />
                      {headingDirection(liveData.crs)}
                    </div>
                  </div>

                  <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: "1px solid #E2E8F0" }}>
                    <div style={{ fontSize: 11, color: "var(--color-muted)", fontWeight: 600 }}>Fuel Sensor</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4 }}>
                      <span className={`label ${liveData.fuel === "connected" ? "label-success" : "label-warning"}`}>
                        {liveData.fuel || "unknown"}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Coordinates & Google Maps Link */}
                <div style={{ background: "#F8FAFC", borderRadius: 10, padding: 14, border: "1px solid #E2E8F0" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", textTransform: "uppercase" }}>
                    Geographic Coordinates
                  </div>
                  <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 600, color: "#1E293B", marginTop: 4 }}>
                    Lat: {Number(liveData.lat).toFixed(6)}, Lon: {Number(liveData.lon).toFixed(6)}
                  </div>
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <a
                      href={mapsHref(liveData.lat, liveData.lon)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn btn-xs btn-default"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}
                    >
                      <i className="fas fa-external-link-alt" />
                      <span>Google Maps</span>
                    </a>
                    <button
                      type="button"
                      className="btn btn-xs btn-primary"
                      onClick={() => setIsSimulatingMotion(!isSimulatingMotion)}
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}
                    >
                      <i className="fas fa-play" />
                      <span>{isSimulatingMotion ? "Stop Motion" : "Simulate Motion"}</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--color-muted)" }}>
                <i className="fas fa-map-marker-alt" style={{ fontSize: 36, opacity: 0.3, marginBottom: 12 }} />
                <p style={{ margin: 0, fontWeight: 600 }}>No live GPS ping found for {activeVehicle}.</p>
              </div>
            )}
          </Box>

          {/* Map View */}
          <Box title={`Live Vehicle Map — ${activeVehicle}`}>
            <LiveMovingMap
              lat={currentMapData?.lat}
              lon={currentMapData?.lon}
              heading={currentMapData?.crs || 0}
              speed={currentMapData?.spd || 0}
              ignition={Boolean(currentMapData?.ign)}
              vehicleNo={activeVehicle}
              time={currentMapData?.gps_time}
              historyPings={historyRows}
              isSimulatingMotion={isSimulatingMotion}
              onToggleMotionSimulation={() => setIsSimulatingMotion(!isSimulatingMotion)}
            />
          </Box>
        </div>
      )}

      {/* TAB 2: OLD DATA / HISTORICAL LOGS */}
      {activeTab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* History Filter Strip */}
          <div className="box box-default">
            <div className="box-body" style={{ padding: "14px 20px" }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end", justifyContent: "space-between" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-end" }}>
                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", marginBottom: 4, display: "block" }}>
                      From Date
                    </label>
                    <input
                      type="date"
                      className="form-control"
                      value={dateFrom}
                      onChange={(e) => setDateFrom(e.target.value)}
                      style={{ height: 36 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", marginBottom: 4, display: "block" }}>
                      To Date
                    </label>
                    <input
                      type="date"
                      className="form-control"
                      value={dateTo}
                      onChange={(e) => setDateTo(e.target.value)}
                      style={{ height: 36 }}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", marginBottom: 4, display: "block" }}>
                      Max Pings
                    </label>
                    <select
                      className="form-control"
                      value={historyLimit}
                      onChange={(e) => setHistoryLimit(Number(e.target.value))}
                      style={{ height: 36 }}
                    >
                      <option value={50}>Latest 50</option>
                      <option value={200}>Latest 200</option>
                      <option value={500}>Latest 500</option>
                      <option value={1000}>Latest 1000</option>
                    </select>
                  </div>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => reloadHistory(activeVehicle)}
                    style={{ height: 36, display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}
                  >
                    <i className="fas fa-filter" />
                    <span>Filter History</span>
                  </button>

                  {(dateFrom || dateTo) && (
                    <button
                      type="button"
                      className="btn btn-default"
                      onClick={() => {
                        setDateFrom("");
                        setDateTo("");
                        api.gpsHistory(activeVehicle, "", "", historyLimit).then((res) => setHistoryRows(res?.rows || []));
                      }}
                      style={{ height: 36 }}
                    >
                      Clear Filter
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  className="btn btn-success"
                  disabled={savingRecord || !liveData}
                  onClick={handleManualSaveToDb}
                  style={{ height: 36, display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 700 }}
                >
                  <i className="fas fa-save" />
                  <span>Record New Ping to DB</span>
                </button>
              </div>
            </div>
          </div>

          {/* Map View for selected ping */}
          <Box title={`Route Breadcrumbs Map — ${pickedPing ? `Ping at ${pickedPing.gps_time}` : activeVehicle}`}>
            <LiveMovingMap
              lat={currentMapData?.lat}
              lon={currentMapData?.lon}
              heading={currentMapData?.crs || 0}
              speed={currentMapData?.spd || 0}
              ignition={Boolean(currentMapData?.ign)}
              vehicleNo={activeVehicle}
              time={currentMapData?.gps_time}
              historyPings={historyRows}
              isSimulatingMotion={isSimulatingMotion}
              onToggleMotionSimulation={() => setIsSimulatingMotion(!isSimulatingMotion)}
            />
          </Box>

          {/* Historical Data Table */}
          <Box
            title={`Stored GPS Tracking Records for ${activeVehicle} (${historyRows.length} entries)`}
            tools={(
              <button
                type="button"
                className="btn btn-default btn-sm"
                disabled={!selectedGps.size || exportingGps}
                onClick={async () => {
                  setExportingGps(true);
                  try {
                    const exported = await api.gpsExport([...selectedGps]);
                    toast.success(`Exported ${selectedGps.size} GPS records in ${exported.filename}`);
                  } catch (error) {
                    toast.error(error.message);
                  } finally {
                    setExportingGps(false);
                  }
                }}
              >
                {selectedGps.size ? `Export selected (${selectedGps.size})` : "Export selected"}
              </button>
            )}
          >
            {historyRows.length > 0 ? (
              <div className="table-responsive">
                <table className="table table-hover table-striped">
                  <thead>
                    <tr>
                      <th className="pick-col">
                        <input type="checkbox" aria-label="Select all GPS records" checked={allChecked(selectedGps, historyRows.map((row) => row.id))} onChange={() => setSelectedGps((current) => toggleAll(current, historyRows.map((row) => row.id)))} />
                      </th>
                      <th style={{ width: 50 }}>#</th>
                      <th>GPS Time</th>
                      <th>Vehicle No</th>
                      <th>Coordinates</th>
                      <th>Speed</th>
                      <th>Course</th>
                      <th>Ignition</th>
                      <th>Fuel</th>
                      <th>VID</th>
                      <th>Stored At</th>
                      <th style={{ textAlign: "right" }}>Map</th>
                    </tr>
                  </thead>
                  <tbody>
                    {historyRows.map((row, idx) => (
                      <tr
                        key={row.id || idx}
                        style={{
                          backgroundColor: pickedPing?.id === row.id ? "rgba(32, 121, 183, 0.08)" : undefined,
                        }}
                      >
                        <td className="pick-col">
                          <input type="checkbox" aria-label={`Select GPS record ${idx + 1}`} checked={selectedGps.has(row.id)} onChange={() => setSelectedGps((current) => toggleId(current, row.id))} />
                        </td>
                        <td style={{ color: "var(--color-muted)", fontSize: 12 }}>{idx + 1}</td>
                        <td style={{ fontWeight: 600 }}>
                          <i className="far fa-clock" style={{ marginRight: 6, color: "var(--main-theme-color)" }} />
                          {row.gps_time}
                        </td>
                        <td style={{ fontWeight: 700 }}>{row.vno}</td>
                        <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                          {Number(row.lat).toFixed(6)}, {Number(row.lon).toFixed(6)}
                        </td>
                        <td>
                          <span style={{ fontWeight: 700, color: Number(row.spd) > 0 ? "#059669" : "#64748B" }}>
                            {Number(row.spd || 0).toFixed(0)} km/h
                          </span>
                        </td>
                        <td>{headingDirection(row.crs)}</td>
                        <td>
                          <span className={`label ${row.ign ? "label-success" : "label-default"}`}>
                            {row.ign ? "ON" : "OFF"}
                          </span>
                        </td>
                        <td>
                          <span className={`label ${row.fuel === "connected" ? "label-success" : "label-warning"}`}>
                            {row.fuel || "unknown"}
                          </span>
                        </td>
                        <td style={{ fontSize: 12 }}>{row.vid || "—"}</td>
                        <td style={{ fontSize: 12, color: "var(--color-muted)" }}>{row.recorded_at}</td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="btn btn-xs btn-default"
                            title="Focus on Map"
                            onClick={() => {
                              setPickedPing(row);
                              window.scrollTo({ top: 350, behavior: "smooth" });
                            }}
                            style={{ marginRight: 4 }}
                          >
                            <i className="fas fa-crosshairs" />
                            <span style={{ marginLeft: 4 }}>Focus</span>
                          </button>
                          <a
                            href={mapsHref(row.lat, row.lon)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-xs btn-default"
                            title="Open in Google Maps"
                          >
                            <i className="fas fa-external-link-alt" />
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: "40px 20px", textAlign: "center", color: "var(--color-muted)" }}>
                <i className="fas fa-database" style={{ fontSize: 36, opacity: 0.3, marginBottom: 12 }} />
                <p style={{ margin: 0, fontWeight: 600 }}>No historical GPS data found for {activeVehicle}.</p>
              </div>
            )}
          </Box>
        </div>
      )}

      {/* MODAL: Simulator / Ingest Live Response */}
      {showIngestModal && (
        <div className="modal-backdrop-custom" style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.6)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: 16,
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            maxWidth: 600,
            width: "100%",
            boxShadow: "0 20px 40px rgba(0, 0, 0, 0.2)",
            overflow: "hidden",
          }}>
            <div style={{
              padding: "16px 20px",
              borderBottom: "1px solid #E2E8F0",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
                <i className="fas fa-cloud-upload-alt" style={{ color: "var(--main-theme-color)" }} />
                <span>Store Live GPS Response</span>
              </h3>
              <button
                type="button"
                onClick={() => setShowIngestModal(false)}
                style={{ border: "none", background: "none", fontSize: 18, cursor: "pointer", color: "var(--color-muted)" }}
              >
                &times;
              </button>
            </div>

            <div style={{ padding: "20px" }}>
              <textarea
                className="form-control"
                rows={10}
                style={{ fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical" }}
                value={ingestPayload}
                onChange={(e) => setIngestPayload(e.target.value)}
              />

              <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <button
                  type="button"
                  className="btn btn-xs btn-default"
                  onClick={() => setIngestPayload(SAMPLE_PAYLOAD)}
                >
                  Reset to User Sample (CG04NU2465)
                </button>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-default"
                    onClick={() => setShowIngestModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={ingesting}
                    onClick={handleStorePayload}
                    style={{ fontWeight: 600 }}
                  >
                    {ingesting ? <i className="fas fa-spinner fa-spin" /> : <i className="fas fa-save" />}
                    <span style={{ marginLeft: 6 }}>Store & View</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
