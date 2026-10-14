import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../api/AuthContext.jsx";
// import { Select } from "./ui.jsx";

const NARROW_MQ = "(max-width: 991px)";

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(NARROW_MQ).matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_MQ);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return narrow;
}

const NAV = [
  { to: "/routes", label: "Route Master", icon: "fa-route", permission: "routes" },
  { to: "/fastag", label: "FASTag", icon: "fa-road", permission: "fastag" },
  { to: "/checks", label: "Trip checks", icon: "fa-flag", permission: "checks" },
  { to: "/gps", label: "GPS Tracking", icon: "fa-satellite-dish", permission: "gps" },
  { to: "/admin", label: "Admin", icon: "fa-user-shield", permission: "users" },
];

const TITLES = {
  "/routes": ["Route Master", "Route management and toll plaza mapping"],
  "/fastag": ["FASTag", "Vehicle toll lookups"],
  "/checks": ["Trip checks", "Multi-project vehicles and skipped tolls"],
  "/gps": ["GPS Tracking", "Live location & historical route playback"],
  "/admin": ["Admin", "Roles, users, and database updates"],
  "/users": ["Admin", "Roles, users, and database updates"],
  "/account/profile": ["Profile", "Your account"],
  "/account/password": ["Password", "Update sign-in"],
};

export default function Shell({ region, setRegion, onSearch }) {
  const isNarrow = useIsNarrow();
  const [collapsed, setCollapsed] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(NARROW_MQ).matches : false,
  );
  const [userOpen, setUserOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [q, setQ] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, can, displayName, isAdmin } = useAuth();
  const path = location.pathname;
  const [title, subtitle] = path.endsWith("/edit") && path.startsWith("/opportunities/")
    ? ["Edit opportunity", "Update record"]
    : /^\/opportunities\/.+/.test(path)
      ? ["Opportunity", "Record details"]
      : (TITLES[path] || ["FASTag", "Vehicle toll lookups"]);
  const drawerOpen = isNarrow && !collapsed;

  useEffect(() => {
    if (isNarrow) setCollapsed(true);
    else setCollapsed(false);
  }, [isNarrow]);

  useEffect(() => {
    if (isNarrow) setCollapsed(true);
    setUserOpen(false);
    setCreateOpen(false);
  }, [location.pathname, isNarrow]);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [drawerOpen]);

  const closeDrawer = () => {
    if (isNarrow) setCollapsed(true);
  };

  const searchSubmit = (e) => {
    e.preventDefault();
    onSearch?.(q.trim());
    navigate("/opportunities");
  };

  const items = NAV.filter((item) => can(item.permission));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const roleLabel = user?.jobtitle || (isAdmin ? "Administrator" : "GPS Team");

  return (
    <div className={`wrapper ${collapsed ? "sidebar-collapse" : ""} ${!collapsed ? "sidebar-open" : ""}${isNarrow ? " is-narrow" : ""}`}>
      {drawerOpen ? (
        <button type="button" className="sidebar-backdrop" aria-label="Close menu" onClick={closeDrawer} />
      ) : null}
      <header className="main-header">
        <NavLink to="/routes" className="logo" aria-label="Refex One" onClick={closeDrawer} style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "0 14px", height: "100%", background: "#fff", textDecoration: "none" }}>
          <img src="/logo.png" alt="Refex One" style={{ height: 36, width: "auto", maxWidth: 175, objectFit: "contain" }} />
        </NavLink>
        <nav className="navbar">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={drawerOpen ? "Close menu" : "Open menu"}
            aria-expanded={drawerOpen}
          >
            <i className="fas fa-bars" />
          </button>
          {/* <form className="header-search" onSubmit={searchSubmit}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search opportunities, customers…" />
            <button type="submit"><i className="fas fa-search" /></button>
          </form>
          <Select
            className="header-region"
            compact
            value={region}
            onChange={setRegion}
            options={[
              { value: "all", label: "All regions" },
              { value: "north", label: "Prem Territory" },
              { value: "west", label: "West Sales Team" },
            ]}
          /> */}
          <div className="navbar-custom-menu">
            <ul className="navbar-nav">
              {/* <li><NavLink to="/opportunities" title="Opportunities"><i className="fas fa-briefcase" /></NavLink></li>
              <li><NavLink to="/pipeline" title="Pipeline"><i className="fas fa-columns" /></NavLink></li>
              {isAdmin ? <li><NavLink to="/users" title="Users"><i className="fas fa-user-shield" /></NavLink></li> : null}
              <li className={`dropdown ${createOpen ? "open" : ""}`}>
                <button type="button" className="nav-icon-btn" onClick={() => setCreateOpen((o) => !o)}>
                  <i className="fas fa-plus" />
                </button>
                <div className="dropdown-menu">
                  <NavLink to="/add" onClick={() => setCreateOpen(false)}>Opportunity</NavLink>
                  {isAdmin ? <NavLink to="/users" onClick={() => setCreateOpen(false)}>App user</NavLink> : null}
                </div>
              </li>
              {isAdmin ? <li><NavLink to="/settings" title="Settings"><i className="fas fa-cog" /></NavLink></li> : null} */}
              <li className={`dropdown ${userOpen ? "open" : ""}`}>
                <button type="button" className="nav-icon-btn nav-user-btn" onClick={() => setUserOpen((o) => !o)}>
                  <i className="fas fa-user" aria-hidden="true" />
                  <span className="nav-user-name">{displayName}</span>
                </button>
                <div className="dropdown-menu">
                  <NavLink to="/account/profile" onClick={() => setUserOpen(false)}>Edit Profile</NavLink>
                  <NavLink to="/account/password" onClick={() => setUserOpen(false)}>Change Password</NavLink>
                  <div className="divider" />
                  <button type="button" onClick={() => { logout(); navigate("/login"); }}>Logout</button>
                </div>
              </li>
            </ul>
          </div>
        </nav>
      </header>

      <aside className="main-sidebar" aria-hidden={isNarrow && collapsed}>
        <ul className="sidebar-menu">
          {items.map((item) => (
            <li key={item.to} className={item.end ? (path === "/" ? "active" : "") : path.startsWith(item.to) ? "active" : ""}>
              <NavLink to={item.to} end={item.end} onClick={closeDrawer}>
                <i className={`fas ${item.icon} fa-fw`} /><span>{item.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </aside>

      <div className="content-wrapper toll-stage">
        <section className="tfx-hero">
          <div className="tfx-bubbles" aria-hidden="true">
            <i /><i /><i /><i /><i /><i /><i />
          </div>
          <div className="tfx-hero-content">
            <div className="tfx-hi">
              {greeting}, <span className="tfx-wave" aria-hidden="true">👋</span>
            </div>
            <h1><span className="tfx-shimmer">{displayName}</span></h1>
            <p>
              {subtitle || title}
              <span className="tfx-role-inline"> · {roleLabel}</span>
            </p>
          </div>
          <div className="tfx-period">
            <p className="tfx-period-lbl">{title}</p>
            <ol className="breadcrumb">
              <li><NavLink to="/routes">Home</NavLink></li>
              <li>{title}</li>
            </ol>
          </div>
        </section>
        <section className="content">
          <Outlet />
        </section>
      </div>

    </div>
  );
}
