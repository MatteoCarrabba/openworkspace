#!/usr/bin/env node
import { openWorkspace } from "../lib/workspace.js";
import { scanAutomations, scanWorkspace, taskDetail } from "./server.js";

interface ChildPayload {
  ok: boolean;
  result?: unknown;
  error?: string;
}

function main(): { payload: ChildPayload; exitCode: number } {
  const [kind, workspaceRoot, nowIso, projectUid, taskId] = process.argv.slice(2);
  if (kind !== "scan" && kind !== "automations" && kind !== "task") {
    return { payload: { ok: false, error: `unknown scan kind: ${kind ?? "(none)"}` }, exitCode: 1 };
  }
  if (workspaceRoot === undefined || nowIso === undefined) {
    return {
      payload: { ok: false, error: "usage: scan-child <scan|automations|task> <workspace-root> <now-iso> [project task]" },
      exitCode: 1,
    };
  }

  const now = new Date(nowIso);
  const ws = openWorkspace(workspaceRoot);
  if (kind === "scan") {
    return { payload: { ok: true, result: scanWorkspace(ws, now, { includeTaskBodies: false }) }, exitCode: 0 };
  }
  if (kind === "automations") {
    return { payload: { ok: true, result: scanAutomations(ws, now) }, exitCode: 0 };
  }
  if (projectUid === undefined || taskId === undefined) {
    return { payload: { ok: false, error: "task scan requires project uid and task id" }, exitCode: 1 };
  }
  return { payload: { ok: true, result: taskDetail(ws, projectUid, taskId, now) }, exitCode: 0 };
}

let payload: ChildPayload;
let exitCode = 0;
try {
  const result = main();
  payload = result.payload;
  exitCode = result.exitCode;
} catch (err) {
  payload = { ok: false, error: err instanceof Error ? err.message : String(err) };
  exitCode = 1;
}

process.stdout.write(JSON.stringify(payload), () => process.exit(exitCode));
