/**
 * LOSSLESS markdown + YAML-frontmatter codec (PRD §5.6, P12).
 *
 * Built on the "yaml" package's Document API. The fidelity contract:
 *
 *  - parse → serialize with NO mutation reproduces the input BYTE-FOR-BYTE
 *    (the original text is kept and returned verbatim).
 *  - Targeted field updates are SURGICAL: using the parsed Document's node
 *    ranges, only the changed value's bytes are spliced in the original
 *    frontmatter text. Unknown keys, comments (inline ones on the edited
 *    line included), key order, quoting styles, block lists, and folded
 *    scalars on every untouched line survive byte-for-byte. (Whole-document
 *    re-stringification cannot guarantee this — the stringifier re-folds
 *    block scalars — so it is deliberately not used.)
 *  - CRLF inputs stay CRLF; frontmatter terminated by EOF (no trailing
 *    newline after the closing `---`) is handled; a file with no frontmatter
 *    round-trips untouched and can have frontmatter added.
 *
 * Forgiving to read, strict to write: parse never throws on bad YAML (errors
 * are surfaced on the record); mutating a record whose frontmatter failed to
 * parse throws ParseError.
 */

import * as fs from "node:fs";

import { Document, Pair, Scalar, isMap, isScalar, parseDocument, stringify as stringifyYaml } from "yaml";

import { ParseError } from "./errors.js";
import { writeFileAtomic } from "./fsatomic.js";

export interface FrontmatterRecord {
  /** Plain-JS view of the frontmatter ({} when absent or unparseable). */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter line, raw (original EOLs kept). */
  body: string;
  /** Parsed YAML Document — a read view; mutate via setFields/deleteFields. */
  doc: Document | null;
  /** YAML parse error messages; non-empty means data is best-effort. */
  errors: string[];
  /** True when the source text had a frontmatter block. */
  hasFrontmatter: boolean;
  /** Dominant EOL of the source ("\n" or "\r\n"). */
  eol: "\n" | "\r\n";
  /** @internal current frontmatter source text; mutations splice this */
  frontmatterText: string;
  /** @internal original full text, returned verbatim while not dirty */
  originalText: string;
  /** @internal set by mutation helpers; switches serialization source */
  dirty: boolean;
}

interface SplitResult {
  hasFrontmatter: boolean;
  frontmatterText: string;
  body: string;
  eol: "\n" | "\r\n";
}

/**
 * Split a document into frontmatter text and body without losing a byte.
 * Frontmatter = leading line `---` (optionally with \r), closed by a line
 * that is exactly `---` (optionally with \r), or by `---` at EOF.
 */
function split(text: string): SplitResult {
  const noFm: SplitResult = { hasFrontmatter: false, frontmatterText: "", body: text, eol: "\n" };
  if (!text.startsWith("---")) return noFm;
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return noFm; // "---" alone is not a frontmatter block
  const openLine = text.slice(0, firstNl);
  if (openLine !== "---" && openLine !== "---\r") return noFm;
  const eol: "\n" | "\r\n" = openLine.endsWith("\r") ? "\r\n" : "\n";

  let pos = firstNl + 1;
  while (pos <= text.length) {
    const nextNl = text.indexOf("\n", pos);
    const rawLine = nextNl === -1 ? text.slice(pos) : text.slice(pos, nextNl);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "---") {
      return {
        hasFrontmatter: true,
        frontmatterText: text.slice(firstNl + 1, pos),
        body: nextNl === -1 ? "" : text.slice(nextNl + 1),
        eol,
      };
    }
    if (nextNl === -1) break;
    pos = nextNl + 1;
  }
  return noFm; // never closed: treat the whole file as body
}

function dataFromDoc(doc: Document | null): Record<string, unknown> {
  if (doc === null) return {};
  let js: unknown;
  try {
    js = doc.toJS() as unknown;
  } catch {
    return {};
  }
  return js !== null && typeof js === "object" && !Array.isArray(js)
    ? (js as Record<string, unknown>)
    : {};
}

export function parseRecord(text: string): FrontmatterRecord {
  const parts = split(text);
  let doc: Document | null = null;
  const errors: string[] = [];
  if (parts.hasFrontmatter) {
    doc = parseDocument(parts.frontmatterText);
    for (const err of doc.errors) errors.push(err.message);
  }
  return {
    data: dataFromDoc(doc),
    body: parts.body,
    doc,
    errors,
    hasFrontmatter: parts.hasFrontmatter,
    eol: parts.eol,
    frontmatterText: parts.frontmatterText,
    originalText: text,
    dirty: false,
  };
}

function assertWritable(rec: FrontmatterRecord, context: string): void {
  if (rec.errors.length > 0) {
    throw new ParseError(
      `refusing to ${context}: frontmatter has YAML errors (${rec.errors.join("; ")})`,
    );
  }
}

/** Render a value as a single-line YAML scalar, or null when it can't be one. */
function renderScalarInline(value: unknown): string | null {
  if (value === null) return "null";
  const t = typeof value;
  if (t !== "string" && t !== "number" && t !== "boolean") return null;
  const s = stringifyYaml(value, { lineWidth: 0 });
  const trimmed = s.endsWith("\n") ? s.slice(0, -1) : s;
  return trimmed.includes("\n") ? null : trimmed;
}

/** Render a whole `key: value` pair (possibly multi-line), using `eol`. */
function renderPair(key: string, value: unknown, eol: string): string {
  const text = stringifyYaml({ [key]: value }, { lineWidth: 0 });
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

function keyMatches(pair: Pair, key: string): boolean {
  if (isScalar(pair.key)) return String((pair.key as Scalar).value) === key;
  return String(pair.key) === key;
}

interface PairSpan {
  pair: Pair;
  /** Offset of the start of the line the key begins on. */
  lineStart: number;
  /** Offset one past the newline ending the pair's last value line. */
  lineEnd: number;
}

function findPairSpan(fmText: string, doc: Document, key: string): PairSpan | null {
  if (!isMap(doc.contents)) return null;
  const pair = doc.contents.items.find((p) => keyMatches(p as Pair, key)) as Pair | undefined;
  if (pair === undefined) return null;
  const keyNode = pair.key as Scalar;
  const keyRange = keyNode.range;
  if (keyRange == null) return null;
  const lineStart = fmText.lastIndexOf("\n", keyRange[0] - 1) + 1;
  const valueNode = pair.value as Scalar | null;
  const valueEnd =
    valueNode !== null && valueNode.range != null ? valueNode.range[1] : keyRange[1];
  const nl = fmText.indexOf("\n", Math.max(valueEnd - 1, lineStart));
  const lineEnd = nl === -1 ? fmText.length : nl + 1;
  return { pair, lineStart, lineEnd };
}

/**
 * Apply one field update to frontmatter source text. Existing scalar values
 * are spliced in place over the value's exact byte range (the line's layout,
 * inline comment included, survives); non-scalar replacements rewrite only
 * that pair's lines; new keys append at the end of the block.
 */
function applyFieldUpdate(fmText: string, key: string, value: unknown, eol: string): string {
  const doc = parseDocument(fmText);
  if (doc.errors.length > 0) {
    throw new ParseError(`frontmatter became unparseable during edit: ${doc.errors[0]?.message}`);
  }
  if (doc.contents !== null && doc.contents !== undefined && !isMap(doc.contents)) {
    throw new ParseError("frontmatter is not a mapping; cannot set fields");
  }

  const span =
    doc.contents === null || doc.contents === undefined ? null : findPairSpan(fmText, doc, key);

  if (span === null) {
    // new key: append at the end of the block
    let out = fmText;
    if (out.length > 0 && !out.endsWith("\n")) out += eol;
    return out + renderPair(key, value, eol);
  }

  const inline = renderScalarInline(value);
  const valueNode = span.pair.value as Scalar | null;
  if (inline !== null && valueNode !== null && valueNode.range != null) {
    const [vStart, vEnd] = valueNode.range;
    return fmText.slice(0, vStart) + inline + fmText.slice(vEnd);
  }
  // non-scalar value (or key with no value node): rewrite this pair's lines
  return fmText.slice(0, span.lineStart) + renderPair(key, value, eol) + fmText.slice(span.lineEnd);
}

function reparse(rec: FrontmatterRecord): void {
  rec.doc = parseDocument(rec.frontmatterText);
  const errors = rec.doc.errors.map((e) => e.message);
  if (errors.length > 0) {
    throw new ParseError(`edit produced unparseable frontmatter: ${errors.join("; ")}`);
  }
  rec.data = dataFromDoc(rec.doc);
}

/**
 * Set (or add) top-level frontmatter fields. Untouched lines are preserved
 * byte-for-byte; new keys append at the end of the block. Adds a frontmatter
 * block to a record that had none. Refreshes `data` and `doc`.
 */
export function setFields(rec: FrontmatterRecord, updates: Record<string, unknown>): void {
  assertWritable(rec, "edit frontmatter");
  if (!rec.hasFrontmatter) {
    rec.hasFrontmatter = true;
    rec.frontmatterText = "";
  }
  for (const [key, value] of Object.entries(updates)) {
    rec.frontmatterText = applyFieldUpdate(rec.frontmatterText, key, value, rec.eol);
  }
  rec.dirty = true;
  reparse(rec);
}

/** Delete top-level frontmatter fields (missing keys are ignored). */
export function deleteFields(rec: FrontmatterRecord, keys: string[]): void {
  assertWritable(rec, "edit frontmatter");
  if (!rec.hasFrontmatter) return;
  let changed = false;
  for (const key of keys) {
    const doc = parseDocument(rec.frontmatterText);
    if (doc.contents === null || doc.contents === undefined) break;
    if (!isMap(doc.contents)) throw new ParseError("frontmatter is not a mapping");
    const span = findPairSpan(rec.frontmatterText, doc, key);
    if (span === null) continue;
    rec.frontmatterText =
      rec.frontmatterText.slice(0, span.lineStart) + rec.frontmatterText.slice(span.lineEnd);
    changed = true;
  }
  if (changed) {
    rec.dirty = true;
    reparse(rec);
  }
}

/** Replace the body. The frontmatter block is untouched. */
export function setBody(rec: FrontmatterRecord, body: string): void {
  rec.body = body;
  rec.dirty = true;
}

/**
 * Append text to the body (e.g. recurrence `## Log` lines). Ensures exactly
 * one EOL separates existing content from the appended text.
 */
export function appendToBody(rec: FrontmatterRecord, text: string): void {
  let body = rec.body;
  if (body.length > 0 && !body.endsWith("\n")) body += rec.eol;
  rec.body = body + text;
  rec.dirty = true;
}

/**
 * Serialize. Not dirty → the original bytes, verbatim. Dirty → delimiters +
 * the surgically edited frontmatter source + the body.
 */
export function serializeRecord(rec: FrontmatterRecord): string {
  if (!rec.dirty) return rec.originalText;
  if (!rec.hasFrontmatter) return rec.body;
  let fm = rec.frontmatterText;
  if (fm.length > 0 && !fm.endsWith("\n")) fm += rec.eol;
  return `---${rec.eol}${fm}---${rec.eol}${rec.body}`;
}

export function readRecord(filePath: string): FrontmatterRecord {
  return parseRecord(fs.readFileSync(filePath, "utf8"));
}

/** Atomically write a record back to disk. */
export function writeRecord(filePath: string, rec: FrontmatterRecord): void {
  writeFileAtomic(filePath, serializeRecord(rec));
}

/**
 * Convenience: read → setFields → atomic write. Returns the updated record.
 */
export function updateRecordFile(
  filePath: string,
  updates: Record<string, unknown>,
): FrontmatterRecord {
  const rec = readRecord(filePath);
  setFields(rec, updates);
  writeRecord(filePath, rec);
  return rec;
}
