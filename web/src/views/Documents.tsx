import { useEffect, useRef, useState } from "react";
import { api, fileUrl, type Agent, type DocumentInfo } from "../api.ts";
import { Icon, Markdown, relTime } from "../components/ui.tsx";
import { DownloadMenu } from "../components/DownloadMenu.tsx";

const CODE = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "java", "kt", "rb", "php", "sh", "bash", "zsh",
  "sql", "json", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "xml", "css", "scss", "dockerfile", "tf", "lock", "log", "diff", "patch"];
const kindOf = (name: string) => {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : name.toLowerCase();
  if (["md", "markdown", "mdx"].includes(ext)) return "markdown";
  if (["txt", "rst", "adoc", "csv", "tsv"].includes(ext) || CODE.includes(ext) || ["makefile", "dockerfile", "readme"].includes(ext)) return "text";
  if (ext === "pdf") return "pdf";
  if (["html", "htm"].includes(ext)) return "html";
  if (["png", "jpg", "jpeg", "svg"].includes(ext)) return "image";
  return "other";
};

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function AgentDocuments({ agent }: { agent: Agent }) {
  const [docs, setDocs] = useState<DocumentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<DocumentInfo | null>(null);

  const load = () => api.documents(agent.id).then((d) => { setDocs(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // pick up documents written while you watch
    return () => clearInterval(t);
  }, [agent.id]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="hint" style={{ marginRight: "auto" }}>
          Documents {agent.name} wrote, newest first.
        </span>
        <button className="icon-btn" onClick={load} aria-label="Refresh" title="Refresh"><Icon name="refresh" size={14} /></button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {docs && docs.length === 0 && (
        <p className="hint">
          No documents yet. When {agent.name} writes a plan, requirements or a report, it saves it in its <span className="mono">docs/</span> folder
          and it shows up here.
        </p>
      )}
      {docs && docs.length > 0 && (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.path}>
              <button className="doc-row" onClick={() => setOpen(d)} title={d.path}>
                <span className={`doc-badge ${kindOf(d.name)}`}>{d.name.split(".").pop()?.slice(0, 4)}</span>
                <span className="doc-text">
                  <span className="doc-name">{d.name}</span>
                  <span className="hint">{d.location} · {relTime(d.modified)} · {size(d.size)}</span>
                  {d.task_title && <span className="hint doc-task">from “{d.task_title}”</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && <DocumentReader doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}

type ReaderDoc = Pick<DocumentInfo, "path"> & Partial<DocumentInfo>;

/** Open a file someone linked to: look up its details first, then show the reader. */
export function LinkedFileReader({ path, onClose }: { path: string; onClose: () => void }) {
  const [doc, setDoc] = useState<ReaderDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.fileInfo(path).then((d) => setDoc(d)).catch((e) => setError(e.message));
  }, [path]);
  if (error) return <DocumentReader doc={{ path, name: path.split("/").pop() }} error={error} onClose={onClose} />;
  return doc ? <DocumentReader doc={doc} onClose={onClose} /> : null;
}

export function DocumentReader({ doc, onClose, error: initialError }: { doc: ReaderDoc; onClose: () => void; error?: string }) {
  const name = doc.name ?? doc.path.split("/").pop() ?? doc.path;
  const kind = initialError ? "none" : kindOf(name);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", esc, true);
    return () => document.removeEventListener("keydown", esc, true);
  }, [onClose]);

  useEffect(() => {
    if (kind !== "markdown" && kind !== "text") return;
    if ((doc.size ?? 0) > 2 * 1024 * 1024) { setError("This file is too large to preview. Download it instead."); return; }
    fetch(fileUrl(doc.path)).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
      setText(await r.text());
    }).catch((e) => setError(e.message));
  }, [doc.path]);

  return (
    <div className="reader-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="reader" role="dialog" aria-modal="true" aria-label={name}>
        <header className="reader-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <strong className="reader-title">{name}</strong>
            <span className="hint mono reader-path">{doc.path}</span>
          </div>
          {doc.modified && <span className="hint" style={{ whiteSpace: "nowrap" }}>{relTime(doc.modified)} · {size(doc.size ?? 0)}</span>}
          {!initialError && <a className="btn sm" href={fileUrl(doc.path)} target="_blank" rel="noopener">Open in new tab</a>}
          {!initialError && (kind === "markdown" || kind === "text" || kind === "html"
            ? <DownloadMenu path={doc.path} name={name} kind={kind} text={kind === "html" ? null : text} />
            : <a className="btn sm" href={fileUrl(doc.path, true)}>Download</a>)}
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </header>
        <div className="reader-body">
          {error && <div className="error-box">{error}</div>}
          {kind === "markdown" && text !== null && <div className="reader-prose"><Markdown text={text} base={doc.path.slice(0, doc.path.lastIndexOf("/"))} /></div>}
          {kind === "text" && text !== null && <pre className="reader-pre">{text}</pre>}
          {(kind === "markdown" || kind === "text") && text === null && !error && <p className="hint">Loading…</p>}
          {kind === "pdf" && <iframe className="reader-frame" src={fileUrl(doc.path)} title={name} />}
          {kind === "html" && <iframe className="reader-frame light" src={fileUrl(doc.path)} title={name} sandbox="" />}
          {kind === "image" && <img className="reader-img" src={fileUrl(doc.path)} alt={name} />}
          {kind === "other" && (
            <div className="group-intro">
              <p>No preview for this file type.</p>
              <a className="btn sm" style={{ justifySelf: "start" }} href={fileUrl(doc.path, true)}>Download {name}</a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
