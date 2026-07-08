import type { AutomationsScanResult, MutationResult, ScanResult, TaskDetailResult } from "./types";

/** GET /api/scan — body-light survey (task bodies load lazily via fetchTaskDetail). */
export async function fetchScan(): Promise<ScanResult> {
  const res = await fetch("/api/scan");
  if (!res.ok) throw new Error("scan failed: " + res.status);
  return (await res.json()) as ScanResult;
}

/** GET /api/automations. */
export async function fetchAutomations(): Promise<AutomationsScanResult> {
  const res = await fetch("/api/automations");
  if (!res.ok) throw new Error("automations failed: " + res.status);
  return (await res.json()) as AutomationsScanResult;
}

/** GET /api/task?project=&task= — the full record (body + metadata) for the detail pane. */
export async function fetchTaskDetail(projectUid: string, taskId: string): Promise<TaskDetailResult> {
  const res = await fetch(
    "/api/task?project=" + encodeURIComponent(projectUid) + "&task=" + encodeURIComponent(taskId),
  );
  if (!res.ok) throw new Error("detail failed: " + res.status);
  return (await res.json()) as TaskDetailResult;
}

/**
 * POST a mutation (decision-1 write path). Returns the fresh task detail on
 * success so the caller can merge it back into the store, or an error
 * message on failure. Never throws — callers branch on `.ok`.
 */
export async function postMutation(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ ok: true; detail: TaskDetailResult } | { ok: false; error: string }> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null) ?? "HTTP " + res.status;
      return { ok: false, error };
    }
    return { ok: true, detail: data as TaskDetailResult };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * POST /api/project/reveal — open a local project's root in Finder or its
 * Obsidian vault. Never throws; callers branch on `.ok` and surface `.error`
 * quietly (this is a convenience control, not a critical action).
 */
export async function revealProject(
  projectUid: string,
  target: "finder" | "obsidian",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("/api/project/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: projectUid, target }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = (data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : null) ?? "HTTP " + res.status;
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type { MutationResult };
