/**
 * Project graph — ref resolution and ownership graph (project-graph feature).
 *
 * The ownership edge is canonical on the parent (`[[owns]]` in the parent's
 * `_project/project.toml`, read by `readOwns`). This module turns those
 * declared edges into a resolved, navigable graph over the live tree:
 *
 *  - `classifyRef` decides whether a ref is a ws-relative path, an
 *    absolute/`~` path, or a remote URL.
 *  - `resolveOwnRef` resolves one edge to a status (ok | missing |
 *    not-a-project | remote | bad-ref), a local path, a UID (when the target
 *    is itself an OW project), and an effective lifecycle.
 *  - `buildOwnershipGraph` walks every owner via `discoverProjects(all)` and
 *    resolves each owner's edges — computed FRESH each call from the live tree
 *    plus declarations (no stored aggregator, principle 8).
 *
 * Why this can't ride on discovery alone: `discoverProjects` deliberately
 * prunes foreign git worktrees and never walks outside `ws.root` — i.e. it
 * never enters the code/remote children. The graph MUST be built from the
 * `[[owns]]` declarations. That is the feature's whole point: a code child is
 * trackable WITHOUT ~/code being a workspace.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  DeclaredLifecycle,
  OwnEdge,
  ProjectInfo,
  Workspace,
  discoverProjects,
  effectiveLifecycle,
  readOwns,
  readProjectUid,
} from "./workspace.js";

export type RefShape = "ws-relative" | "absolute" | "remote";

/**
 * Classify a ref string. A `scheme://` or `git@host:` ref is remote (no FS);
 * a `/` or `~` ref is absolute; everything else is ws-relative.
 */
export function classifyRef(ref: string): RefShape {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)) return "remote"; // scheme://
  if (/^git@/.test(ref)) return "remote"; // scp-style git
  if (ref.startsWith("/") || ref.startsWith("~")) return "absolute";
  return "ws-relative";
}

export type OwnStatus = "ok" | "missing" | "not-a-project" | "remote" | "bad-ref";

export interface ResolvedOwn {
  edge: OwnEdge;
  shape: RefShape;
  /** Absolute path on disk, or null for remote. */
  localPath: string | null;
  /** Present only when localPath is an OW project root. */
  uid: string | null;
  lifecycle: DeclaredLifecycle | null;
  status: OwnStatus;
}

/** Expand a leading `~` to the home dir, else resolve as an absolute path. */
function expandHome(ref: string): string {
  if (ref.startsWith("~")) {
    return path.join(os.homedir(), ref.slice(1).replace(/^[/\\]/, ""));
  }
  return path.resolve(ref);
}

/**
 * Resolve one `[[owns]]` edge against the live tree.
 *
 * Lifecycle resolution rule (single coherent rule): the child's own
 * `project.toml` if it is an OW project; else the edge's `lifecycle` field;
 * else `active`. Both are metadata-only — nothing ever moves for code/remote
 * children. Remote edges do ZERO filesystem work.
 */
export function resolveOwnRef(ws: Workspace, edge: OwnEdge): ResolvedOwn {
  const shape = classifyRef(edge.ref);

  if (edge.kind === "remote" || shape === "remote") {
    return {
      edge,
      shape,
      localPath: null,
      uid: null,
      lifecycle: edge.lifecycle,
      status: "remote",
    };
  }

  let abs: string;
  if (shape === "ws-relative") {
    // Anchored at ws.root, matching discoverProjects' relPath, so `ref:
    // "Briefing"` round-trips with that project's relPath.
    abs = path.resolve(ws.root, edge.ref);
  } else {
    abs = expandHome(edge.ref);
  }

  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return { edge, shape, localPath: abs, uid: null, lifecycle: edge.lifecycle, status: "missing" };
  }

  const uid = readProjectUid(abs);
  if (uid !== null) {
    return {
      edge,
      shape,
      localPath: abs,
      uid,
      lifecycle: effectiveLifecycle(ws, abs),
      status: "ok",
    };
  }
  // A bare dir that is NOT an OW project. This is the EXPECTED healthy state
  // for kind:"code" pointing at a bare repo; for kind:"subproject" it's a
  // dangling edge (doctor flags it).
  return {
    edge,
    shape,
    localPath: abs,
    uid: null,
    lifecycle: edge.lifecycle,
    status: "not-a-project",
  };
}

export interface OwnershipNode {
  owner: ProjectInfo;
  edges: ResolvedOwn[];
}

export interface OwnershipGraph {
  nodes: OwnershipNode[];
  /** child-uid (if the child is a project) → owner relPaths (duplicate-ownership check). */
  ownersByChildKey: Map<string, string[]>;
  /** Malformed-edge problems, prefixed with the owner relPath. */
  problems: string[];
}

/**
 * Build the ownership graph for the whole workspace, fresh from the live tree.
 * Shelves are included (a dormant parent still owns its children).
 */
export function buildOwnershipGraph(ws: Workspace): OwnershipGraph {
  const owners = discoverProjects(ws, { all: true });
  const nodes: OwnershipNode[] = [];
  const ownersByChildKey = new Map<string, string[]>();
  const problems: string[] = [];

  for (const owner of owners) {
    const result = readOwns(owner.root);
    for (const p of result.problems) problems.push(`${owner.relPath}: ${p}`);
    const edges = result.owns.map((edge) => resolveOwnRef(ws, edge));
    for (const r of edges) {
      if (r.uid !== null) {
        const list = ownersByChildKey.get(r.uid);
        if (list === undefined) ownersByChildKey.set(r.uid, [owner.relPath]);
        else list.push(owner.relPath);
      }
    }
    nodes.push({ owner, edges });
  }

  return { nodes, ownersByChildKey, problems };
}

/**
 * Directed-cycle detection over an adjacency map (node → out-neighbors).
 * White/grey/black DFS; fs-free for unit-testability. Returns the first cycle
 * found as a node path that starts and ends on the same node, or null.
 */
export function detectCycle(adj: Map<string, string[]>): string[] | null {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adj.keys()) color.set(k, WHITE);

  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    color.set(node, GREY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GREY) {
        // Found a back-edge: slice the stack from `next` and close the loop.
        const idx = stack.indexOf(next);
        return [...stack.slice(idx), next];
      }
      if (c === WHITE) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      const found = visit(node);
      if (found !== null) return found;
    }
  }
  return null;
}
