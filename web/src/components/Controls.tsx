import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { api } from "../api.ts";
import { useStore } from "../store.tsx";
import { Avatar, Icon, relTime } from "./ui.tsx";

// The screen (noVNC) and terminal (ttyd) are served through the portal's /screen and /term proxies,
// behind the same login and Origin checks as /api (docs/ACCESS.md). noVNC builds its WebSocket URL
// from `path`, relative to the site root.
export const SCREEN_URL = "/screen/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1&path=screen/websockify";
export const SCREEN_PREVIEW_URL = "/screen/vnc_lite.html?scale=true&view_only=true&path=screen/websockify";
export const TERMINAL_URL = "/term/";

/**
 * A noVNC URL with the VNC password (x11vnc -passwdfile) in the fragment, which browsers never send
 * to a server; noVNC reads `&password=` from the whole URL. null while the password is loading.
 */
export function useScreenUrl(base: string): string | null {
  const [password, setPassword] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api.screenCredential()
      .then((r) => alive && setPassword(r.password))
      .catch(() => alive && setPassword(null));
    return () => { alive = false; };
  }, []);
  if (password === undefined) return null;
  return password ? `${base}#&password=${encodeURIComponent(password)}` : base;
}

/** "coder · since 14:01 · Fix token refresh" — or that the screen is free. */
export function ScreenHolder({ compact = false }: { compact?: boolean }) {
  const { display, agents } = useStore();
  if (!display) return <span className="hint">{compact ? "Screen free" : "Nobody is using the screen"}</span>;
  if (display.holder === "owner") return <span className="holder you">You have control{!compact && ` · since ${relTime(display.since)}`}</span>;
  const a = agents.find((x) => x.id === display.holder);
  return (
    <span className="holder" title={display.reason}>
      {a && <Avatar name={a.name} color={a.color} size={16} />}
      <strong>{a?.name ?? "An agent"}</strong>
      {!compact && <> is using the screen · since {relTime(display.since)}{display.reason && <> · {display.reason}</>}</>}
      {compact && " is on screen"}
    </span>
  );
}

/** Take control from agents / give it back. */
export function TakeControl() {
  const { display } = useStore();
  const mine = display?.holder === "owner";
  return mine ? (
    <button className="btn sm" onClick={() => api.releaseDisplay()}>Release control</button>
  ) : (
    <button className="btn sm" onClick={() => api.takeDisplay()} title="Agents are refused the screen until you release it">Take control</button>
  );
}

export function PauseControl() {
  const { paused } = useStore();
  const [confirm, setConfirm] = useState(false);
  const [running, setRunning] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!confirm) return;
    api.control().then((c) => setRunning(c.running)).catch(() => {});
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setConfirm(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirm(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [confirm]);

  if (paused) {
    return <button className="btn sm" onClick={() => api.resumeAll()}><Icon name="play" size={14} />Resume</button>;
  }
  return (
    <div className="popover-anchor" ref={ref}>
      <button className="btn sm danger" aria-expanded={confirm} onClick={() => setConfirm(!confirm)}>
        <Icon name="pause" size={14} />Pause all
      </button>
      {confirm && (
        <div className="popover" role="dialog" aria-label="Pause all agents">
          <strong>Pause every agent?</strong>
          <p className="hint">
            Nothing new starts until you resume: queued work waits and routines skip.
            {running > 0 ? ` ${running} turn${running > 1 ? "s are" : " is"} running right now.` : " Nothing is running right now."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn sm danger" onClick={() => { api.pauseAll(true); setConfirm(false); }}>
              {running > 0 ? "Stop running turns and pause" : "Pause"}
            </button>
            {running > 0 && (
              <button className="btn sm" onClick={() => { api.pauseAll(false); setConfirm(false); }}>Let them finish, then pause</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { ThemeSwitch } from "./ThemeSwitch.tsx";

export function PausedBar() {
  const { paused } = useStore();
  if (!paused) return null;
  return (
    <div className="paused-bar global" role="status">
      <Icon name="pause" size={14} />All agents are paused. Queued work waits and routines skip until you resume.
      <button className="btn sm" onClick={() => api.resumeAll()}>Resume</button>
    </div>
  );
}

/**
 * Where the screen preview sits: an offset from the bottom-right corner, dragged by hand and
 * remembered per browser. It's kept on screen when the window shrinks, and a double-click on the
 * handle puts it back in the corner.
 */
const PIP_POS_KEY = "agentbox.pip.pos";
const PIP_MARGIN = 8;
type Corner = { right: number; bottom: number };
function readPos(): Corner {
  try {
    const v = JSON.parse(localStorage.getItem(PIP_POS_KEY) ?? "null");
    if (v && Number.isFinite(v.right) && Number.isFinite(v.bottom)) return { right: v.right, bottom: v.bottom };
  } catch { /* storage unavailable */ }
  return { right: 16, bottom: 16 };
}

function useDragToMove() {
  const [pos, setPos] = useState<Corner>(readPos);
  const el = useRef<HTMLElement | null>(null);
  const moved = useRef(false);
  // Keep the whole thing inside the window (after a resize, or when it grows from pill to preview).
  const clamp = (p: Corner): Corner => {
    const r = el.current?.getBoundingClientRect();
    const w = r?.width ?? 0, h = r?.height ?? 0;
    return {
      right: Math.min(Math.max(PIP_MARGIN, p.right), Math.max(PIP_MARGIN, window.innerWidth - w - PIP_MARGIN)),
      bottom: Math.min(Math.max(PIP_MARGIN, p.bottom), Math.max(PIP_MARGIN, window.innerHeight - h - PIP_MARGIN)),
    };
  };
  const save = (p: Corner) => { try { localStorage.setItem(PIP_POS_KEY, JSON.stringify(p)); } catch { /* storage unavailable */ } };
  // After every render (e.g. the pill opening into the bigger preview): pull it back inside if it sticks out.
  useLayoutEffect(() => {
    const c = clamp(pos);
    if (c.right !== pos.right || c.bottom !== pos.bottom) setPos(c);
  });
  useEffect(() => {
    const fit = () => setPos((p) => clamp(p));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  /** Pointer handlers for the drag handle. A press that doesn't move stays a click. */
  const handle = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("a, button:not(.pip-drag)")) return;
      const start = { x: e.clientX, y: e.clientY, ...pos };
      moved.current = false;
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x, dy = ev.clientY - start.y;
        if (!moved.current && Math.hypot(dx, dy) < 4) return;
        moved.current = true;
        setPos(clamp({ right: start.right - dx, bottom: start.bottom - dy }));
      };
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        setPos((p) => { save(p); return p; });
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("a, button:not(.pip-drag)")) return;
      const home = { right: 16, bottom: 16 };
      setPos(home);
      save(home);
    },
  };
  /** True right after a drag: the click that ends it shouldn't also open or close anything. */
  const wasDrag = () => { const m = moved.current; moved.current = false; return m; };
  return { style: { right: pos.right, bottom: pos.bottom }, ref: el, handle, wasDrag };
}

/** A small live view of the shared screen; drag it anywhere (it starts in the bottom-right corner). */
export function ScreenPip() {
  const { display } = useStore();
  // "auto": a small pill, opening by itself while an agent is using the screen. A choice made by
  // hand (open / closed) sticks.
  const [mode, setMode] = useState<"auto" | "open" | "closed">(() => {
    try { const v = localStorage.getItem("agentbox.pip2"); return v === "open" || v === "closed" ? v : "auto"; } catch { return "auto"; }
  });
  const choose = (m: "open" | "closed") => {
    setMode(m);
    try { localStorage.setItem("agentbox.pip2", m); } catch { /* storage unavailable */ }
  };
  const agentOnScreen = !!display && display.holder !== "owner";
  const open = mode === "open" || (mode === "auto" && agentOnScreen);
  const setOpen = (v: boolean) => choose(v ? "open" : "closed");
  const previewUrl = useScreenUrl(SCREEN_PREVIEW_URL);
  const drag = useDragToMove();

  if (!open) {
    return (
      <button ref={drag.ref as React.Ref<HTMLButtonElement>} className="pip-tab pip-drag" style={drag.style} {...drag.handle}
        onClick={() => { if (!drag.wasDrag()) setOpen(true); }} aria-label="Show the shared screen (drag to move)" title="Show the shared screen · drag to move">
        <Icon name="screen" size={14} /><ScreenHolder compact />
      </button>
    );
  }
  return (
    <aside ref={drag.ref as React.Ref<HTMLElement>} className="pip" style={drag.style} aria-label="Shared screen preview">
      <div className="pip-bar" {...drag.handle} title="Drag to move · double-click to put it back in the corner">
        <span className="pip-grip" aria-hidden="true">⋮⋮</span>
        <ScreenHolder compact />
        <a className="icon-btn" href="#/screen" aria-label="Open the screen" title="Open the screen"><Icon name="screen" size={14} /></a>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Hide preview" title="Hide preview"><Icon name="close" size={14} /></button>
      </div>
      <div className="pip-screen">
        {previewUrl && <iframe src={previewUrl} title="Shared screen preview (view only)" tabIndex={-1} />}
      </div>
    </aside>
  );
}
