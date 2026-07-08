/**
 * Wire types for the dashboard HTTP API. Deliberately duplicated (not
 * imported) from src/dashboard/server.ts: the client is its own package with
 * its own build/toolchain and never pulls in server-side Node dependencies.
 * Keep these in sync with the ScanTask/ScanProject/... interfaces there.
 */

export type Lifecycle = "active" | "dormant" | "archived";

export interface TaskRollup {
  total: number;
  done: number;
  status: string;
}

export interface ScanTask {
  id: string;
  file: string;
  title: string;
  status: string;
  quadrant: string | null;
  labels: string[];
  recur: string | null;
  hiddenUntil: string | null;
  hidden: boolean;
  unhiddenToday: boolean;
  created: string | null;
  updated: string | null;
  parentId: string | null;
  depth: number;
  body: string;
  rollup: TaskRollup | null;
}

export interface DoctorIssue {
  project: string | null;
  file: string | null;
  message: string;
}

export interface ScanProject {
  uid: string;
  relPath: string;
  name: string;
  lifecycle: Lifecycle;
  nestedUnder: string | null;
  tasks: ScanTask[];
  taskCounts: { total: number; done: number; hidden: number };
}

export interface ScanResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  counts: { active: number; dormant: number; archived: number; all: number };
  attention: { waiting: number; review: number; unhiddenToday: number; doctorErrors: number };
  projects: ScanProject[];
  doctor: { errors: DoctorIssue[] };
}

export interface TaskDetailResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  project: { uid: string; relPath: string; name: string; lifecycle: Lifecycle };
  task: ScanTask;
}

export type AutomationDriftKind = "declared-not-activated" | "activated-undeclared";

export interface AutomationDrift {
  kind: AutomationDriftKind;
  machineId: string;
  detail: string;
}

export interface AutomationLastRun {
  status: string;
  finishedAt: string | null;
  startedAt: string | null;
  exitCode: number | null;
}

export interface AutomationMachineState {
  machineId: string;
  heartbeat: string | null;
  staleMinutes: number | null;
  activated: boolean;
  declared: boolean;
  schedule: string | null;
  lastRun: AutomationLastRun | null;
}

export interface AutomationLocalRun {
  source: "state-file" | "attempt";
  runId: string | null;
  state: string;
  health: string;
  status: string | null;
  phase: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  reason: string | null;
}

export interface ScanAutomation {
  key: string;
  name: string;
  project: { uid: string; relPath: string; name: string; lifecycle: Lifecycle };
  declaredMachines: string[];
  schedule: string | null;
  kind: string | null;
  missPolicy: string | null;
  misfireGraceSeconds: number | null;
  maxCatchUp: number | null;
  overlapPolicy: string | null;
  maxConcurrency: number | null;
  valid: boolean;
  problems: string[];
  localRunState: string;
  localRunHealth: string;
  localRun: AutomationLocalRun | null;
  localRunUnavailable: string | null;
  machines: AutomationMachineState[];
  activatedOn: string[];
  drift: AutomationDrift[];
}

export interface ScanMachineRegistry {
  machineId: string;
  heartbeat: string | null;
  staleMinutes: number | null;
  activationCount: number;
}

export interface AutomationsScanResult {
  generatedAt: string;
  workspace: { root: string; name: string; workspaceId: string | null };
  machines: ScanMachineRegistry[];
  automations: ScanAutomation[];
  drift: Array<AutomationDrift & { automation: string; project: string }>;
}

export interface AutomationsError {
  error: number | string;
}

/** URL-persisted view state (mirrors the vanilla dashboard's getState/setState). */
export interface ViewState {
  view: "projects" | "automations";
  scope: "active" | "all" | "dormant" | "archived";
  status: "open" | "all" | "todo" | "doing" | "waiting" | "review" | "done";
  q: string;
  subtasks: boolean;
  sel: string | null;
  selProject: string | null;
  autoFilter: "all" | "drift";
  autoQuery: string;
}

export interface MutationResult {
  ok: boolean;
  error?: string;
}
