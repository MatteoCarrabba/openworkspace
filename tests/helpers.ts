/**
 * Shared test helpers. Test convention (see MODULES.md):
 *  - node:test, compiled to dist/tests/, run via `node --test "dist/tests/"`.
 *  - EVERY filesystem test runs against a temp dir under os.tmpdir() —
 *    never against the live workspace, never against the real ~/Library.
 *  - Register cleanup with the returned `cleanup` or test-level t.after.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MachineStore, openMachineStore } from "../src/lib/machine.js";
import { MARKER_DIR, Workspace, openWorkspace } from "../src/lib/workspace.js";

/** Absolute path of the committed fixture corpus (real legacy records). */
export const FIXTURES_DIR = path.resolve(__dirname, "..", "..", "tests", "fixtures");

export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURES_DIR, ...parts);
}

export function listFixtureFiles(subdir: string, ext = ".md"): string[] {
  return fs
    .readdirSync(path.join(FIXTURES_DIR, subdir))
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(FIXTURES_DIR, subdir, f));
}

export function makeTmpDir(prefix = "openworkspace-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

export interface TmpWorkspace {
  ws: Workspace;
  root: string;
  /** Create a project at relPath (creating _project/id); returns its info. */
  addProject: (relPath: string, uid?: string) => { root: string; uid: string };
  cleanup: () => void;
}

/**
 * Create a temp workspace: a dir under os.tmpdir() with `.openworkspace/`
 * and an optional config.toml body.
 */
export function makeTmpWorkspace(configToml?: string): TmpWorkspace {
  const root = makeTmpDir();
  fs.mkdirSync(path.join(root, MARKER_DIR));
  if (configToml !== undefined) {
    fs.writeFileSync(path.join(root, MARKER_DIR, "config.toml"), configToml);
  }
  const ws = openWorkspace(root);
  return {
    ws,
    root,
    addProject: (relPath: string, uid?: string) => {
      const projectRoot = path.join(root, relPath);
      const projectUid = uid ?? crypto.randomUUID();
      fs.mkdirSync(path.join(projectRoot, "_project"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "_project", "id"), projectUid + "\n");
      return { root: projectRoot, uid: projectUid };
    },
    cleanup: () => rmrf(root),
  };
}

export interface TmpStore {
  store: MachineStore;
  cleanup: () => void;
}

/** A machine-local store in a temp dir — never the real ~/Library. */
export function makeTmpStore(): TmpStore {
  const dir = makeTmpDir("openworkspace-store-");
  return { store: openMachineStore(dir), cleanup: () => rmrf(dir) };
}
