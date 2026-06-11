/**
 * Typed errors shared by every lib module.
 *
 * Convention: lib code throws OwError subclasses and NEVER calls process.exit.
 * `exitCode` is a *reservation* for the CLI layer, which maps a caught OwError
 * to its exit code (PRD §8: 0 success / 1 failure / 2 resolution failure).
 */

export class OwError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A required file, directory, project, or workspace was not found. */
export class NotFoundError extends OwError {
  constructor(message: string) {
    super("ENOTFOUND", message, 1);
  }
}

/** A record/config file exists but cannot be parsed (strict-write contexts). */
export class ParseError extends OwError {
  constructor(message: string) {
    super("EPARSE", message, 1);
  }
}

/** Invalid workspace/project configuration. */
export class ConfigError extends OwError {
  constructor(message: string) {
    super("ECONFIG", message, 1);
  }
}

/**
 * A uniqueness invariant is violated (duplicate project UID, duplicate record
 * ID, exclusive-create target already exists).
 */
export class ConflictError extends OwError {
  constructor(message: string) {
    super("ECONFLICT", message, 1);
  }
}

/**
 * UID-anchored canonical resolution failed (PRD §6.3). Loud by design:
 * exit code 2, never a silent fallback to worktree-local writes.
 */
export class ResolveError extends OwError {
  constructor(message: string) {
    super("ERESOLVE", message, 2);
  }
}

/** A mint lock could not be acquired within the timeout. */
export class LockError extends OwError {
  constructor(message: string) {
    super("ELOCK", message, 1);
  }
}
