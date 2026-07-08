import React from "react";
import { useStore } from "../store";
import { dotClass } from "../taskTree";
import type { ScanProject, ScanTask, ViewState } from "../types";

/** One `<li class="task">` row — status dot, dotted id, title, rollup/badges. */
export function TaskRow({ p, t, st }: { p: ScanProject; t: ScanTask; st: ViewState }): React.JSX.Element {
  const { setView } = useStore();
  const selected = st.sel === t.id && st.selProject === p.uid;
  const showRollup = t.rollup && !st.subtasks;
  const dotStatus = showRollup ? t.rollup!.status : t.status;

  return (
    <li
      className={"task" + (selected ? " sel" : "")}
      onClick={() => setView({ sel: t.id, selProject: p.uid })}
    >
      <span className={"dot " + dotClass(dotStatus)} title={dotStatus} />
      <span className="tid">{t.id}</span>
      <span className="ttl">{t.title}</span>
      {showRollup ? (
        <span className="rollup">
          ({t.rollup!.total} subtasks: {t.rollup!.done} done)
        </span>
      ) : null}
      {t.unhiddenToday ? <span className="badge unhid">unhid today</span> : null}
      {t.recur ? <span className="badge recur">↻ {t.recur}</span> : null}
    </li>
  );
}
