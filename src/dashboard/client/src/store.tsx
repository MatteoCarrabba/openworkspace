import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { fetchAutomations, fetchScan, fetchTaskDetail, postMutation } from "./api";
import { parseUrlState, serializeUrlState } from "./urlState";
import type { AutomationsScanResult, MutationResult, ScanProject, ScanResult, ScanTask, ViewState } from "./types";

const COLLAPSED_KEY = "ow-collapsed-projects";

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

// Resizable outer columns (rail | list | detail — see #layout in global.css).
// Widths are persisted the same way collapsedProjects is: a small localStorage
// blob, read once at startup and rewritten on every drag.
const PANE_WIDTHS_KEY = "ow-pane-widths";
export type PaneName = "rail" | "detail";
export interface PaneWidths {
  rail: number;
  detail: number;
}
const DEFAULT_PANE_WIDTHS: PaneWidths = { rail: 220, detail: 390 };
const PANE_LIMITS: Record<PaneName, { min: number; max: number }> = {
  rail: { min: 160, max: 480 },
  detail: { min: 280, max: 640 },
};

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function loadPaneWidths(): PaneWidths {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANE_WIDTHS_KEY) || "null");
    if (parsed && typeof parsed.rail === "number" && typeof parsed.detail === "number") {
      return {
        rail: clamp(parsed.rail, PANE_LIMITS.rail.min, PANE_LIMITS.rail.max),
        detail: clamp(parsed.detail, PANE_LIMITS.detail.min, PANE_LIMITS.detail.max),
      };
    }
  } catch {
    // fall through to defaults
  }
  return { ...DEFAULT_PANE_WIDTHS };
}

interface Store {
  scan: ScanResult | null;
  scanError: string | null;
  autos: AutomationsScanResult | null;
  autosError: string | null;
  autosLoaded: boolean;
  view: ViewState;
  collapsedProjects: Set<string>;
  paneWidths: PaneWidths;
  setView: (patch: Partial<ViewState>) => void;
  refresh: () => Promise<void>;
  ensureAutos: () => Promise<void>;
  toggleProjectCollapsed: (uid: string) => void;
  setPaneWidth: (pane: PaneName, px: number) => void;
  loadTaskDetail: (projectUid: string, taskId: string) => Promise<void>;
  mutateTask: (
    path: string,
    payload: Record<string, unknown>,
    optimisticPatch: Partial<ScanTask>,
  ) => Promise<MutationResult>;
  findTask: (projectUid: string, taskId: string) => { p: ScanProject; t: ScanTask } | null;
}

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("useStore() called outside <StoreProvider>");
  return s;
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [autos, setAutos] = useState<AutomationsScanResult | null>(null);
  const [autosError, setAutosError] = useState<string | null>(null);
  const [autosLoaded, setAutosLoaded] = useState(false);
  const [view, setViewState] = useState<ViewState>(() => parseUrlState(location.search));
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => loadCollapsed());
  const [paneWidths, setPaneWidths] = useState<PaneWidths>(() => loadPaneWidths());
  const detailInflight = useRef(new Map<string, Promise<void>>());

  const findTask = useCallback(
    (projectUid: string, taskId: string): { p: ScanProject; t: ScanTask } | null => {
      if (!scan) return null;
      const p = scan.projects.find((pr) => pr.uid === projectUid);
      if (!p) return null;
      const t = p.tasks.find((tk) => tk.id === taskId);
      return t ? { p, t } : null;
    },
    [scan],
  );

  const setView = useCallback((patch: Partial<ViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      const qs = serializeUrlState(next);
      history.replaceState(null, "", qs || location.pathname);
      return next;
    });
  }, []);

  const loadAutos = useCallback(async () => {
    try {
      const data = await fetchAutomations();
      setAutos(data);
      setAutosError(null);
    } catch (err) {
      setAutos(null);
      setAutosError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutosLoaded(true);
    }
  }, []);

  const ensureAutos = useCallback(async () => {
    if (!autosLoaded) await loadAutos();
  }, [autosLoaded, loadAutos]);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchScan();
      setScan(data);
      setScanError(null);
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (view.view === "automations") await loadAutos();
  }, [view.view, loadAutos]);

  const toggleProjectCollapsed = useCallback((uid: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const setPaneWidth = useCallback((pane: PaneName, px: number) => {
    setPaneWidths((prev) => {
      const { min, max } = PANE_LIMITS[pane];
      const next = { ...prev, [pane]: clamp(px, min, max) };
      localStorage.setItem(PANE_WIDTHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Patch one task in place (shallow field merge) without touching project/scan identity
  // more than necessary — used for both the detail-fetch merge and optimistic writes.
  const patchTask = useCallback((projectUid: string, taskId: string, patch: Partial<ScanTask>) => {
    setScan((prev) => {
      if (!prev) return prev;
      const pIdx = prev.projects.findIndex((p) => p.uid === projectUid);
      if (pIdx === -1) return prev;
      const project = prev.projects[pIdx]!;
      const tIdx = project.tasks.findIndex((t) => t.id === taskId);
      if (tIdx === -1) return prev;
      const nextTasks = project.tasks.slice();
      nextTasks[tIdx] = { ...nextTasks[tIdx]!, ...patch };
      const nextProjects = prev.projects.slice();
      nextProjects[pIdx] = { ...project, tasks: nextTasks };
      return { ...prev, projects: nextProjects };
    });
  }, []);

  const loadTaskDetail = useCallback(
    async (projectUid: string, taskId: string): Promise<void> => {
      const key = projectUid + "" + taskId;
      const inflight = detailInflight.current.get(key);
      if (inflight) return inflight;
      const promise = (async () => {
        try {
          const detail = await fetchTaskDetail(projectUid, taskId);
          patchTask(projectUid, taskId, detail.task);
        } catch (err) {
          patchTask(projectUid, taskId, {
            body: "Task detail failed: " + (err instanceof Error ? err.message : String(err)),
          });
        }
      })();
      detailInflight.current.set(key, promise);
      try {
        await promise;
      } finally {
        detailInflight.current.delete(key);
      }
    },
    [patchTask],
  );

  // Optimistic write (decision-1): patch the store immediately, POST, then
  // merge the returned record and re-pull the scan (counts/rollups change).
  // On failure, revert to the pre-mutation snapshot and surface the error.
  const mutateTask = useCallback(
    async (
      path: string,
      payload: Record<string, unknown>,
      optimisticPatch: Partial<ScanTask>,
    ): Promise<MutationResult> => {
      const project = String(payload["project"] ?? "");
      const task = String(payload["task"] ?? "");
      const hit = findTask(project, task);
      const snapshot = hit ? { ...hit.t } : null;

      patchTask(project, task, optimisticPatch);
      const result = await postMutation(path, payload);
      if (result.ok) {
        patchTask(project, task, result.detail.task);
        await refresh();
        return { ok: true };
      }
      if (snapshot) patchTask(project, task, snapshot);
      return { ok: false, error: result.error };
    },
    [findTask, patchTask, refresh],
  );

  const value = useMemo<Store>(
    () => ({
      scan,
      scanError,
      autos,
      autosError,
      autosLoaded,
      view,
      collapsedProjects,
      paneWidths,
      setView,
      refresh,
      ensureAutos,
      toggleProjectCollapsed,
      setPaneWidth,
      loadTaskDetail,
      mutateTask,
      findTask,
    }),
    [
      scan,
      scanError,
      autos,
      autosError,
      autosLoaded,
      view,
      collapsedProjects,
      paneWidths,
      setView,
      refresh,
      ensureAutos,
      toggleProjectCollapsed,
      setPaneWidth,
      loadTaskDetail,
      mutateTask,
      findTask,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
