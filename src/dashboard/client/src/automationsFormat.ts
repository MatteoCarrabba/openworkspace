import type { AutomationLastRun, ScanAutomation } from "./types";

/** Heartbeat older than this is flagged stale (visual only; backend reports raw). */
export const STALE_MIN = 60;

export function fmtAge(min: number | null | undefined): string {
  if (min === null || min === undefined) return "—";
  if (min < 1) return "just now";
  if (min < 60) return min + " min ago";
  const h = Math.floor(min / 60);
  if (h < 24) return h + (h === 1 ? " hr ago" : " hrs ago");
  const d = Math.floor(h / 24);
  return d + (d === 1 ? " day ago" : " days ago");
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function runPillClass(lr: AutomationLastRun | null): { cls: string; label: string } {
  if (!lr) return { cls: "run-other", label: "never run" };
  const okStatuses = ["ok", "success", "succeeded", "skipped"];
  const failStatuses = ["fail", "failed", "error", "timed_out", "abandoned"];
  const ok = okStatuses.includes(lr.status) || (lr.exitCode === 0 && !failStatuses.includes(lr.status));
  const cls = ok ? "run-ok" : failStatuses.includes(lr.status) ? "run-fail" : "run-other";
  return { cls, label: lr.status };
}

export function localRunPill(a: ScanAutomation): { cls: string; label: string; title: string } {
  const state = a.localRunState || "unknown";
  const health = a.localRunHealth || "unknown";
  const cls = health === "ok" ? "run-ok" : health === "critical" ? "run-fail" : health === "unknown" ? "run-unknown" : "run-other";
  const run = a.localRun;
  const when = run ? fmtWhen(run.finishedAt || run.updatedAt || run.startedAt || run.heartbeatAt) : "";
  const reason = a.localRunUnavailable ? " · " + a.localRunUnavailable.replace(/-/g, " ") : "";
  const title = "local run " + state + reason + (when && when !== "—" ? " · " + when : "");
  return { cls, label: "local " + state, title };
}

export function missBadge(a: ScanAutomation): string {
  if (!a.missPolicy) return "";
  let extra = "";
  if (a.missPolicy === "catch-up" && a.maxCatchUp) extra = " max " + a.maxCatchUp;
  else if (a.misfireGraceSeconds) extra = " grace " + a.misfireGraceSeconds + "s";
  return "miss " + a.missPolicy + extra;
}

export function overlapBadge(a: ScanAutomation): string {
  if (!a.overlapPolicy) return "";
  const extra = a.maxConcurrency && a.maxConcurrency > 1 ? " x" + a.maxConcurrency : "";
  return "overlap " + a.overlapPolicy + extra;
}
