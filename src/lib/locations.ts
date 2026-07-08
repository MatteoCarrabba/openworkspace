/**
 * Locations config — externalizing the workspace ROOT from "wherever the cwd
 * happens to be" (phase 2, decision: identity/location/discovery split).
 *
 * `~/.config/openworkspace/locations.toml` lists the stores this machine
 * knows about. v1 schema is deliberately minimal: an array of `[[stores]]`,
 * each `{ name, driver, path }`. Only `driver = "localfs"` exists today — a
 * store IS a workspace root on the local filesystem, absolute path.
 *
 * This module owns LOCATION resolution only: "where is the tree." It does not
 * touch IDENTITY (`_project/id`, workspace_id) or DISCOVERY (the live walk in
 * `workspace.ts`) — those stay exactly as they are. Reads here are forgiving,
 * the same posture as `loadWorkspaceConfig`: an absent or malformed file is
 * indistinguishable from "no config," so callers fall back to today's
 * walk-up-from-cwd behavior. Nothing here creates the user's real
 * `~/.config/openworkspace/` — the file is hand-authored (or authored by a
 * future `locations add`), never stamped by this loader.
 */

import * as os from "node:os";
import * as path from "node:path";

import { readTomlIfExists } from "./toml.js";

/** Override the config directory (tests only — never the real ~/.config). */
export const CONFIG_DIR_ENV = "OPENWORKSPACE_CONFIG_DIR";
export const LOCATIONS_FILE = "locations.toml";

export type StoreDriver = "localfs";

export interface LocationStore {
  name: string;
  driver: StoreDriver;
  /** Absolute filesystem path — the workspace root for a localfs store. */
  path: string;
}

/** `~/.config/openworkspace` (or `OPENWORKSPACE_CONFIG_DIR` when set). */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_DIR_ENV];
  if (override !== undefined && override !== "") return path.resolve(override);
  return path.join(os.homedir(), ".config", "openworkspace");
}

export function locationsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(defaultConfigDir(env), LOCATIONS_FILE);
}

/**
 * Load `[[stores]]` from `locations.toml`. Forgiving by design (P4-style, like
 * `loadWorkspaceConfig`): a missing file, unparseable TOML, a `stores` key
 * that isn't an array, or an individual malformed entry all just drop out —
 * NEVER a throw. A bad/absent config must be exactly as if it weren't there.
 */
export function loadLocationStores(env: NodeJS.ProcessEnv = process.env): LocationStore[] {
  let raw: Record<string, unknown>;
  try {
    raw = readTomlIfExists(locationsFilePath(env));
  } catch {
    return [];
  }
  const rawStores = raw["stores"];
  if (!Array.isArray(rawStores)) return [];

  const stores: LocationStore[] = [];
  for (const entry of rawStores) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const name = e["name"];
    const driver = e["driver"];
    const p = e["path"];
    if (typeof name !== "string" || name === "") continue;
    if (driver !== "localfs") continue; // only driver this version understands
    if (typeof p !== "string" || p === "" || !path.isAbsolute(p)) continue;
    stores.push({ name, driver: "localfs", path: p });
  }
  return stores;
}

/**
 * The workspace root implied by config: the first `localfs` store's path, or
 * null when none is configured (absent file, malformed file, or a config with
 * no valid localfs store all read as null alike).
 */
export function configuredWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const store = loadLocationStores(env).find((s) => s.driver === "localfs");
  return store?.path ?? null;
}
