import type { ViewState } from "./types";

/** Parse the URL-persisted view state — mirrors the vanilla dashboard's getState(). */
export function parseUrlState(search: string): ViewState {
  const q = new URLSearchParams(search);
  return {
    view: q.get("view") === "automations" ? "automations" : "projects",
    scope: (["active", "all", "dormant", "archived"] as const).includes(q.get("scope") as never)
      ? (q.get("scope") as ViewState["scope"])
      : "active",
    status: (["open", "all", "todo", "doing", "waiting", "review", "done"] as const).includes(
      q.get("status") as never,
    )
      ? (q.get("status") as ViewState["status"])
      : "open",
    q: q.get("q") || "",
    subtasks: q.get("subtasks") === "1",
    sel: q.get("task") || null,
    selProject: q.get("project") || null,
    autoFilter: q.get("autofilter") === "drift" ? "drift" : "all",
  };
}

/** Serialize back to a `?query=string` (empty string when everything is default). */
export function serializeUrlState(s: ViewState): string {
  const q = new URLSearchParams();
  if (s.view !== "projects") q.set("view", s.view);
  if (s.scope !== "active") q.set("scope", s.scope);
  if (s.status !== "open") q.set("status", s.status);
  if (s.q) q.set("q", s.q);
  if (s.subtasks) q.set("subtasks", "1");
  if (s.sel) q.set("task", s.sel);
  if (s.selProject) q.set("project", s.selProject);
  if (s.autoFilter !== "all") q.set("autofilter", s.autoFilter);
  const qs = q.toString();
  return qs ? "?" + qs : "";
}
