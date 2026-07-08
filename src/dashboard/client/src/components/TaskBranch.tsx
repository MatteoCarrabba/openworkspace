import React from "react";
import { TaskRow } from "./TaskRow";
import type { ScanProject, ScanTask, ViewState } from "../types";

/** Recursively renders a list of sibling tasks, honoring the subtasks toggle. */
export function TaskBranch({
  p,
  tasks,
  st,
  childrenById,
  indent = false,
}: {
  p: ScanProject;
  tasks: ScanTask[];
  st: ViewState;
  childrenById: Map<string, ScanTask[]>;
  indent?: boolean;
}): React.JSX.Element {
  return (
    <ul className={indent ? "tasks indent" : "tasks"}>
      {tasks.map((t) => {
        const kids = childrenById.get(t.id) ?? [];
        if (!st.subtasks || kids.length === 0) return <TaskRow key={t.id} p={p} t={t} st={st} />;
        return (
          <React.Fragment key={t.id}>
            <TaskRow p={p} t={t} st={st} />
            <details className="disc" open>
              <summary>
                {kids.length} subtask{kids.length === 1 ? "" : "s"}
              </summary>
              <TaskBranch p={p} tasks={kids} st={st} childrenById={childrenById} indent />
            </details>
          </React.Fragment>
        );
      })}
    </ul>
  );
}
