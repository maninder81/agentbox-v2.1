import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Note } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, relTime } from "./ui.tsx";

/** A piece of work's notebook (notes.ts): any task in it gives the same notes. Live via notes.updated. */
export function useNotes(instanceId: string) {
  const { onEvent } = useStore();
  const [state, setState] = useState<{ room: string; notes: Note[] } | null>(null);
  useEffect(() => {
    let alive = true;
    let room = "";
    const load = () => api.notes(instanceId)
      .then((r) => { room = r.room_id; if (alive) setState({ room: r.room_id, notes: r.notes }); })
      .catch(() => { if (alive) setState((s) => s ?? { room: "", notes: [] }); });
    load();
    const off = onEvent((e) => { if (e.type === "notes.updated" && (!room || e.roomId === room)) load(); });
    return () => { alive = false; off(); };
  }, [instanceId, onEvent]);
  return state?.notes ?? null;
}

/** Plain text with its links clickable: notes are often a link an agent gave. */
function Linked({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g);
  return <>{parts.map((p, i) => i % 2 ? <a key={i} href={p} target="_blank" rel="noopener noreferrer">{p}</a> : p)}</>;
}

function Grow(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [props.value]);
  return <textarea ref={ref} rows={2} className="text note-input" {...props} />;
}

/** The Notes tab of a task's or room's panel: write a note, and read, edit, copy or delete the ones kept. */
export function NotesTab({ instanceId }: { instanceId: string }) {
  const notes = useNotes(instanceId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setError(null);
    try { await api.addNote(instanceId, { body: v }); setText(""); } catch (e: any) { setError(e.message); }
  };
  return (
    <div className="notes">
      <div className="note-new">
        <Grow value={text} placeholder="Write a note…" aria-label="New note" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }} />
        <div className="note-actions">
          <span className="hint">{error ? <span style={{ color: "var(--bad)" }}>{error}</span> : "Or select text in the chat to save it here"}</span>
          <button className="btn sm primary" disabled={!text.trim()} onClick={add} title="Add (⌘⏎)">Add</button>
        </div>
      </div>
      {!notes ? <p className="hint">Loading…</p>
        : !notes.length ? <p className="hint">No notes for this work yet.</p>
        : <ul className="note-list">{notes.map((n) => <NoteItem key={n.id} note={n} />)}</ul>}
    </div>
  );
}

function NoteItem({ note }: { note: Note }) {
  const { everyone } = useStore();
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(note.body);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!editing) setBody(note.body); }, [note.body, editing]);
  const who = note.author === "user" ? "You" : note.author?.startsWith("guest:") ? `${note.author.slice(6)} (guest)` : everyone.find((a) => a.id === note.author)?.name;
  const save = async () => {
    setError(null);
    try { await api.updateNote(note.id, body); setEditing(false); } catch (e: any) { setError(e.message); }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([note.quote, note.body].filter(Boolean).join("\n\n"));
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <li className="note">
      {note.quote && <blockquote className="note-quote"><Linked text={note.quote} /></blockquote>}
      {editing ? (
        <>
          <Grow value={body} autoFocus placeholder={note.quote ? "Your note (optional)" : "Note"} aria-label="Edit note"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
              if (e.key === "Escape") { e.stopPropagation(); setEditing(false); }
            }} />
          {error && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}
          <div className="note-actions">
            <span />
            <button className="btn sm ghost" onClick={() => setEditing(false)}>Cancel</button>
            <button className="btn sm primary" onClick={save}>Save</button>
          </div>
        </>
      ) : note.body ? <p className="note-body"><Linked text={note.body} /></p> : null}
      {!editing && (
        <div className="note-meta">
          <span className="hint">{note.quote && who ? `From ${who} · ` : ""}{relTime(note.created_at)}{note.updated_at !== note.created_at ? " · edited" : ""}</span>
          {confirm ? (
            <>
              <button className="btn sm danger" onClick={() => api.deleteNote(note.id).catch((e) => setError(e.message))}>Delete</button>
              <button className="btn sm ghost" onClick={() => setConfirm(false)}>Keep</button>
            </>
          ) : (
            <>
              <button className="icon-btn note-btn" title={copied ? "Copied" : "Copy"} aria-label="Copy note" onClick={copy}><Icon name={copied ? "check" : "copy"} size={14} /></button>
              <button className="icon-btn note-btn" title={note.body ? "Edit" : "Add a note"} aria-label="Edit note" onClick={() => setEditing(true)}><Icon name="edit" size={14} /></button>
              <button className="icon-btn note-btn" title="Delete" aria-label="Delete note" onClick={() => setConfirm(true)}><Icon name="x" size={14} /></button>
            </>
          )}
        </div>
      )}
    </li>
  );
}

type Picked = { text: string; messageId: string | null; author: string | null; x: number; y: number };

/**
 * Select text in the chat (anything inside a .timeline) and a "Save to notes" button appears above it;
 * it opens a small form for an optional note of your own, then saves both to the work's notebook.
 */
export function SaveSelection({ instanceId }: { instanceId: string }) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const [form, setForm] = useState(false);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const formOpen = useRef(false);
  formOpen.current = form;

  useEffect(() => {
    const check = () => {
      if (formOpen.current) return;
      const sel = window.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      const node = sel?.anchorNode;
      const el = node ? (node.nodeType === 1 ? node as Element : node.parentElement) : null;
      if (!text || !el?.closest(".chat .timeline") || !sel!.rangeCount) { setPicked(null); return; }
      const rect = sel!.getRangeAt(0).getBoundingClientRect();
      const msg = el.closest("[data-msg-id]") as HTMLElement | null;
      setPicked({
        text, messageId: msg?.dataset.msgId || null, author: msg?.dataset.author || null,
        x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90), y: Math.max(rect.top, 50),
      });
    };
    const later = () => setTimeout(check, 0);
    const onChange = () => { if (!formOpen.current && window.getSelection()?.isCollapsed) setPicked(null); };
    document.addEventListener("mouseup", later);
    document.addEventListener("keyup", later);
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("mouseup", later);
      document.removeEventListener("keyup", later);
      document.removeEventListener("selectionchange", onChange);
    };
  }, []);

  const close = () => { setForm(false); setPicked(null); setBody(""); setError(null); };
  const save = async () => {
    if (!picked) return;
    setState("saving"); setError(null);
    try {
      await api.addNote(instanceId, { quote: picked.text, body: body.trim(), message_id: picked.messageId ?? undefined, author: picked.author ?? undefined });
      setState("saved");
      window.getSelection()?.removeAllRanges();
      setTimeout(() => { setState("idle"); close(); }, 900);
    } catch (e: any) { setState("idle"); setError(e.message); }
  };

  if (!picked) return null;
  if (!form) {
    return (
      <button className="btn sm note-pick" style={{ left: picked.x, top: picked.y }}
        onMouseDown={(e) => e.preventDefault()} onClick={() => setForm(true)}>
        <Icon name="note" size={14} />Save to notes
      </button>
    );
  }
  return (
    <div className="popover note-form" role="dialog" aria-label="Save to notes"
      style={{ left: Math.min(Math.max(picked.x - 170, 12), window.innerWidth - 352), top: Math.min(Math.max(picked.y - 8, 12), window.innerHeight - 300) }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <strong>Save to notes</strong>
      <blockquote className="note-quote clamp">{picked.text}</blockquote>
      <Grow value={body} autoFocus placeholder="Add a note (optional)" aria-label="Your note"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }} />
      {error && <span className="hint" style={{ color: "var(--bad)" }}>{error}</span>}
      <div className="note-actions">
        <span className="hint">⌘⏎ to save</span>
        <button className="btn sm ghost" onClick={close}>Cancel</button>
        <button className="btn sm primary" disabled={state !== "idle"} onClick={save}>
          {state === "saved" ? <><Icon name="check" size={14} />Saved</> : state === "saving" ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
