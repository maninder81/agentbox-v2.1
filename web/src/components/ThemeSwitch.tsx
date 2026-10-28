import { useEffect, useRef, useState } from "react";
import { Icon } from "./ui.tsx";

/** The saved theme ("agentbox.theme", per browser), applied to <html> before React renders. */
export function applySavedTheme() {
  try {
    const t = localStorage.getItem("agentbox.theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch { /* storage unavailable: follow the system */ }
}

type Theme = "system" | "light" | "dark";
const THEMES: { key: Theme; label: string; icon: string }[] = [
  { key: "system", label: "System", icon: "screen" },
  { key: "light", label: "Light", icon: "sun" },
  { key: "dark", label: "Dark", icon: "moon" },
];

/** Light / Dark / System (backlog #2). Remembered per browser; applied instantly. */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("agentbox.theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("agentbox.theme", theme); } catch { /* storage unavailable */ }
  }, [theme]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const current = THEMES.find((t) => t.key === theme)!;
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="icon-btn" aria-label={`Theme: ${current.label}`} title={`Theme: ${current.label}`} aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <Icon name={current.icon} />
      </button>
      {open && (
        <div className="popover menu" role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button key={t.key} role="menuitemradio" aria-checked={theme === t.key} className="menu-item"
              onClick={() => { setTheme(t.key); setOpen(false); }}>
              <Icon name={t.icon} size={14} />{t.label}{theme === t.key && <span className="menu-check"><Icon name="check" size={14} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
