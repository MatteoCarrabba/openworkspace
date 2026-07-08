import React, { useEffect } from "react";
import { useStore } from "../store";
import {
  STALE_MIN,
  fmtAge,
  fmtWhen,
  localRunPill,
  missBadge,
  overlapBadge,
  runPillClass,
} from "../automationsFormat";
import type { ScanAutomation } from "../types";

export function AutomationsView(): React.JSX.Element {
  const { view, autos, autosError, autosLoaded, ensureAutos, setView } = useStore();

  // Lazy-load: only fetch once this view is actually the active one.
  useEffect(() => {
    if (view.view === "automations") void ensureAutos();
  }, [view.view, ensureAutos]);

  if (!autosLoaded) return <div className="empty">Loading automations…</div>;
  if (!autos) return <div className="empty">Automations scan failed: {autosError}</div>;

  const driftN = autos.drift.length;
  const q = view.autoQuery.trim().toLowerCase();
  const list = autos.automations
    .filter((a) => (view.autoFilter === "drift" ? a.drift.length > 0 : true))
    .filter((a) => (q ? (a.name + " " + a.project.name + " " + a.project.relPath).toLowerCase().includes(q) : true));

  return (
    <>
      {autos.machines.length === 0 ? (
        <div className="empty">No machine registries published yet</div>
      ) : (
        <div className="machine-strip">
          {autos.machines.map((m) => {
            const stale = m.staleMinutes !== null && m.staleMinutes >= STALE_MIN;
            return (
              <div className="machine-card" key={m.machineId}>
                <div className="mid">{m.machineId}</div>
                <div className={"hb" + (m.staleMinutes === null ? "" : stale ? " stale" : " fresh")}>
                  published {fmtAge(m.staleMinutes)}
                </div>
                <div className="hb">
                  {m.activationCount} activation{m.activationCount === 1 ? "" : "s"}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="filter" style={{ margin: "0 0 12px", padding: 0, maxWidth: 320 }}>
        <label htmlFor="auto-search">Filter</label>
        <input
          type="search"
          id="auto-search"
          placeholder="Name or project…"
          value={view.autoQuery}
          onChange={(e) => setView({ autoQuery: e.target.value })}
        />
      </div>

      <div className="toggle-row" style={{ margin: "0 0 12px" }}>
        <label>
          <input
            type="checkbox"
            id="drift-only"
            checked={view.autoFilter === "drift"}
            onChange={(e) => setView({ autoFilter: e.target.checked ? "drift" : "all" })}
          />{" "}
          Drift only{driftN ? " (" + driftN + ")" : ""}
        </label>
      </div>

      {driftN ? (
        <div id="auto-drift-banner">
          {autos.drift.map((d, i) => (
            <div className="drift-line" key={i}>
              ⚠ {d.project + "/" + d.automation}: {d.detail}
            </div>
          ))}
        </div>
      ) : null}

      {list.length === 0 ? (
        <div className="empty">{view.autoFilter === "drift" ? "No placement drift" : "No automations defined"}</div>
      ) : (
        list.map((a) => <AutomationCard key={a.key} a={a} />)
      )}
    </>
  );
}

interface LogsResponse {
  name: string;
  runs: Array<{ machine: string; stamp: string }>;
  selected: { machine: string; stamp: string; content: string; truncated: boolean } | null;
}

/** Read-only viewer for an automation's per-run logs (GET /api/automation/logs). */
function LogsPanel({ project, name }: { project: string; name: string }): React.JSX.Element {
  const [data, setData] = React.useState<LogsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(
    (run?: { machine: string; stamp: string }) => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ project, name });
      if (run) {
        qs.set("machine", run.machine);
        qs.set("run", run.stamp);
      }
      fetch("/api/automation/logs?" + qs.toString())
        .then((r) =>
          r.ok ? r.json() : r.json().then((e: { error?: string }) => Promise.reject(new Error(e.error ?? String(r.status)))),
        )
        .then((d: LogsResponse) => {
          setData(d);
          setLoading(false);
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        });
    },
    [project, name],
  );

  React.useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) return <div className="logs-panel empty">Loading logs…</div>;
  if (error) return <div className="logs-panel empty">Log load failed: {error}</div>;
  if (!data || data.runs.length === 0) return <div className="logs-panel empty">No run logs recorded yet.</div>;

  const sel = data.selected;
  return (
    <div className="logs-panel">
      <div className="logs-runs">
        {data.runs
          .slice()
          .reverse()
          .map((r) => (
            <button
              key={r.machine + "/" + r.stamp}
              className={"logs-run" + (sel && sel.machine === r.machine && sel.stamp === r.stamp ? " sel" : "")}
              onClick={() => load(r)}
            >
              {r.machine} · {r.stamp}
            </button>
          ))}
      </div>
      {sel ? (
        <pre className="logview">
          {sel.truncated ? "… (older lines truncated) …\n\n" : ""}
          {sel.content}
        </pre>
      ) : (
        <div className="empty">Select a run.</div>
      )}
    </div>
  );
}

function AutomationCard({ a }: { a: ScanAutomation }): React.JSX.Element {
  const [showLogs, setShowLogs] = React.useState(false);
  const activeWhere = a.activatedOn.length ? a.activatedOn.join(", ") : <span style={{ color: "var(--muted)" }}>nowhere</span>;
  const declWhere = a.declaredMachines.length ? a.declaredMachines.join(", ") : "(none declared)";
  const local = localRunPill(a);
  const miss = missBadge(a);
  const overlap = overlapBadge(a);

  return (
    <div className={"auto-card" + (a.valid ? "" : " invalid")}>
      <h3>
        <span className="aname">{a.name}</span>
        {a.schedule ? <span className="sched">{a.schedule}</span> : null}
        {a.kind ? <span className="sched">kind {a.kind}</span> : null}
        {miss ? <span className="sched">{miss}</span> : null}
        {overlap ? <span className="sched">{overlap}</span> : null}
        <span className={"pill " + local.cls} title={local.title}>
          {local.label}
        </span>
        {a.valid ? null : (
          <span className="sched" style={{ background: "#fdebeb", color: "var(--error)" }}>
            invalid manifest
          </span>
        )}
        <span className="ameta">
          {a.project.name} · {a.project.lifecycle} · active on {activeWhere} · declared {declWhere}
        </span>
      </h3>
      <div className="auto-body">
        {a.machines.length === 0 ? (
          <div className="mrow">
            <span style={{ color: "var(--muted)" }}>no declared or activating machine</span>
          </div>
        ) : (
          a.machines.map((m) => {
            let stateLabel: React.ReactNode;
            if (m.activated && m.declared) stateLabel = <span className="pill active">active</span>;
            else if (m.activated && !m.declared) stateLabel = <span className="pill drift">activated · undeclared</span>;
            else if (!m.activated && m.declared) stateLabel = <span className="pill drift">declared · not active</span>;
            else stateLabel = <span className="pill declared">—</span>;
            const lr = m.lastRun;
            const run = runPillClass(lr);
            const when = lr ? fmtWhen(lr.finishedAt || lr.startedAt) : "";
            const stale = m.staleMinutes !== null && m.staleMinutes >= STALE_MIN;
            return (
              <div className="mrow" key={m.machineId}>
                <span className="mname">{m.machineId}</span>
                <span>{stateLabel}</span>
                <span className="when">
                  <span className={"pill " + run.cls}>{run.label}</span>
                  {when ? <span className="when"> · {when}</span> : null}
                </span>
                <span className={"hbcol" + (stale ? " stale" : "")}>{fmtAge(m.staleMinutes)}</span>
              </div>
            );
          })
        )}
      </div>
      {a.drift.map((d, i) => (
        <div className="drift-line" key={i}>
          ⚠ {d.detail}
        </div>
      ))}
      {a.problems.length ? (
        <ul className="auto-problems">
          {a.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
      <div className="auto-actions">
        <button className="logs-toggle" onClick={() => setShowLogs((v) => !v)} aria-expanded={showLogs}>
          {showLogs ? "▾ logs" : "▸ logs"}
        </button>
      </div>
      {showLogs ? <LogsPanel project={a.project.uid} name={a.name} /> : null}
    </div>
  );
}
