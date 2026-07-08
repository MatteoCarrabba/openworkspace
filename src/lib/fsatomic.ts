/**
 * Atomic filesystem primitives (PRD §5.1).
 *
 * Every record write in OpenWorkspace goes through writeFileAtomic: write to a
 * temp file in the SAME directory (rename is only atomic within a filesystem),
 * fsync, then rename over the destination. Readers therefore never observe a
 * torn write — they see either the old bytes or the new bytes, whole.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ConflictError } from "./errors.js";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * sha256 of the exact bytes given, hex-encoded. Used for optimistic
 * concurrency: callers hash what they read and compare against a fresh hash
 * immediately before an atomic write, so a concurrent writer's changes are
 * detected instead of clobbered (PRD §5.1 write-race hole, Phase 1a).
 */
export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function tempPathFor(filePath: string): string {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rand = crypto.randomBytes(4).toString("hex");
  return path.join(dir, `.${base}.ow-tmp-${process.pid}-${rand}`);
}

/**
 * Atomically replace (or create) `filePath` with `data`.
 * Creates parent directories as needed. Cleans up its temp file on failure.
 */
export function writeFileAtomic(filePath: string, data: string | Buffer): void {
  ensureDir(path.dirname(filePath));
  const tmp = tempPathFor(filePath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o644);
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already failing; preserve the original error
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp may never have been created
    }
    throw err;
  }
}

/**
 * Create a file exclusively AND atomically: the maildir-style "identity is the
 * filename" write. Throws ConflictError if the file already exists.
 *
 * PRD §5.1 ("temp-file + rename, always"): the bytes are written + fsynced to
 * a temp file in the same directory first, then linked to the final name —
 * link(2) fails with EEXIST on collision (exclusivity) and publishes the file
 * fully written (atomicity). A reader/syncer can never observe a torn record
 * under its final name; a crash mid-write leaves only a temp file, which
 * cleanStaleTempFiles reaps.
 */
export function createExclusive(filePath: string, data: string | Buffer): void {
  ensureDir(path.dirname(filePath));
  const tmp = tempPathFor(filePath);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o644);
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.linkSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // already failing; preserve the original error
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // temp may never have been created
    }
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ConflictError(`file already exists: ${filePath}`);
    }
    throw err;
  }
  fs.unlinkSync(tmp);
}

/**
 * Append to a file, creating it (and parent dirs) if missing. Used for
 * append-only logs and `## Log` style additions where the file has a single
 * writer; multi-writer files must be partitioned per machine instead (P15).
 */
export function appendSafe(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, data, { flag: "a" });
}

/** Read a UTF-8 file, or return null when it does not exist. */
export function readTextIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Remove stale OpenWorkspace temp files in a directory (crash leftovers from
 * interrupted atomic writes). Only touches our own `.{name}.ow-tmp-*` pattern.
 */
export function cleanStaleTempFiles(dirPath: string, olderThanMs = 60 * 60 * 1000): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dirPath);
  } catch {
    return removed;
  }
  const cutoff = Date.now() - olderThanMs;
  for (const name of entries) {
    if (!/\.ow-tmp-\d+-[0-9a-f]{8}$/.test(name)) continue;
    const full = path.join(dirPath, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed.push(full);
      }
    } catch {
      // raced with another cleaner; fine
    }
  }
  return removed;
}
