import { useEffect, useState } from "react";
import { api, type GroupWorkspace } from "../api.ts";
import { useStore } from "../store.tsx";
import { StatusGlyph, relTime } from "./ui.tsx";

/** A group's workspaces (groupWork.ts) and its lead's instance (whose roadmap is the group's). Live. */
export function useGroupWorkspaces(groupId: string) {
  const { onEvent } = useStore();
  const [data, setData] = useState<{ lead_instance_id: string | null; workspaces: GroupWorkspace[] } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.groupWorkspaces(groupId).then((d) => { if (alive) setData(d); }).catch(() => { if (alive) setData((x) => x ?? { lead_instance_id: null, workspaces: [] }); });
    load();
    const off = onEvent((e) => {
      if ((e.type === "group.workspaces" && e.groupId === groupId) || e.type === "roadmap.updated" || e.type === "agent.retired") load();
    });
    return () => { alive = false; off(); };
  }, [groupId, onEvent]);
  return data;
}

const STEP: Record<string, string> = { doing: "In progress", blocked: "Waiting on the group lead", done: "Done", todo: "Not started", skipped: "Skipped" };

/** The workspaces a group's lead launched: each one's lead, state, roadmap and any question waiting. */
export function GroupWorkspaceList({ workspaces }: { workspaces: GroupWorkspace[] }) {
  if (!workspaces.length) {
    return <p className="hint">No workspaces yet. Ask the group's lead to launch one per item (e.g. "launch a workspace for each of these").</p>;
  }
  const live = workspaces.filter((w) => w.lead && w.lead.status !== "done");
  const done = workspaces.filter((w) => !w.lead || w.lead.status === "done");
  const row = (w: GroupWorkspace) => (
    <li key={w.id}>
      <a className="row task-line" href={`#/work/${w.root_id}`}>
        {w.lead?.status === "done"
          ? <span className="status"><span className="glyph" style={{ borderColor: "var(--ok)", background: "var(--ok)" }} /></span>
          : <StatusGlyph status={(w.lead?.status ?? "idle") as any} />}
        <span className="task-line-main">
          <span>{w.title}</span>
          <span className="hint">
            {w.lead?.name ?? "deleted"} · {w.step ? STEP[w.step] ?? w.step : "—"}
            {w.roadmaps.map((m) => ` · ${m.done}/${m.total} steps${m.blocked ? `, ${m.blocked} blocked` : ""}`).join("")}
            {w.lead?.current ? ` · ${w.lead.current}` : ""} · {relTime(w.created_at)}
          </span>
          {w.question && <span className="hint gw-question">Asks: {w.question}</span>}
        </span>
      </a>
    </li>
  );
  return (
    <>
      <ul className="rows gw-list">{live.map(row)}</ul>
      {done.length > 0 && <><p className="hint" style={{ margin: "8px 0 0" }}>Done</p><ul className="rows gw-list">{done.map(row)}</ul></>}
    </>
  );
}
