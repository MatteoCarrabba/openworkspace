import React, { useState } from "react";
import { useStore } from "../store";
import type { ScanProject, ScanTask } from "../types";

const TRANSITIONS: Array<ScanTask["status"]> = ["todo", "doing", "waiting", "review"];

/**
 * The detail pane's write-path controls: status transitions, a "complete…"
 * flow that requires a Final Summary, and an "Add note" field. Ported from
 * wireDetailActions() in the vanilla dashboard, as React-local state keyed
 * per task (see DetailPane) so switching tasks resets the ephemeral UI.
 */
export function Actions({ p, t }: { p: ScanProject; t: ScanTask }): React.JSX.Element {
  const { mutateTask } = useStore();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; isErr: boolean } | null>(null);
  const [donePanelOpen, setDonePanelOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [note, setNote] = useState("");

  const isDone = t.status === "done";

  const doStatus = async (status: ScanTask["status"]): Promise<void> => {
    setBusy(true);
    setMsg({ text: "Setting " + status + "…", isErr: false });
    const r = await mutateTask(
      "/api/task/status",
      { project: p.uid, task: t.id, status },
      { status },
    );
    setBusy(false);
    if (r.ok) setMsg(null);
    else setMsg({ text: r.error ?? "failed", isErr: true });
  };

  const confirmDone = async (): Promise<void> => {
    const text = summary.trim();
    if (!text) {
      setMsg({ text: "A Final Summary is required to mark done.", isErr: true });
      return;
    }
    setBusy(true);
    setMsg({ text: "Completing…", isErr: false });
    const r = await mutateTask("/api/task/done", { project: p.uid, task: t.id, summary: text }, { status: "done" });
    setBusy(false);
    if (r.ok) {
      setMsg(null);
      setDonePanelOpen(false);
    } else {
      setMsg({ text: r.error ?? "failed", isErr: true });
    }
  };

  const addNote = async (): Promise<void> => {
    const text = note.trim();
    if (!text) {
      setMsg({ text: "Note text is empty.", isErr: true });
      return;
    }
    setBusy(true);
    setMsg({ text: "Adding note…", isErr: false });
    const r = await mutateTask("/api/task/note", { project: p.uid, task: t.id, text }, {});
    setBusy(false);
    if (r.ok) {
      setMsg(null);
      setNote("");
    } else {
      setMsg({ text: r.error ?? "failed", isErr: true });
    }
  };

  return (
    <div className="actions">
      <h4>Actions</h4>
      <p className="act-hint">Move status, or complete… (a Final Summary is required to mark done)</p>
      <div className="act-row">
        {TRANSITIONS.map((s) => (
          <button key={s} className="act-status" disabled={busy || t.status === s} onClick={() => void doStatus(s)}>
            {s}
          </button>
        ))}
        <button
          className="act-done"
          disabled={busy || isDone}
          onClick={() => {
            setDonePanelOpen((open) => !open);
          }}
        >
          {isDone ? "done ✓" : "complete…"}
        </button>
      </div>
      <div className="act-done-panel" hidden={!donePanelOpen}>
        <textarea
          className="act-summary"
          rows={3}
          placeholder="Final Summary (required to mark done)"
          value={summary}
          disabled={busy}
          onChange={(e) => setSummary(e.target.value)}
        />
        <div className="act-row">
          <button className="act-done-confirm" disabled={busy} onClick={() => void confirmDone()}>
            Mark done
          </button>
          <button className="act-done-cancel" disabled={busy} onClick={() => setDonePanelOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
      <div className="act-row">
        <input
          className="act-note"
          type="text"
          placeholder="Add a note…"
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void addNote();
          }}
        />
        <button className="act-note-add" disabled={busy} onClick={() => void addNote()}>
          Add note
        </button>
      </div>
      <div className={"act-msg" + (msg ? (msg.isErr ? " err" : " ok") : "")} role="status">
        {msg?.text ?? ""}
      </div>
    </div>
  );
}
