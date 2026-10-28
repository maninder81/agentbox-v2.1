import { useEffect, useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { AgentStatus } from "../api.ts";

// Stroke icons, 16px grid (docs/UI-DESIGN.md: inline SVG, never emoji).
const PATHS: Record<string, string> = {
  screen: "M2.5 3h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM5.5 14.5h5M8 12v2.5",
  terminal: "M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM4.5 6l2 2-2 2M8.5 10.5h3",
  pulse: "M1.5 8h3L6 4l3 8 1.5-4h4",
  team: "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM1.5 13c0-2.2 1.8-3.5 4-3.5s4 1.3 4 3.5M11 7.5a1.75 1.75 0 1 0 0-3.5M11.5 9.5c1.7.2 3 1.4 3 3.5",
  plus: "M8 3v10M3 8h10",
  stop: "M4.5 4.5h7v7h-7z",
  send: "M2.5 8 13.5 2.5 10 13.5 7.5 8.5 2.5 8ZM7.5 8.5 13.5 2.5",
  panel: "M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM10 2.5v11",
  chevron: "M6 4l4 4-4 4",
  close: "M4 4l8 8M12 4l-8 8",
  check: "M3 8.5 6.5 12 13 4.5",
  x: "M4.5 4.5l7 7M11.5 4.5l-7 7",
  shell: "M3 5l3 3-3 3M8 11h5",
  edit: "M10.5 2.5l3 3-7.5 7.5H3v-3l7.5-7.5Z",
  read: "M2 3.5h4.5A1.5 1.5 0 0 1 8 5v8.5a1 1 0 0 0-1-1H2v-9ZM14 3.5H9.5A1.5 1.5 0 0 0 8 5v8.5a1 1 0 0 1 1-1h5v-9Z",
  search: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM14 14l-3.5-3.5",
  browser: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM1.5 8h13M8 1.5c1.8 1.9 2.6 4 2.6 6.5S9.8 12.6 8 14.5M8 1.5C6.2 3.4 5.4 5.5 5.4 8s.8 4.6 2.6 6.5",
  web: "M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1",
  plan: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5",
  diff: "M4.5 2v5M2 4.5h5M2 12h5M10 2.5h3.5v11H10",
  flow: "M1.5 6h4v4h-4zM10.5 2h4v4h-4zM10.5 10h4v4h-4zM5.5 8h2.5M8 4v8M8 4h2.5M8 12h2.5",
  agent: "M8 2v2M4.5 6.5h7a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1ZM6.5 9.5v.5M9.5 9.5v.5",
  tool: "M10 2.5a3.5 3.5 0 0 0-3.3 4.6L2.5 11.3v2.2h2.2l4.2-4.2A3.5 3.5 0 1 0 10 2.5Z",
  meta: "M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM14 14l-3.5-3.5",
  back: "M10 4 6 8l4 4",
  skill: "M8 1.5l1.6 3.9 4.2.4-3.2 2.8 1 4.1L8 10.5l-3.6 2.2 1-4.1-3.2-2.8 4.2-.4L8 1.5Z",
  delegate: "M2 8h9M8 4.5 11.5 8 8 11.5M13.5 3v10",
  board: "M2.5 2.5h3v11h-3zM6.5 2.5h3v7h-3zM10.5 2.5h3v9h-3z",
  routine: "M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 4.5V8l2.5 1.5",
  pause: "M5.5 3.5v9M10.5 3.5v9",
  play: "M5 3.5v9l7-4.5-7-4.5Z",
  activity: "M2.5 4h11M2.5 8h7M2.5 12h9",
  graph: "M4 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM12 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM5.3 3.8l5.4 3M10.6 8.3 6.3 12",
  refresh: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3",
  sun: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z",
  room: "M8 1.5 14.5 8 8 14.5 1.5 8 8 1.5ZM8 5 11 8 8 11 5 8 8 5Z",
  note: "M4 1.5h8v13L8 11.5 4 14.5v-13Z",
  clip: "M13 7.5 8.2 12.3a3.3 3.3 0 0 1-4.7-4.7l5.3-5.3a2.2 2.2 0 0 1 3.1 3.1L6.6 10.7a1.1 1.1 0 0 1-1.6-1.6l4.6-4.6",
  doc: "M4 1.5h5.5L12.5 4.5v10h-8.5zM9.5 1.5v3h3M6 8h4.5M6 11h4.5",
  image: "M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM1.5 11l3.5-3.5 3 3 2-2 4.5 4.5M10.5 6.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  phone: "M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM7 12h2",
  mic: "M8 1.5a2 2 0 0 1 2 2V8a2 2 0 0 1-4 0V3.5a2 2 0 0 1 2-2ZM4 7.5a4 4 0 0 0 8 0M8 11.5v3M5.5 14.5h5",
  repo: "M4.5 2.5v8.5M4.5 11a2 2 0 1 0 0 3.5 2 2 0 0 0 0-3.5ZM11.5 2.5a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5ZM11.5 6c0 3-4.5 2.5-7 5",
  plug: "M6 1.5v3M10 1.5v3M4.5 4.5h7v2.5a3.5 3.5 0 0 1-7 0V4.5ZM8 10.5v4",
  expand: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
  collapse: "M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5",
  copy: "M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM2.5 10.5v-7a1 1 0 0 1 1-1h7",
  insert: "M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM4.5 6.5l2 1.5-2 1.5M8 9.5h3.5",
  download: "M8 2.5v8M4.8 7.3 8 10.5l3.2-3.2M3 13.5h10",
  sparkle: "M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3M3.4 3.4l2 2M10.6 10.6l2 2M3.4 12.6l2-2M10.6 5.4l2-2",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.tool} />
    </svg>
  );
}

export function Avatar({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {name.slice(0, 1)}
    </span>
  );
}

const STATUS_WORD: Record<AgentStatus, string> = { idle: "Idle", working: "Working", limited: "Limited", error: "Error" };

export function StatusGlyph({ status, withLabel = false }: { status: AgentStatus; withLabel?: boolean }) {
  return (
    <span className="status" title={STATUS_WORD[status]}>
      <span className={`glyph ${status}`} />
      {withLabel ? STATUS_WORD[status] : <span className="sr-only">{STATUS_WORD[status]}</span>}
    </span>
  );
}

marked.setOptions({ gfm: true, breaks: false });
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// File paths agents mention: absolute under the agents' homes or the work area (from the server's
// config: /agents and /work by default), or ~/ (the agent's home).
let ROOTS = ["/agents", "/work"];
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildPathRe = () => new RegExp(`(^|[\\s(\\[{"'“‘\`,;:])((?:~|${ROOTS.map(escRe).join("|")})\\/[^\\s\`'"“”‘’<>()\\[\\]{},;|*]+)`, "g");
let PATH_RE = buildPathRe();
/** Called once the server says where the roots are (GET /api/state › roots). */
export function setPathRoots(roots: string[]) {
  const next = roots.map((r) => r.replace(/\/+$/, "")).filter((r) => r.startsWith("/") && r.length > 1);
  if (!next.length || next.join() === ROOTS.join()) return;
  ROOTS = next;
  PATH_RE = buildPathRe();
}
const TRAILING = /[.:,!?]+$/;

/** Links to served files (e.g. a file attached to a message) open in the document reader too. */
function markFileLinks(html: string) {
  if (!html.includes('href="/api/file?path=')) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  for (const a of tpl.content.querySelectorAll<HTMLAnchorElement>('a[href^="/api/file?path="]')) {
    const p = new URLSearchParams(a.getAttribute("href")!.split("?")[1]).get("path");
    if (!p) continue;
    a.dataset.filePath = p;
    a.className = "file-link";
    a.target = "_blank";
    a.rel = "noopener";
  }
  return tpl.innerHTML;
}

/** Turn file paths in rendered Markdown into links that open the document reader. */
function linkPaths(html: string, home?: string) {
  if (!ROOTS.some((r) => html.includes(r + "/")) && !html.includes("~/")) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = (n as Text).parentElement;
    if (parent?.closest("a, pre")) continue; // existing links and code blocks stay as they are
    if (PATH_RE.test((n as Text).data)) nodes.push(n as Text);
    PATH_RE.lastIndex = 0;
  }
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.data;
    for (const m of text.matchAll(PATH_RE)) {
      let raw = m[2];
      const trail = raw.match(TRAILING)?.[0] ?? "";
      raw = raw.slice(0, raw.length - trail.length);
      const full = raw.startsWith("~/") ? (home ? home + raw.slice(1) : null) : raw;
      const start = (m.index ?? 0) + m[1].length;
      if (!full || raw.length < 3 || raw.endsWith("/")) continue;
      frag.append(text.slice(last, start));
      const a = document.createElement("a");
      a.href = `/api/file?path=${encodeURIComponent(full)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "file-link";
      a.dataset.filePath = full;
      a.title = `Open ${full}`;
      a.textContent = raw;
      frag.append(a);
      last = start + raw.length;
    }
    if (last === 0) continue;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}

/**
 * Relative image and link paths in a document (e.g. `![Scores](report-img/11-scores.png)`) point next
 * to the document itself: served through /api/file from its folder, not from the portal's own URL.
 */
export function resolveRelative(html: string, base?: string) {
  if (!base || !/(src|href)="(?![a-z][a-z0-9+.-]*:|\/|#)/i.test(html)) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const abs = (rel: string) => {
    let p = rel.split(/[?#]/)[0];
    try { p = decodeURIComponent(p); } catch { /* keep it as written */ }
    const parts: string[] = [];
    for (const seg of `${base}/${p}`.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    return "/" + parts.join("/");
  };
  const relative = (v: string | null) => !!v && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(v);
  for (const img of tpl.content.querySelectorAll("img")) {
    const src = img.getAttribute("src");
    if (relative(src)) img.setAttribute("src", `/api/file?path=${encodeURIComponent(abs(src!))}`);
  }
  for (const a of tpl.content.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (!relative(href)) continue;
    const full = abs(href!);
    a.setAttribute("href", `/api/file?path=${encodeURIComponent(full)}`);
    a.classList.add("file-link");
    a.dataset.filePath = full;
  }
  return tpl.innerHTML;
}

/** Markdown as sanitized HTML (what the reader shows; also what "Download PDF" prints). `base`: the document's folder. */
export const markdownHtml = (text: string, base?: string) => resolveRelative(DOMPurify.sanitize(marked.parse(text, { async: false }) as string), base);
/** Sanitized HTML of an HTML document, for printing (no scripts, forms or remote frames). */
export const sanitizeHtml = (html: string) => DOMPurify.sanitize(html, { FORBID_TAGS: ["form", "iframe", "object", "embed"] });

/** `base`: the folder of the document being shown, for its relative images and links. */
export function Markdown({ text, streaming = false, home, base }: { text: string; streaming?: boolean; home?: string; base?: string }) {
  const html = useMemo(
    () => markFileLinks(linkPaths(resolveRelative(DOMPurify.sanitize(marked.parse(text, { async: false }) as string), base), home)),
    [text, home, base],
  );
  // Images (e.g. attached screenshots) open full size in a new tab.
  const openImage = (e: React.MouseEvent) => {
    const img = (e.target as HTMLElement).closest("img");
    if (img) window.open(img.src, "_blank", "noopener");
  };
  return <div className={`prose${streaming ? " cursor" : ""}`} onClick={openImage} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * Esc stops a running agent (backlog #1). Anything open on top — the reader, a popover, @-mention
 * suggestions, an overlaid side panel — gets the key first, so Esc there just closes it.
 */
export function useEscToStop(active: boolean, stop: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.repeat || e.isComposing || e.defaultPrevented) return;
      if (document.querySelector(".reader-backdrop, .popover, [data-esc-owner]")) return;
      const panel = document.querySelector(".panel");
      if (panel && getComputedStyle(panel).position === "fixed") return; // narrow screens: Esc closes the panel
      e.preventDefault();
      stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, stop]);
}

export function Spinner() {
  return <span className="glyph working" aria-hidden="true" />;
}

export function relTime(iso: string) {
  const d = new Date(iso);
  const same = d.toDateString() === new Date().toDateString();
  return same
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function duration(fromIso: string, toIso?: string | null) {
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
