import { getApiBase } from "./baseUrl.js";

const TOKEN_KEY = "3i_token";

export function token() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function request(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };
  const t = token();
  if (t) headers.Authorization = `Bearer ${t}`;
  if (options.json !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
  });

  if (options.download) {
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = Array.isArray(data.messages)
        ? data.messages.join(", ")
        : data.messages || data.message || data.error || res.statusText;
      throw new Error(String(msg));
    }
    const blob = await res.blob();
    const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
    const name = match?.[1] || "download";
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
    return { filename: name };
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const messages = Array.isArray(data.messages)
      ? data.messages.map((item) => String(item))
      : [String(data.messages || data.message || data.error || res.statusText)];
    const error = new Error(messages.join("\n"));
    error.messages = messages;
    throw error;
  }
  return data;
}

export const authApi = {
  login: (email, password) =>
    request("/login", { method: "POST", json: { email, password } }),
  me: () => request("/user"),
  logout: () => request("/logout", { method: "POST" }).catch(() => undefined),
  forgotPassword: (email) =>
    request("/password/forgot", { method: "POST", json: { email } }),
  validateResetToken: (tok) => request(`/password/reset/${encodeURIComponent(tok)}`),
  resetPassword: (tok, password, password_confirmation) =>
    request("/password/reset", {
      method: "POST",
      json: { token: tok, password, password_confirmation },
    }),
};

export const api = {
  meta: () => request("/meta"),
  opportunities: (q = "") => request("/opportunities" + q),
  opportunity: (id) => request("/opportunities/" + encodeURIComponent(id)),
  create: (body) => request("/opportunities", { method: "POST", json: body }),
  patch: (id, body) =>
    request("/opportunities/" + encodeURIComponent(id), { method: "PATCH", json: body }),
  stage: (id, processStage) =>
    request("/opportunities/" + encodeURIComponent(id) + "/stage", {
      method: "POST",
      json: { processStage },
    }),
  remark: (id, text) =>
    request("/opportunities/" + encodeURIComponent(id) + "/remarks", {
      method: "POST",
      json: { text },
    }),
  dashboard: (q = "") => request("/dashboard" + q),
  funnel: (q = "") => request("/funnel" + q),
  forecast: (q = "") => request("/forecast" + q),
  lost: (q = "") => request("/lost" + q),
  quality: () => request("/quality"),
  reset: () => request("/reset", { method: "POST" }),
  users: () => request("/users"),
  adminRoles: () => request("/admin/roles"),
  saveAdminRoles: (gps) => request("/admin/roles", { method: "PUT", json: { gps } }),
  runMigrations: () => request("/admin/migrate", { method: "POST" }),
  gpsCollectionSettings: () => request("/admin/gps-collection"),
  saveGpsCollectionSettings: (body) => request("/admin/gps-collection", { method: "PUT", json: body }),
  runGpsCollection: () => request("/admin/gps-collection/run", { method: "POST" }),
  createUser: (body) => request("/users", { method: "POST", json: body }),
  patchUser: (id, body) => request(`/users/${id}`, { method: "PATCH", json: body }),
  deleteUser: (id) => request(`/users/${id}`, { method: "DELETE" }),
  resetUserPassword: (id, password, mustChange = false) =>
    request(`/users/${id}/reset-password`, {
      method: "POST",
      json: { password, must_change_password: mustChange },
    }),
  routes: () => request("/routes"),
  route: (id) => request(`/routes/${encodeURIComponent(id)}`),
  createRoute: (body) => request("/routes", { method: "POST", json: body }),
  updateRoute: (id, body) => request(`/routes/${encodeURIComponent(id)}`, { method: "PUT", json: body }),
  deleteRoute: (id) => request(`/routes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  fetchTollsForRoute: (body) => request("/routes/fetch-tolls", { method: "POST", json: body }),
  tollPlazasDirectory: () => request("/routes/directory/toll-plazas"),
  savedTolls: () => request("/routes/directory/saved-tolls"),
  profile: () => request("/account/profile"),
  saveProfile: (body) => request("/account/profile", { method: "PATCH", json: body }),
  changePassword: (body) => request("/account/password", { method: "POST", json: body }),
  fastagActivity: (limit = 8, offset = 0) => request(`/fastag/activity?limit=${limit}&offset=${offset}`),
  fastagBatches: () => request("/fastag/batches"),
  fastagBatch: (id) => request("/fastag/batches/" + encodeURIComponent(id)),
  fastagUpload: (file) => {
    const body = new FormData();
    body.append("file", file);
    return request("/fastag/batches", { method: "POST", body });
  },
  fastagPreview: (file) => {
    const body = new FormData();
    body.append("file", file);
    return request("/fastag/preview", { method: "POST", body });
  },
  fastagRejectedExport: (payload) => request("/fastag/rejected-export", { method: "POST", json: payload, download: true }),
  fastagFetch: (id) => request("/fastag/batches/" + encodeURIComponent(id) + "/fetch", { method: "POST" }),
  fastagRetryFailed: (id) => request("/fastag/batches/" + encodeURIComponent(id) + "/retry-failed", { method: "POST" }),
  fastagLookup: (vehicleRegNo, sites = {}) => request("/fastag/lookup", {
    method: "POST",
    json: {
      vehicleRegNo,
      projectName: sites.projectName || "",
      challanId: sites.challanId || "",
      tripId: sites.tripId || "",
      fromLocation: sites.fromLocation || "",
      toLocation: sites.toLocation || "",
      fromDate: sites.fromDate || "",
      toDate: sites.toDate || "",
    },
  }),
  fastagRecords: (vehicle) => request("/fastag/records?vehicle=" + encodeURIComponent(vehicle)),
  fastagEntered: ({ vehicle = "", challan = "", project = "", date = "" } = {}) => {
    const params = new URLSearchParams();
    if (vehicle) params.set("vehicle", vehicle);
    if (challan) params.set("challan", challan);
    if (project) params.set("project", project);
    if (date) params.set("date", date);
    return request("/fastag/entered?" + params.toString());
  },
  fastagAudit: (vehicle = "") => request("/fastag/audit?vehicle=" + encodeURIComponent(vehicle)),
  fastagAuditClose: (keys) => request("/fastag/audit/close", { method: "POST", json: { keys } }),
  fastagAuditExport: (vehicle = "", focus = "", keys = []) => {
    if (keys.length) {
      return request("/fastag/audit/export", { method: "POST", json: { vehicle, focus, keys }, download: true });
    }
    const params = new URLSearchParams();
    if (vehicle) params.set("vehicle", vehicle);
    if (focus) params.set("focus", focus);
    const query = params.toString();
    return request("/fastag/audit/export" + (query ? `?${query}` : ""), { download: true });
  },
  fastagExport: (id, query = "") => request("/fastag/batches/" + encodeURIComponent(id) + "/export" + (query ? `?${query}` : ""), { download: true }),
  fastagCombined: (ids) => request("/fastag/batches/combined", { method: "POST", json: { ids } }),
  fastagCombinedExport: (ids, query = "") => request("/fastag/batches/export" + (query ? `?${query}` : ""), { method: "POST", json: { ids }, download: true }),
  fastagUploadedFile: (id) => request("/fastag/batches/" + encodeURIComponent(id) + "/file", { download: true }),
  fastagUploadedFiles: (ids) => request("/fastag/batches/files", { method: "POST", json: { ids }, download: true }),
  fastagSelectedExport: (ids) => request("/fastag/reads/export", { method: "POST", json: { ids }, download: true }),
  routeExport: (ids) => request("/routes/export", { method: "POST", json: { ids }, download: true }),
  savedTollExport: (names) => request("/routes/directory/saved-tolls/export", { method: "POST", json: { names }, download: true }),
  gpsExport: (ids) => request("/gps/export", { method: "POST", json: { ids }, download: true }),
  userExport: (ids) => request("/users/export", { method: "POST", json: { ids }, download: true }),
  importRoutes: (file) => {
    const body = new FormData();
    body.append("file", file);
    return request("/routes/import", { method: "POST", body });
  },
  downloadRouteTemplate: () => request("/routes/sample-template", { download: true }),
  // GPS Tracking
  gpsLive: (vno, sync = false) => request(`/gps/live?vno=${encodeURIComponent(vno)}${sync ? '&sync=1' : ''}`),
  gpsHistory: ({ vno = "", from = "", to = "", fromTime = "", toTime = "", limit = 500 } = {}) => {
    const params = new URLSearchParams();
    if (vno) params.set("vno", vno);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (fromTime) params.set("fromTime", fromTime);
    if (toTime) params.set("toTime", toTime);
    params.set("limit", String(limit));
    return request(`/gps/history?${params.toString()}`);
  },
  gpsCollectionStatus: () => request("/gps/collection-status"),
  gpsRoute: ({ vno, from = "", to = "", date = "", fromTime = "", toTime = "", limit = 5000, offset = 0 }) => {
    const params = new URLSearchParams();
    params.set("vno", vno);
    if (from || date) params.set("from", from || date);
    if (to) params.set("to", to);
    if (fromTime) params.set("fromTime", fromTime);
    if (toTime) params.set("toTime", toTime);
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    return request(`/gps/route?${params.toString()}`);
  },
  gpsVehicles: () => request("/gps/vehicles"),
  gpsSync: () => request("/gps/sync", { method: "POST" }),
  gpsSave: (payload) => request("/gps/save", { method: "POST", json: typeof payload === "string" ? { vno: payload } : payload }),
  gpsPing: (payload) => request("/gps/ping", { method: "POST", json: payload }),
};

export function formatINR(lakhs) {
  if (lakhs == null || Number(lakhs) === 0 || isNaN(Number(lakhs))) return "—";
  const n = Number(lakhs);
  if (n >= 100) {
    const cr = n / 100;
    const text = cr >= 10 ? cr.toFixed(1).replace(/\.0$/, "") : cr.toFixed(2).replace(/0$/, "").replace(/\.0$/, "");
    return "₹" + text + " Cr";
  }
  return "₹" + (n % 1 === 0 ? n : n.toFixed(1)) + " L";
}

export function qs(obj) {
  const p = new URLSearchParams();
  Object.entries(obj || {}).forEach(([k, v]) => {
    if (v && v !== "all") p.set(k, v);
  });
  const s = p.toString();
  return s ? "?" + s : "";
}
