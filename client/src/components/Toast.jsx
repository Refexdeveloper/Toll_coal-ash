import { createContext, useCallback, useContext, useMemo, useState } from "react";

const ToastCtx = createContext(null);
let nextId = 1;

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const push = useCallback((kind, message, duration = 3500) => {
    const id = nextId++;
    setItems((prev) => [...prev.slice(-4), { id, kind, message }]);
    window.setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const api = useMemo(
    () => ({
      success: (message) => push("success", message),
      error: (message) => push("error", message),
      info: (message) => push("info", message),
      flag: (message) => push("flag", message, 8000),
    }),
    [push],
  );

  const dismiss = (id) => setItems((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast-item toast-${t.kind}`} role="status">
            <span>{t.message}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}
