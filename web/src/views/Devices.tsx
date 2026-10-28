import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { api, type Device, type GatewayStatus, type Pairing } from "../api.ts";
import { useStore } from "../store.tsx";

/**
 * Paired phones (docs/MOBILE-PROTOCOL.md): show a single-use QR code, approve the phone after
 * comparing fingerprints, revoke it later. Only works with the portal opened on localhost.
 */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const hostOf = (url: string) => {
  try { return new URL(url).host; } catch { return url; }
};

const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Qr({ payload }: { payload: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    QRCode.toString(payload, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 216, color: { dark: "#000000", light: "#ffffff" } })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(null));
    return () => { alive = false; };
  }, [payload]);
  // Generated locally from our own payload; always dark on white so phones can scan it in dark mode.
  return (
    <div role="img" aria-label="Pairing QR code" style={{ width: 232, height: 232, background: "#fff", borderRadius: "var(--r-card)", padding: 8 }}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
  );
}

function PairPhone({ pending, onChange }: { pending: Device[]; onChange: () => void }) {
  const [pairing, setPairing] = useState<(Pairing & { started: number }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(!!pairing);
  const live = useRef(false);
  live.current = !!pairing;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await api.newPairing();
      setPairing({ ...p, started: Date.now() });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  // Leaving the page burns the code still on screen.
  useEffect(() => () => { if (live.current) api.cancelPairing().catch(() => {}); }, []);

  // Once a phone claims the code it's useless: hide it and point at the pending device.
  const claimed = pairing && pending.some((d) => new Date(d.created_at).getTime() >= pairing.started - 5000);
  useEffect(() => {
    if (claimed) {
      setPairing(null);
      onChange();
    }
  }, [claimed]);

  const left = pairing ? new Date(pairing.expires_at).getTime() - now : 0;
  const expired = pairing && left <= 0;

  return (
    <>
      <h2>Pair a phone</h2>
      {!pairing && (
        <div className="field" style={{ alignItems: "flex-start" }}>
          <span className="hint">Open the agentbox app on your phone and scan the code. Each code works once, for 2 minutes.</span>
          <button className="btn primary" disabled={busy} onClick={start}>Pair a phone</button>
          {error && <div className="error-box">{error}</div>}
        </div>
      )}
      {pairing && (
        <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ opacity: expired ? 0.15 : 1 }}><Qr payload={pairing.qr_payload} /></div>
          <div className="field" style={{ minWidth: 220, flex: 1 }}>
            {expired ? <strong>This code has expired.</strong> : <span>Expires in <strong className="mono">{mmss(left)}</strong></span>}
            <span>The app will ask you to confirm: <strong className="mono">{hostOf(pairing.url)}</strong></span>
            <span className="hint">Check that it's this address before you continue on the phone.</span>
            <span className="hint">After scanning, the phone shows a fingerprint. It appears below under Waiting for approval; approve it only if they match.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn sm" disabled={busy} onClick={start}>Regenerate</button>
              <button className="btn sm ghost" onClick={() => { setPairing(null); api.cancelPairing().catch(() => {}); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PendingList({ devices, onChange }: { devices: Device[]; onChange: () => void }) {
  const now = useNow(devices.length > 0);
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); }
    onChange();
  };
  if (!devices.length) return null;
  return (
    <>
      <h2>Waiting for approval</h2>
      <div className="rows">
        {devices.map((d) => (
          <div key={d.id} className="row" style={{ flexWrap: "wrap" }}>
            <div className="field" style={{ gap: 2, flex: 1, minWidth: 220 }}>
              <strong>{d.name}</strong>
              <span className="mono" style={{ fontSize: 16, letterSpacing: 1 }}>{d.fingerprint}</span>
              <span className="hint">
                {d.tailnet_login ? `Tailnet user ${d.tailnet_login} · ` : ""}
                {d.expires_at ? `expires in ${mmss(new Date(d.expires_at).getTime() - now)}` : ""}
              </span>
            </div>
            <button className="btn sm primary" onClick={act(() => api.approveDevice(d.id))}>Approve</button>
            <button className="btn sm danger" onClick={act(() => api.denyDevice(d.id))}>Deny</button>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 8 }}>Approve only if this fingerprint matches the one on your phone exactly.</p>
      {error && <div className="error-box">{error}</div>}
    </>
  );
}

function PairedList({ devices, onChange }: { devices: Device[]; onChange: () => void }) {
  const [confirm, setConfirm] = useState<string | null>(null); // a device id, or "all"
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const test = (d: Device) => async () => {
    setError(null);
    setTested(null);
    try {
      await api.testPush(d.id);
      setTested(`Test notification sent to ${d.name}.`);
    } catch (e: any) {
      setError(e.message);
      onChange();
    }
  };
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try { await fn(); } catch (e: any) { setError(e.message); }
    setConfirm(null);
    onChange();
  };
  return (
    <>
      <h2>Paired phones</h2>
      {devices.length === 0 ? <p className="hint">No phones paired.</p> : (
        <div className="rows">
          {devices.map((d) => (
            <div key={d.id} className="row" style={{ flexWrap: "wrap" }}>
              <div className="field" style={{ gap: 2, flex: 1, minWidth: 220 }}>
                <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{d.name}</strong>
                  <span className="status" title={d.push ? "This phone receives notifications" : "The app hasn't turned on notifications"}>
                    <span className={`dot ${d.push ? "ok" : ""}`} />Notifications: {d.push ? "on" : "off"}
                  </span>
                </span>
                <span className="mono hint">{d.fingerprint}</span>
                <span className="hint">
                  {d.app_version ? `App ${d.app_version} · ` : ""}{d.tailnet_login ? `${d.tailnet_login} · ` : ""}
                  paired {when(d.approved_at)} · last seen {when(d.last_seen_at)}
                </span>
              </div>
              {d.push && confirm !== d.id && <button className="btn sm ghost" onClick={test(d)}>Send test notification</button>}
              {confirm === d.id ? (
                <>
                  <button className="btn sm danger" onClick={act(() => api.revokeDevice(d.id))}>Revoke {d.name}</button>
                  <button className="btn sm ghost" onClick={() => setConfirm(null)}>Cancel</button>
                </>
              ) : <button className="btn sm" onClick={() => setConfirm(d.id)}>Revoke</button>}
            </div>
          ))}
        </div>
      )}
      {devices.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
          {confirm === "all" ? (
            <>
              <span className="hint">Every phone is signed out at once and must be paired again.</span>
              <button className="btn sm danger" onClick={act(() => api.revokeAllDevices())}>Revoke all</button>
              <button className="btn sm ghost" onClick={() => setConfirm(null)}>Cancel</button>
            </>
          ) : <button className="btn sm danger" onClick={() => setConfirm("all")}>Revoke all</button>}
        </div>
      )}
      {tested && <p className="hint" style={{ marginTop: 8 }}>{tested}</p>}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

function Notifications() {
  const [details, setDetails] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.pushSettings().then((s) => setDetails(s.details)).catch((e) => setError(e.message)); }, []);
  // Flip at once and lock while saving: a slow server used to leave the box unchanged, and a second
  // click then saved the opposite of what was meant.
  const toggle = async (on: boolean) => {
    if (saving) return;
    const before = details;
    setError(null); setSaved(false); setDetails(on); setSaving(true);
    try { setDetails((await api.setPushDetails(on)).details); setSaved(true); setTimeout(() => setSaved(false), 2500); }
    catch (e: any) { setDetails(before); setError(e.message); }
    finally { setSaving(false); }
  };
  return (
    <>
      <h2>Notifications</h2>
      <p className="hint">
        Phones that turned on notifications are told when something needs you. By default a notification
        only says <em>Something needs you</em>; open the app to see what.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
        <input type="checkbox" checked={!!details} disabled={details === null || saving} onChange={(e) => toggle(e.target.checked)} />
        Show details in notifications
        {saving && <span className="hint">Saving…</span>}
        {saved && <span className="hint">Saved</span>}
      </label>
      <p className="hint" style={{ marginTop: 4 }}>
        Off by default. When on, notifications include a short title such as "tech-lead replied: Partner API keys". That text
        passes through Expo's and Google's push services and shows on the lock screen.
      </p>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </>
  );
}

function Row({ ok, word, name, val }: { ok: boolean | null; word: string; name: string; val?: string | null }) {
  return (
    <div className="row">
      <span className="status" style={{ minWidth: 84 }}><span className={`dot ${ok === null ? "" : ok ? "ok" : "bad"}`} />{word}</span>
      <span className="name">{name}</span>
      <span className="val">{val}</span>
    </div>
  );
}

function Gateway({ status, onChange }: { status: GatewayStatus | null; onChange: (s: GatewayStatus) => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setUrl(status?.manual_url ?? ""), [status?.manual_url]);
  if (!status) return null;
  const ts = status.tailscale;
  const running = ts.backend_state === "Running";
  const expected = `http://127.0.0.1:${status.port}`;
  return (
    <>
      <h2>Gateway</h2>
      {ts.funnel && (
        <div className="error-box" style={{ marginBottom: 10 }}>
          Tailscale Funnel is ON: the gateway is reachable from the public internet. Turn it off now: <code>sudo tailscale funnel reset</code>
        </div>
      )}
      {ts.funnel_capable && (
        <div className="error-box" style={{ marginBottom: 10 }}>
          Your tailnet policy lets this machine use Funnel. Remove the <code>funnel</code> node attribute for it
          (Access controls › nodeAttrs) so Funnel can't be switched on here.
        </div>
      )}
      {ts.installed && status.guard.present === false && (
        <div className="error-box" style={{ marginBottom: 10 }}>
          The tailnet firewall isn't loaded ({status.guard.detail}): other services in the VM may be reachable from your tailnet.
          Run <code>scripts/install-units.sh</code> on the Mac.
        </div>
      )}
      <div className="rows">
        <Row ok={ts.installed} word={ts.installed ? "Installed" : "Missing"} name="Tailscale" val={ts.installed ? null : "run scripts/mobile-setup.sh"} />
        {ts.installed && <Row ok={running} word={running ? "Up" : ts.backend_state ?? "Unknown"} name="Tailnet connection" val={ts.dns_name} />}
        {ts.installed && (
          <Row ok={ts.serve_target === expected} word={ts.serve_target ? (ts.serve_target === expected ? "Serving" : "Mismatch") : "Off"}
            name="tailscale serve :443" val={ts.serve_target ?? `expected ${expected}`} />
        )}
        {ts.installed && <Row ok={ts.funnel === null ? null : !ts.funnel} word={ts.funnel === null ? "Unknown" : ts.funnel ? "ON" : "Off"} name="Funnel (must stay off)" />}
        {ts.installed && (
          <Row ok={ts.funnel_capable === null ? null : !ts.funnel_capable} word={ts.funnel_capable === null ? "Unknown" : ts.funnel_capable ? "Allowed" : "Not allowed"}
            name="Funnel capability (policy)" />
        )}
        <Row ok={status.guard.present === null ? null : status.guard.present || !ts.installed}
          word={status.guard.present === null ? "Unknown" : status.guard.present ? "Loaded" : ts.installed ? "Missing" : "Not loaded"}
          name="Tailnet firewall" val={status.guard.present ? null : status.guard.detail} />
        <Row ok={!!status.url} word={status.url ? "Set" : "None"} name="Phone URL" val={status.url} />
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        Phones reach agentbox only over your tailnet. Funnel must stay off, and your tailnet ACL should let only your own devices reach this machine on port 443.
      </p>
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="gw-url">Manual URL</label>
        <span className="hint">Only needed if Tailscale can't report its address. Used when the tailnet name isn't available.</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="gw-url" className="text" placeholder="https://agentbox.example.ts.net" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" onClick={async () => {
            setError(null);
            try { onChange(await api.setGatewayUrl(url)); } catch (e: any) { setError(e.message); }
          }}>Save</button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    </>
  );
}

export function Devices() {
  // Without the phone gateway module none of /api/devices exists: say so, and offer to set it up.
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { api.publicConfig().then((c) => setOn(!!c.modules.mobile)).catch(() => setOn(true)); }, []);
  if (on === null) return <div className="page" />;
  if (!on) return <PhoneAppOff />;
  return <DevicesOn />;
}

function PhoneAppOff() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setUp = async () => {
    setBusy(true); setError(null);
    try { location.hash = `#/helper/${(await api.integrationTask("mobile", "connect")).instance_id}`; }
    catch (e: any) { setError(e.message); setBusy(false); }
  };
  return (
    <div className="page">
      <div className="page-inner">
        <h1>Devices</h1>
        <p className="lede">Phones that can reach agentbox through the mobile app, over your tailnet only.</p>
        <div className="group-intro">
          <p>The phone app isn't set up on this agentbox (the phone gateway is off). The helper sets it up with you: the gateway, then pairing your phone here.</p>
          {error && <div className="error-box">{error}</div>}
          <button className="btn primary" disabled={busy} onClick={setUp}>Set up the phone app with the helper</button>
        </div>
      </div>
    </div>
  );
}

function DevicesOn() {
  const { devicesVersion } = useStore();
  const [devices, setDevices] = useState<{ pending: Device[]; active: Device[] } | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.devices().then((d) => { setDevices(d); setError(null); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [devicesVersion]);
  // Pending devices expire on the server without an event; poll gently as a fallback.
  useEffect(() => {
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    api.gateway(true).then(setGateway).catch(() => {});
    const t = setInterval(() => api.gateway().then(setGateway).catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="page">
      <div className="page-inner">
        <h1>Devices</h1>
        <p className="lede">Phones that can reach agentbox through the mobile app, over your tailnet only.</p>
        {error && <div className="error-box">{error}</div>}
        <PairPhone pending={devices?.pending ?? []} onChange={load} />
        <PendingList devices={devices?.pending ?? []} onChange={load} />
        <PairedList devices={devices?.active ?? []} onChange={load} />
        <Notifications />
        <Gateway status={gateway} onChange={setGateway} />
      </div>
    </div>
  );
}
