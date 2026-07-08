import React, { useState } from "react";
import { useStore } from "../store";
import { renderMarkdown, toggleChecklistLineInBody } from "../markdown";
import type { ScanProject, ScanTask } from "../types";

/**
 * The task body (DECISION-9): rendered markdown by default, with interactive
 * Acceptance-Criteria checkboxes; an "Edit" toggle swaps the render for a
 * plain <textarea> (no WYSIWYG library) seeded with the FULL current body —
 * so the user sees `## Final Summary` / `## Log` too and a save never
 * silently drops them. Every write sends the loaded record's `hash` as
 * `expectedHash`; a stale edit is refused (409 ConflictError) rather than
 * clobbering a concurrent write, and the store's optimistic patch is reverted
 * when that happens (see `mutateTask`).
 */
export function BodyEditor({ p, t }: { p: ScanProject; t: ScanTask }): React.JSX.Element {
  const { mutateTask } = useStore();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.body);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isErr: boolean } | null>(null);

  const startEdit = (): void => {
    setDraft(t.body);
    setMsg(null);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setMsg(null);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setMsg(null);
    const r = await mutateTask(
      "/api/task/body",
      { project: p.uid, task: t.id, body: draft, expectedHash: t.hash },
      { body: draft },
    );
    setBusy(false);
    if (r.ok) {
      setEditing(false);
      return;
    }
    const stale = /changed on disk|changed underneath/i.test(r.error ?? "");
    setMsg({
      text: stale ? "This task changed underneath you — reload and try again." : r.error ?? "save failed",
      isErr: true,
    });
  };

  // Event delegation over the rendered HTML: the checkbox inputs are raw DOM
  // nodes from dangerouslySetInnerHTML, not React elements, so a click
  // handler on the wrapping div is how we hear about a toggle.
  const onChecklistClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    const idxAttr = target.dataset["checklistIndex"];
    if (idxAttr === undefined) return;
    const index = Number(idxAttr);
    const checked = target.checked; // the browser already flips this before 'click' fires
    const optimisticBody = toggleChecklistLineInBody(t.body, index, checked);
    void (async () => {
      const r = await mutateTask(
        "/api/task/checkbox",
        { project: p.uid, task: t.id, index, checked, expectedHash: t.hash },
        { body: optimisticBody },
      );
      if (!r.ok) {
        target.checked = !checked; // refused — revert the DOM checkbox the click already flipped
        const stale = /changed on disk|changed underneath/i.test(r.error ?? "");
        setMsg({
          text: stale ? "This task changed underneath you — reload and try again." : r.error ?? "toggle failed",
          isErr: true,
        });
      } else {
        setMsg(null);
      }
    })();
  };

  if (editing) {
    return (
      <div className="body-editor">
        <textarea
          className="body-editor-textarea"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          rows={16}
        />
        <div className="act-row">
          <button disabled={busy} onClick={() => void save()}>
            Save
          </button>
          <button disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
        {msg && (
          <div className={"act-msg" + (msg.isErr ? " err" : " ok")} role="status">
            {msg.text}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="body-view">
      <div className="body-view-header">
        <button className="body-edit-toggle" onClick={startEdit}>
          Edit
        </button>
      </div>
      <div className="md" onClick={onChecklistClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(t.body) }} />
      {msg && (
        <div className={"act-msg" + (msg.isErr ? " err" : " ok")} role="status">
          {msg.text}
        </div>
      )}
    </div>
  );
}
