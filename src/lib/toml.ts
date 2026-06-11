/**
 * TOML read/write via smol-toml (PRD §2.2 canonical formats).
 *
 * Posture: reads are forgiving (unknown keys pass through untouched; a
 * missing optional file reads as {}), writes are whole-document only and only
 * for documents the tool OWNS (config it stamped, machine registries,
 * activation records). OpenWorkspace never rewrites a TOML file a human
 * hand-maintains field-by-field — that would destroy comments.
 */

import * as fs from "node:fs";

import { parse, stringify } from "smol-toml";

import { ParseError } from "./errors.js";
import { writeFileAtomic } from "./fsatomic.js";

export type TomlTable = Record<string, unknown>;

export function parseToml(text: string, source = "<string>"): TomlTable {
  try {
    return parse(text) as TomlTable;
  } catch (err) {
    throw new ParseError(`invalid TOML in ${source}: ${(err as Error).message}`);
  }
}

/** Read and parse a TOML file. Throws NotFound via fs if the file is absent. */
export function readToml(filePath: string): TomlTable {
  return parseToml(fs.readFileSync(filePath, "utf8"), filePath);
}

/** Read a TOML file that is allowed to be absent: missing → {} (all defaults). */
export function readTomlIfExists(filePath: string): TomlTable {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  return parseToml(text, filePath);
}

export function stringifyToml(value: TomlTable): string {
  const text = stringify(value);
  return text.endsWith("\n") ? text : text + "\n";
}

/** Atomically write a whole TOML document the tool owns. */
export function writeToml(filePath: string, value: TomlTable): void {
  writeFileAtomic(filePath, stringifyToml(value));
}
