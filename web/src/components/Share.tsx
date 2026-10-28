import { useEffect, useState } from "react";
import { api, type ShareExpiry, type WorkShare } from "../api.ts";
import { useStore } from "../store.tsx";
import { Icon, relTime } from "./ui.tsx";

/** Links to this work for guests (shares.ts). Live via shares.updated. */
function useShares(roomId: string) {
  const { onEvent } = useStore();
  const [state, setState] = useState<{ shares: WorkShare[]; ready: boolean; missing: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.shares(roomId).then((d) => { if (alive) setState(d); }).catch(() => {});
    load();
    const off = onEvent((e) => { if (e.type === "shares.updated" && e.roomId === roomId) load(); });
    return () => { alive = false; off(); };
  }, [roomId, onEvent]);
  return state;
}

const EXPIRIES: [ShareExpiry, string][] = [["6h", "6 hours"], ["1d", "1 day"], ["7d", "1 week"]];
const until = (iso: string) => {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return "expired";
  const h = ms / 3600_000;
  return h < 1 ? `${Math.ceil(ms / 60_000)} min left` : h < 48 ? `${Math.round(h)} h left` : `${Math.round(h / 24)} days left`;
};

/** A header button: share this one piece of work with someone outside your tailnet. */
export function ShareButton({ roomId }: { roomId: string }) {
  const data = useShares(roomId);
  const [open, setOpen] = useState(false);
  const live = data?.shares.filter((s) => s.live) ?? [];
  return (
    <div className="popover-anchor">
      <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}
        title="Share this work with someone outside your tailnet: a link that expires, read-only or able to chat">
        <Icon name="plug" size={14} />Share{live.length ? <span className="tab-count">{live.length}</span> : null}
      </button>
      {open && data && <SharePanel roomId={roomId} data={data} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SharePanel({ roomId, data, onClose }: { roomId: string; data: { shares: WorkShare[]; ready: boolean; missing: string | null }; onClose: () => void }) {
  const [perm, setPerm] = useState<"read" | "edit">("read");
  const [expiry, setExpiry] = useState<ShareExpiry>("1d");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; share: WorkShare } | null>(null);
  const [copied, setCopied] = useState(false);
  const live = data.shares.filter((s) => s.live);

  const setUp = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.integrationTask("ngrok", "connect");
      location.hash = `#/helper/${r.instance_id}`;
    } catch (e: any) { setError(e.message); setBusy(false); }
  };
  const make = async () => {
    setBusy(true); setError(null); setCopied(false);
    try { setMade(await api.createShare(roomId, { perm, expiry, label: label.trim() || undefined })); setLabel(""); }
    catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const copy = async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <div className="popover share-panel" role="dialog" aria-label="Share this work" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <strong>Share this work</strong>
      {!data.ready ? (
        <>
          <p className="hint" style={{ margin: 0 }}>
            Sharing with someone outside your tailnet goes through an ngrok tunnel, which isn't set up yet ({data.missing}).
            The helper sets it up with you: you'll need a free ngrok account.
          </p>
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary sm" disabled={busy} onClick={setUp}>Set up ngrok with the helper</button>
        </>
      ) : made ? (
        <>
          <p className="hint" style={{ margin: 0 }}>
            {made.share.perm === "edit" ? "Can chat with the agents" : "Read-only"} link for <strong>{made.share.label}</strong>, {until(made.share.expires_at)}.
            Copy it now: it's shown only once.
          </p>
          <div className="share-url"><code>{made.url}</code></div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary sm" onClick={() => copy(made.url)}><Icon name="copy" size={14} />{copied ? "Copied" : "Copy link"}</button>
            <button className="btn sm" onClick={() => setMade(null)}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p className="hint" style={{ margin: 0 }}>
            Anyone with the link sees only this work: its conversation, live progress, roadmap, documents, notes and hosted services.
            Nothing else of agentbox.
          </p>
          <div className="share-perms" role="radiogroup" aria-label="Access">
            <label className={`share-perm${perm === "read" ? " on" : ""}`}>
              <input type="radio" name="perm" checked={perm === "read"} onChange={() => setPerm("read")} />
              <span><strong>Read</strong><span className="hint">Follows along live. Can't send anything.</span></span>
            </label>
            <label className={`share-perm${perm === "edit" ? " on" : ""}`}>
              <input type="radio" name="perm" checked={perm === "edit"} onChange={() => setPerm("edit")} />
              <span><strong>Chat</strong><span className="hint">Can also message the agents, attach files and stop them, so they act on this person's word in this work.</span></span>
            </label>
          </div>
          <div className="segmented" role="group" aria-label="Expires after">
            {EXPIRIES.map(([k, l]) => <button key={k} aria-pressed={expiry === k} onClick={() => setExpiry(k)}>{l}</button>)}
          </div>
          <input className="text" placeholder="Who it's for (optional, shown to the agents)" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Who it's for" />
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary sm" disabled={busy} onClick={make}>{busy ? "Starting the tunnel…" : "Create link"}</button>
        </>
      )}
      {live.length > 0 && (
        <>
          <span className="hint share-live-head">Live links</span>
          <ul className="share-list">
            {live.map((s) => (
              <li key={s.id}>
                <span className="share-list-text">
                  <span>{s.label} · {s.perm === "edit" ? "can chat" : "read-only"}</span>
                  <span className="hint">{until(s.expires_at)} · {s.last_seen_at ? `opened ${relTime(s.last_seen_at)}` : "not opened yet"}</span>
                </span>
                <button className="btn ghost sm" onClick={() => api.revokeShare(s.id).catch((e) => setError(e.message))}>Turn off</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
