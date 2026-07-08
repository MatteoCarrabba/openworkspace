import React from "react";
import { useStore } from "../store";
import { buildTaskTree, taskMatchesFilters } from "../taskTree";
import { TaskBranch } from "./TaskBranch";
import type { ScanProject, ViewState } from "../types";

export function ProjectCard({ p, st }: { p: ScanProject; st: ViewState }): React.JSX.Element {
  const { collapsedProjects, toggleProjectCollapsed } = useStore();
  const collapsed = collapsedProjects.has(p.uid);

  const visible = p.tasks.filter((t) => !t.hidden && taskMatchesFilters(p, t, st));
  const open = visible.filter((t) => t.status !== "done");
  const done = visible.filter((t) => t.status === "done");
  const hiddenN = p.taskCounts.hidden;
  const summary = visible.length
    ? open.length + " open" + (done.length ? " · " + done.length + " done" : "")
    : "0 visible";

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
        <span className="meta">
          {p.relPath}
          {hiddenN ? " · " + hiddenN + " hidden" : ""}
        </span>
        <span className="project-summary">{summary}</span>
      </h2>
      {collapsed ? null : visible.length === 0 ? (
        <div className="empty">No visible tasks</div>
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
