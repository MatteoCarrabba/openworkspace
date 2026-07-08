import React, { useEffect } from "react";
import { useStore } from "../store";
import { renderMarkdown } from "../markdown";
import { Actions } from "./Actions";
import { CliCommands } from "./CliCommands";
import type { ScanProject, ScanTask } from "../types";

export function DetailPane(): React.JSX.Element {
  const { view, findTask, loadTaskDetail } = useStore();
  const hit = view.sel && view.selProject ? findTask(view.selProject, view.sel) : null;

  if (!hit) {
    return (
      <aside id="detail">
        <div className="empty">Select a task</div>
      </aside>
    );
  }
  return <TaskDetailBody key={hit.p.uid + ":" + hit.t.id} p={hit.p} t={hit.t} loadTaskDetail={loadTaskDetail} />;
}

function TaskDetailBody({
  p,
  t,
  loadTaskDetail,
}: {
  p: ScanProject;
  t: ScanTask;
  loadTaskDetail: (projectUid: string, taskId: string) => Promise<void>;
}): React.JSX.Element {
  useEffect(() => {
    if (!t.body) void loadTaskDetail(p.uid, t.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.uid, t.id, t.body]);

  if (!t.body) {
    return (
      <aside id="detail">
        <h3>
          {t.id} — {t.title}
        </h3>
        <span className="lifecycle-tag">{p.name}</span>
        <div className="empty">Loading task…</div>
      </aside>
    );
  }

  const rows: Array<[string, string | null]> = [
    ["status", t.status],
    ["quadrant", t.quadrant],
    ["labels", t.labels.join(", ") || null],
    ["hidden until", t.hiddenUntil],
    ["recur", t.recur],
    ["created", t.created],
    ["updated", t.updated],
    ["file", t.file],
  ].filter(([, v]) => v) as Array<[string, string]>;

  return (
    <aside id="detail">
      <h3>
        {t.id} — {t.title}
      </h3>
      <span className="lifecycle-tag">{p.name}</span>
      <table className="meta-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Actions p={p} t={t} />
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.body) }} />
      <CliCommands taskId={t.id} relPath={p.relPath} />
    </aside>
  );
}
