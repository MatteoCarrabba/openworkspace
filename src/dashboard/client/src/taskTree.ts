import type { ScanProject, ScanTask, ViewState } from "./types";

export function dotClass(status: string): string {
  return (["todo", "doing", "waiting", "review", "done"] as const).includes(status as never) ? status : "other";
}

export function taskMatchesFilters(p: ScanProject, t: ScanTask, st: ViewState): boolean {
  if (st.status === "open" && t.status === "done") return false;
  if (!["open", "all"].includes(st.status) && t.status !== st.status) return false;
  const q = st.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [p.name, p.relPath, t.id, t.title, t.status, t.quadrant || "", t.labels.join(" ")]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

/** Hierarchy derived purely from dotted-ID prefixes, same rule as the vanilla dashboard. */
export function buildTaskTree(tasks: ScanTask[]): { roots: ScanTask[]; childrenById: Map<string, ScanTask[]> } {
  const byId = new Map<string, ScanTask>();
  tasks.forEach((t) => byId.set(t.id, t));
  const childrenById = new Map<string, ScanTask[]>();
  const roots: ScanTask[] = [];
  tasks.forEach((t) => {
    if (t.parentId && byId.has(t.parentId)) {
      const list = childrenById.get(t.parentId) ?? [];
      list.push(t);
      childrenById.set(t.parentId, list);
    } else {
      roots.push(t); // orphan subtasks surface at top level rather than vanish
    }
  });
  return { roots, childrenById };
}
