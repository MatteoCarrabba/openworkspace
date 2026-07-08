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

  const select = (): void => setView({ sel: t.id, selProject: p.uid });

  // Roving tabindex: only the selected row is a Tab stop (see tabIndex below).
  // ArrowUp/Down walk the currently-visible `li.task` rows in DOM order —
  // that order already matches the rendered tree (projects, then open/done
  // groups, then subtasks) — moving both native focus and the selection.
  // Enter re-confirms selection on whichever row currently has focus.
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      select();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(document.querySelectorAll<HTMLLIElement>("#main li.task")).filter(
      (el) => el.offsetParent !== null,
    );
    const idx = rows.indexOf(e.currentTarget);
    if (idx === -1) return;
    const next = rows[e.key === "ArrowDown" ? idx + 1 : idx - 1];
    if (!next) return;
    next.focus();
    const pid = next.dataset["pid"];
    const tid = next.dataset["tid"];
    if (pid && tid) setView({ sel: tid, selProject: pid });
  };

  return (
    <li
      className={"task" + (selected ? " sel" : "")}
      data-pid={p.uid}
      data-tid={t.id}
      tabIndex={selected ? 0 : -1}
      onClick={select}
      onKeyDown={onKeyDown}
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
