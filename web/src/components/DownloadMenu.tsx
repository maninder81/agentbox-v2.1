import { useEffect, useRef, useState } from "react";
import { fileUrl } from "../api.ts";
import { markdownHtml, sanitizeHtml } from "./ui.tsx";

/**
 * The reader's download button for documents that read as text (Markdown, plain text, HTML):
 * "Download PDF" first, and the original file (.md…) in the menu. The PDF is printed on the server by
 * headless Chromium from the same HTML the reader shows; without Chromium there, the browser's print
 * dialog opens instead ("Save as PDF").
 */
export type Printable = "markdown" | "text" | "html";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
const base = (name: string) => name.replace(/\.[A-Za-z0-9]{1,8}$/, "");

async function source(path: string, kind: Printable, text: string | null) {
  const raw: string = text ?? await fetch(fileUrl(path)).then((r) => { if (!r.ok) throw new Error(r.statusText); return r.text(); });
  if (kind === "markdown") return inlineImages(markdownHtml(raw, path.slice(0, path.lastIndexOf("/"))));
  if (kind === "html") return sanitizeHtml(raw);
  return `<pre class="pre-doc">${esc(raw)}</pre>`;
}

/** The PDF printer takes no network (data: images only): embed the document's own images. */
async function inlineImages(html: string) {
  if (!html.includes('src="/api/file?')) return html;
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  let total = 0;
  for (const img of tpl.content.querySelectorAll<HTMLImageElement>('img[src^="/api/file?"]')) {
    try {
      const blob = await fetch(img.getAttribute("src")!).then((r) => (r.ok ? r.blob() : null));
      if (!blob || !blob.type.startsWith("image/") || (total += blob.size) > 16 * 1024 * 1024) continue;
      img.src = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(blob);
      });
    } catch { /* leave it out of the PDF */ }
  }
  return tpl.innerHTML;
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** No Chromium on the server: print the same HTML from a hidden frame (the dialog offers Save as PDF). */
function printHere(title: string, html: string) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
  frame.sandbox.add("allow-modals", "allow-same-origin");
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font:11pt/1.55 -apple-system,"Segoe UI",Arial,sans-serif;color:#16181d;margin:16mm}
    pre,code{font-family:Menlo,Consolas,monospace;font-size:9pt}pre{white-space:pre-wrap;background:#f6f7f9;padding:8pt;border-radius:4px}
    table{border-collapse:collapse}th,td{border:1px solid #d5d9e0;padding:4pt 6pt}img{max-width:100%}</style></head><body>${html}</body></html>`;
  frame.onload = () => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 60_000); };
  document.body.append(frame);
}

export function DownloadMenu({ path, name, kind, text }: { path: string; name: string; kind: Printable; text: string | null }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc, true); };
  }, [open]);

  const pdf = async () => {
    setOpen(false); setBusy(true); setError(null);
    try {
      const html = await source(path, kind, text);
      const res = await fetch("/api/pdf", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ html, name, title: name }) });
      if (res.status === 501) { printHere(name, html); return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      save(await res.blob(), `${base(name)}.pdf`);
    } catch (e: any) {
      setError(`Couldn't make the PDF: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };
  const ext = name.includes(".") ? `.${name.split(".").pop()}` : "original";

  return (
    <div className="split-btn" ref={box}>
      <button className="btn sm" onClick={pdf} disabled={busy} title="Download as PDF">{busy ? "Making PDF…" : "Download PDF"}</button>
      <button className="btn sm split-caret" aria-label="More download formats" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>▾</button>
      {open && (
        <div className="split-menu" role="menu">
          <button role="menuitem" onClick={pdf}>PDF <span className="hint">.pdf</span></button>
          <a role="menuitem" href={fileUrl(path, true)} onClick={() => setOpen(false)}>{kind === "markdown" ? "Markdown" : kind === "html" ? "HTML" : "Original"} <span className="hint">{ext}</span></a>
        </div>
      )}
      {error && <span className="split-error" role="alert">{error}</span>}
    </div>
  );
}
