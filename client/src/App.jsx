import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { AuthProvider, useAuth } from "./api/AuthContext.jsx";
import { ToastProvider } from "./components/Toast.jsx";
import InteractiveLoginPage from "./components/login/InteractiveLoginPage.jsx";
import { ForgotPasswordPage, ResetPasswordPage, AccountProfile, AccountPassword } from "./pages/Account.jsx";
import Shell from "./components/Shell.jsx";
// import Dashboard from "./pages/Dashboard.jsx";
// import Funnel from "./pages/Funnel.jsx";
// import Opportunities from "./pages/Opportunities.jsx";
// import OpportunityView from "./pages/OpportunityView.jsx";
// import OpportunityEdit from "./pages/OpportunityEdit.jsx";
// import AddOpportunity from "./pages/AddOpportunity.jsx";
// import Pipeline from "./pages/Pipeline.jsx";
// import Forecast from "./pages/Forecast.jsx";
// import Lost from "./pages/Lost.jsx";
// import Reports from "./pages/Reports.jsx";
// import Settings from "./pages/Settings.jsx";
import Fastag from "./pages/Fastag.jsx";
import RouteMaster from "./pages/RouteMaster.jsx";
import Admin from "./pages/Admin.jsx";
import GpsTracking from "./pages/GpsTracking.jsx";
import TripChecks from "./pages/TripChecks.jsx";

function safeAppNext(raw) {
  if (!raw) return null;
  let value = raw;
  try { value = decodeURIComponent(raw); } catch { /* keep */ }
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.startsWith("/login") || value.startsWith("/forgot") || value.startsWith("/reset")) return null;
  return value;
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>;
  if (!user) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}

function RequireModule({ permission, children }) {
  const { can, loading } = useAuth();
  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>;
  if (!can(permission)) return <p className="p-10 text-center">You do not have access to this module.</p>;
  return children;
}

function RequireAdmin({ children }) {
  const { isAdmin, loading } = useAuth();
  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>;
  if (!isAdmin) return <p className="p-10 text-center">Only administrators can access this page.</p>;
  return children;
}

function LoginRoute() {
  const { login } = useAuth();
  const location = useLocation();
  const next = safeAppNext(new URLSearchParams(location.search).get("next"));
  return (
    <InteractiveLoginPage
      onSubmit={async ({ email, password }) => {
        await login(email, password);
        window.location.replace(next || "/routes");
      }}
    />
  );
}

function AppRoutes() {
  const { user } = useAuth();
  const [region, setRegion] = useState("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    if (user?.region_key) setRegion(user.region_key);
  }, [user?.region_key]);
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <Shell region={region} setRegion={setRegion} onSearch={setSearch} />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Navigate to="/routes" replace />} />
        <Route path="/routes" element={<RequireModule permission="routes"><RouteMaster /></RequireModule>} />
        <Route path="/fastag" element={<RequireModule permission="fastag"><Fastag /></RequireModule>} />
        <Route path="/checks" element={<RequireModule permission="checks"><TripChecks /></RequireModule>} />
        <Route path="/gps" element={<RequireModule permission="gps"><GpsTracking /></RequireModule>} />
        <Route path="/users" element={<Navigate to="/admin" replace />} />
        <Route path="/admin" element={<RequireAdmin><Admin /></RequireAdmin>} />
        <Route path="/account/profile" element={<AccountProfile />} />
        <Route path="/account/password" element={<AccountPassword />} />
        <Route path="*" element={<Navigate to="/routes" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppRoutes />
      </ToastProvider>
    </AuthProvider>
  );
}
