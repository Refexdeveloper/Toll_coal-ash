import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";

export { default as Select } from "./AppSelect.jsx";
export { default as DateField } from "./DateField.jsx";

export function Box({ title, children, tools, type = "default", footer }) {
  return (
    <div className={`box box-${type}`}>
      {(title || tools) ? (
        <div className="box-header">
          {title ? <h3 className="box-title">{title}</h3> : <span />}
          {tools ? <div className="box-tools">{tools}</div> : null}
        </div>
      ) : null}
      <div className="box-body">{children}</div>
      {footer ? <div className="box-footer">{footer}</div> : null}
    </div>
  );
}

export function Field({ label, children, required, wide, full }) {
  const cls = ["rm-field", wide ? "rm-field--wide" : "", full ? "rm-field--full" : ""].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <label className={required ? "required" : undefined}>{label}</label>
      {children}
    </div>
  );
}

export function SmallBox({ to, count, label, tone = "blue", icon, footer }) {
  const toneMap = { blue: "", cyan: "teal", green: "green", lime: "green", orange: "orange", rose: "rose" };
  const iconClass = icon?.replace(/^fas\s+/, "") || "fa-chart-line";
  const value = typeof count === "number" ? count.toLocaleString("en-IN") : count;
  return (
    <Kpi
      to={to}
      label={label}
      value={value}
      hint={footer}
      icon={iconClass}
      tone={toneMap[tone] || ""}
    />
  );
}

const KPI_BARS = [22, 34, 28, 46, 40, 62, 88];
const KPI_TONE = {
  green: "tone-green",
  orange: "tone-orange",
  rose: "tone-rose",
  teal: "tone-teal",
  slate: "tone-slate",
  amber: "tone-amber",
  navy: "tone-navy",
  blue: "tone-navy",
};

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (/^\d+$/.test(cleaned)) return Number(cleaned);
  }
  return null;
}

function useCountUp(target) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (target == null) return undefined;
    let raf = 0;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 900);
      setN(Math.round(target * (1 - (1 - t) ** 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return n;
}

function tiltCard(event) {
  if (!window.matchMedia("(hover: hover)").matches) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  el.style.setProperty("--mx", `${x * 100}%`);
  el.style.setProperty("--my", `${y * 100}%`);
  el.classList.add("tilting");
  el.style.transform = `perspective(900px) rotateX(${(0.5 - y) * 8}deg) rotateY(${(x - 0.5) * 10}deg) translateY(-6px)`;
}

function untiltCard(event) {
  event.currentTarget.classList.remove("tilting");
  event.currentTarget.style.transform = "";
}

function pulseCard(event) {
  const el = event.currentTarget;
  el.classList.remove("fx-bounce");
  void el.offsetWidth;
  el.classList.add("fx-bounce");
}

export function Kpi({ label, value, hint, icon, tone, active, onClick, to }) {
  const numeric = asNumber(value);
  const counted = useCountUp(numeric);
  const display = numeric == null ? value : counted.toLocaleString("en-IN");
  const live = typeof hint === "string" && /live|in transit|running/i.test(hint);
  const className = [
    "tfx-kpi",
    KPI_TONE[tone] || "",
    active ? "selected" : "",
    onClick || to ? "" : "is-static",
    numeric == null ? "is-text" : "",
  ].filter(Boolean).join(" ");
  const body = (
    <>
      <span className="tfx-kpi-shine" />
      <span className="tfx-kpi-spot" />
      <div className="tfx-kpi-head">
        <div className="tfx-kpi-icon" aria-hidden="true">
          <i className={`fas ${icon || "fa-chart-line"}`} />
        </div>
        <div className="tfx-kpi-title">
          <h3>{label}</h3>
          {hint ? (
            <span>
              {live ? <i className="tfx-live-dot" /> : null}
              {hint}
            </span>
          ) : null}
        </div>
      </div>
      <div className="tfx-kpi-body">
        <div>
          <div className="tfx-kpi-num">{display}</div>
        </div>
        <div className="tfx-kpi-bars" aria-hidden="true">
          {KPI_BARS.map((height, index) => (
            <i key={height + index} style={{ "--h": `${height}%`, "--n": index }} />
          ))}
        </div>
      </div>
      <div className="tfx-kpi-progress" aria-hidden="true">
        <div className="track"><span className="fill" style={{ "--p": active ? "100%" : "78%" }} /></div>
      </div>
    </>
  );
  if (to) {
    return (
      <Link to={to} className={className} onMouseMove={tiltCard} onMouseLeave={untiltCard} onClick={pulseCard}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        aria-pressed={Boolean(active)}
        onMouseMove={tiltCard}
        onMouseLeave={untiltCard}
        onClick={(event) => {
          pulseCard(event);
          onClick(event);
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={className} onMouseMove={tiltCard} onMouseLeave={untiltCard}>
      {body}
    </div>
  );
}

function useEscape(onClose) {
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

export function Modal({ title, onClose, children, wide, footer }) {
  useEscape(onClose);
  return createPortal(
    <div className="rm-modal-overlay" onClick={onClose}>
      <div className={`rm-modal${wide ? " rm-modal--wide" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="rm-modal__head">
          <h3>{title}</h3>
          <button type="button" className="rm-modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="rm-modal__body">{children}</div>
        {footer ? <div className="rm-modal__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
