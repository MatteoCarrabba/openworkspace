import React from "react";
import { useStore } from "../store";
import { ProjectCard } from "./ProjectCard";

export function ProjectList(): React.JSX.Element | null {
  const { scan, view } = useStore();
  if (!scan) return null;

  const projects = view.scope === "all" ? scan.projects : scan.projects.filter((p) => p.lifecycle === view.scope);
  const errs = scan.doctor.errors;

  return (
    <main id="main">
      {projects.length === 0 ? (
        <div className="empty">No projects in this scope</div>
      ) : (
        projects.map((p) => <ProjectCard key={p.uid} p={p} st={view} />)
      )}
      {errs.length ? (
        <section className="project">
          <h2>
            Doctor <span className="meta">{errs.length} error{errs.length === 1 ? "" : "s"}</span>
          </h2>
          <ul id="doctor-list" className="tasks">
            {errs.map((e, i) => (
              <li key={i}>{(e.project ? e.project + ": " : "") + e.message}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
