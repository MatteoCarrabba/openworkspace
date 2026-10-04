import React, { useState } from "react";
import { useStore } from "../store";
import { revealProject } from "../api";
import { buildTaskTree, taskMatchesFilters } from "../taskTree";
import { TaskBranch } from "./TaskBranch";
import type { ScanMapEntry, ScanProject, ViewState } from "../types";

/** Where one kind of information lives — a link when the home is a URL. */
function MapHome({ e }: { e: ScanMapEntry }): React.JSX.Element {
  const label = e.label;
  if (e.kind === "external") {
    const name = e.system ?? (e.path !== null ? "local path" : "external");
    const detail = e.locator ?? e.path;
    const text = name + (detail !== null ? " · " + detail : "");
    return (
      <span className="map-home external" title={label + ": " + text}>
        <span className="map-label">{label}</span>{" "}
        {e.url !== null ? (
          <a href={e.url} target="_blank" rel="noopener noreferrer">
            {text} ↗
          </a>
        ) : (
          <span>{text}</span>
        )}
      </span>
    );
  }
  const text = e.kind === "native" ? "native" : e.kind === "none" ? "not used" : "undeclared";
  return (
    <span className={"map-home " + e.kind} title={label + ": " + text}>
      <span className="map-label">{label}</span> {text}
    </span>
  );
}

function MapStrip({ map }: { map: ScanMapEntry[] }): React.JSX.Element {
  return (
    <div className="map-strip" aria-label="Where information lives">
      {map.map((e) => (
        <MapHome key={e.key} e={e} />
      ))}
    </div>
  );
}

export function ProjectCard({ p, st }: { p: ScanProject; st: ViewState }): React.JSX.Element {
  const { collapsedProjects, toggleProjectCollapsed } = useStore();
  const collapsed = collapsedProjects.has(p.uid);
  const [revealErr, setRevealErr] = useState<string | null>(null);

  const reveal = async (target: "finder" | "obsidian"): Promise<void> => {
    setRevealErr(null);
    const r = await revealProject(p.uid, target);
    if (!r.ok) setRevealErr(r.error);
  };

  const visible = p.tasks.filter((t) => !t.hidden && taskMatchesFilters(p, t, st));
  const open = visible.filter((t) => t.status !== "done");
  const done = visible.filter((t) => t.status === "done");
  const hiddenN = p.taskCounts.hidden;
  const summary = visible.length
    ? open.length + " open" + (done.length ? " · " + done.length + " done" : "")
    : "0 visible";

  const tasksHome = p.map?.find((e) => e.key === "tasks") ?? null;
  const tasksElsewhere = tasksHome !== null && tasksHome.kind === "external";

  const openTree = buildTaskTree(open);
  const doneTree = buildTaskTree(done);

  return (
    <section className={"project" + (collapsed ? " collapsed" : "")}>
      <h2>
        <button
          className="project-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "Expand project" : "Collapse project"}
          onClick={(e) => {
            e.stopPropagation();
            toggleProjectCollapsed(p.uid);
          }}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span className="project-name">{p.name}</span>
        <span className="lifecycle-tag">{p.lifecycle}</span>
        {p.form === "map-only" ? (
          <span className="lifecycle-tag map-only-tag" title="No _project/ folder: this project's map lives in its README/AGENTS.md block">
            map-only
          </span>
        ) : null}
        <span className="meta">
          {p.relPath}
          {hiddenN ? " · " + hiddenN + " hidden" : ""}
        </span>
        <span className="project-summary">{summary}</span>
        <span className="project-reveal">
          <button
            className="reveal-btn"
            title="Reveal in Finder"
            onClick={(e) => {
              e.stopPropagation();
              void reveal("finder");
            }}
          >
            Reveal
          </button>
          {p.hasObsidianVault ? (
            <button
              className="reveal-btn"
              title="Open in Obsidian"
              onClick={(e) => {
                e.stopPropagation();
                void reveal("obsidian");
              }}
            >
              Obsidian
            </button>
          ) : null}
          {revealErr ? (
            <span className="reveal-err" role="status" title={revealErr}>
              !
            </span>
          ) : null}
        </span>
      </h2>
      {!collapsed && p.map ? <MapStrip map={p.map} /> : null}
      {collapsed ? null : visible.length === 0 ? (
        tasksElsewhere && tasksHome ? (
          <div className="empty">
            Tasks live in{" "}
            {tasksHome.url !== null ? (
              <a href={tasksHome.url} target="_blank" rel="noopener noreferrer">
                {tasksHome.system ?? tasksHome.url} ↗
              </a>
            ) : (
              (tasksHome.system ?? "an external system") + (tasksHome.locator ? " · " + tasksHome.locator : "")
            )}
          </div>
        ) : (
          <div className="empty">No visible tasks</div>
        )
      ) : (
        <>
          {open.length ? (
            <TaskBranch p={p} tasks={openTree.roots} st={st} childrenById={openTree.childrenById} />
          ) : null}
          {done.length ? (
            st.status === "done" ? (
              <TaskBranch p={p} tasks={doneTree.roots} st={st} childrenById={doneTree.childrenById} />
            ) : (
              <details className="done-group">
                <summary>Done ({done.length})</summary>
                <TaskBranch p={p} tasks={doneTree.roots} st={st} childrenById={doneTree.childrenById} />
              </details>
            )
          ) : null}
        </>
      )}
    </section>
  );
}
