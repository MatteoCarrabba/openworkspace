import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { ParseError } from "../src/lib/errors.js";
import {
  appendToBody,
  deleteFields,
  parseRecord,
  readRecord,
  serializeRecord,
  setBody,
  setFields,
  updateRecordFile,
  writeRecord,
} from "../src/lib/frontmatter.js";
import { listFixtureFiles, makeTmpDir, rmrf } from "./helpers.js";

const ALL_FIXTURES = [...listFixtureFiles("tasks"), ...listFixtureFiles("reminders")];

test("fixture corpus is present (real legacy records)", () => {
  assert.ok(ALL_FIXTURES.length >= 10, `expected >=10 fixtures, got ${ALL_FIXTURES.length}`);
});

test("round-trip: every fixture reproduces its bytes exactly when unmodified", () => {
  for (const file of ALL_FIXTURES) {
    const text = fs.readFileSync(file, "utf8");
    const rec = parseRecord(text);
    assert.equal(rec.errors.length, 0, `${path.basename(file)} should parse cleanly`);
    assert.equal(serializeRecord(rec), text, `byte fidelity lost for ${path.basename(file)}`);
  }
});

test("round-trip: parse exposes data and body for a real legacy task", () => {
  const file = ALL_FIXTURES.find((f) => path.basename(f).startsWith("task-1 "));
  assert.ok(file !== undefined);
  const rec = readRecord(file);
  assert.equal(rec.data["id"], "TASK-1");
  assert.equal(rec.data["status"], "Done");
  assert.deepEqual(rec.data["labels"], ["security"]);
  assert.ok(rec.body.includes("## Acceptance Criteria"));
});

test("targeted update: only the changed field's line differs; unknown keys, order, quoting survive", () => {
  for (const file of ALL_FIXTURES) {
    const original = fs.readFileSync(file, "utf8");
    const rec = parseRecord(original);
    const before = serializeRecord(rec).split("\n");
    setFields(rec, { status: "doing" });
    const after = serializeRecord(rec).split("\n");
    assert.equal(after.length, before.length, `${path.basename(file)}: line count changed`);
    const diffs: number[] = [];
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) diffs.push(i);
    }
    assert.equal(diffs.length, 1, `${path.basename(file)}: expected exactly 1 changed line, got ${diffs.length}`);
    const idx = diffs[0] as number;
    assert.match(after[idx] as string, /^status: doing\r?$/);
  }
});

test("targeted update preserves dotted parent_task_id and block lists (legacy subtask fixture)", () => {
  const file = ALL_FIXTURES.find((f) => path.basename(f).startsWith("task-18.2"));
  assert.ok(file !== undefined);
  const original = fs.readFileSync(file, "utf8");
  const rec = parseRecord(original);
  setFields(rec, { quadrant: "q2" });
  const out = serializeRecord(rec);
  assert.ok(out.includes("parent_task_id: TASK-18"), "unknown legacy key must survive");
  assert.ok(out.includes("created_date: '2026-05-04 23:40'"), "quoted scalar style must survive");
  assert.ok(out.includes("labels: []"), "flow empty list must survive");
  assert.ok(out.includes("quadrant: q2"));
  assert.ok(!out.includes("quadrant: Q4"));
  assert.equal(rec.body, parseRecord(original).body, "body untouched by frontmatter edit");
});

test("targeted update preserves block lists with quoted items (task-1 references)", () => {
  const file = ALL_FIXTURES.find((f) => path.basename(f).startsWith("task-1 "));
  assert.ok(file !== undefined);
  const rec = readRecord(file);
  setFields(rec, { updated: "2026-06-10" });
  const out = serializeRecord(rec);
  assert.ok(out.includes("references:\n  - 'Inbox:Outbox/_from-notes-export/SALAMANDER-SECRETS-REVIEW/'"));
  assert.ok(out.includes("labels:\n  - security"));
  assert.ok(out.includes("updated: 2026-06-10"));
});

test("reminder fixtures: recur and explicit null fields survive a targeted update", () => {
  const file = listFixtureFiles("reminders").find((f) => path.basename(f).startsWith("reminder-7"));
  assert.ok(file !== undefined);
  const rec = readRecord(file);
  assert.equal(rec.data["recur"], "yearly");
  assert.equal(rec.data["fired_at"], null);
  setFields(rec, { status: "dismissed" });
  const out = serializeRecord(rec);
  assert.ok(out.includes("recur: yearly"));
  assert.ok(out.includes("fired_at: null"));
  assert.ok(out.includes("promoted_to_task: null"));
});

test("new keys append at the end of the frontmatter block", () => {
  const text = "---\nid: task-9\ntitle: t\n---\nbody\n";
  const rec = parseRecord(text);
  setFields(rec, { hidden_until: "2026-09-01" });
  assert.equal(
    serializeRecord(rec),
    "---\nid: task-9\ntitle: t\nhidden_until: 2026-09-01\n---\nbody\n",
  );
});

test("comments in frontmatter survive a targeted update", () => {
  const text = "---\n# stamped by importer\nid: task-3 # legacy TASK-3\nstatus: todo\n---\nbody\n";
  const rec = parseRecord(text);
  setFields(rec, { status: "done" });
  const out = serializeRecord(rec);
  assert.ok(out.includes("# stamped by importer"));
  assert.ok(out.includes("id: task-3 # legacy TASK-3"));
  assert.ok(out.includes("status: done"));
});

test("CRLF document: parses, round-trips bytes, and stays CRLF after mutation", () => {
  const text = "---\r\nid: task-5\r\ntitle: crlf test\r\n---\r\nline one\r\nline two\r\n";
  const rec = parseRecord(text);
  assert.equal(rec.eol, "\r\n");
  assert.equal(rec.data["id"], "task-5");
  assert.equal(rec.body, "line one\r\nline two\r\n");
  assert.equal(serializeRecord(rec), text);
  setFields(rec, { status: "todo" });
  const out = serializeRecord(rec);
  assert.equal(out, "---\r\nid: task-5\r\ntitle: crlf test\r\nstatus: todo\r\n---\r\nline one\r\nline two\r\n");
});

test("EOF-terminated frontmatter (no trailing newline after closing ---)", () => {
  const text = "---\nid: task-8\nstatus: todo\n---";
  const rec = parseRecord(text);
  assert.equal(rec.hasFrontmatter, true);
  assert.equal(rec.data["id"], "task-8");
  assert.equal(rec.body, "");
  assert.equal(serializeRecord(rec), text);
  setFields(rec, { status: "doing" });
  assert.equal(serializeRecord(rec), "---\nid: task-8\nstatus: doing\n---\n");
});

test("file with no frontmatter round-trips untouched; setFields adds a block", () => {
  const text = "# Just a markdown file\n\nNo frontmatter here.\n";
  const rec = parseRecord(text);
  assert.equal(rec.hasFrontmatter, false);
  assert.deepEqual(rec.data, {});
  assert.equal(rec.body, text);
  assert.equal(serializeRecord(rec), text);
  setFields(rec, { id: "task-1" });
  assert.equal(serializeRecord(rec), "---\nid: task-1\n---\n" + text);
});

test("--- with no closing delimiter is body, not frontmatter", () => {
  const text = "---\nthis is actually an hr-opening document with no close";
  const rec = parseRecord(text);
  assert.equal(rec.hasFrontmatter, false);
  assert.equal(serializeRecord(rec), text);
});

test("body containing --- lines is not confused with frontmatter delimiters", () => {
  const text = "---\nid: task-2\n---\nintro\n\n---\n\na horizontal rule above\n";
  const rec = parseRecord(text);
  assert.equal(rec.data["id"], "task-2");
  assert.ok(rec.body.includes("---\n"));
  assert.equal(serializeRecord(rec), text);
});

test("long plain scalars are not re-wrapped on mutation (lineWidth: 0)", () => {
  const long = "A very long unwrapped title that would exceed eighty characters if the stringifier were allowed to fold plain scalars onto continuation lines";
  const text = `---\ntitle: ${long}\nstatus: todo\n---\n`;
  const rec = parseRecord(text);
  setFields(rec, { status: "done" });
  const out = serializeRecord(rec);
  assert.ok(out.includes(`title: ${long}\n`), "title line must stay on one line");
});

test("forgiving read, strict write: YAML errors expose data best-effort but block edits", () => {
  const text = "---\nid: task-4\nbroken: [unclosed\n---\nbody\n";
  const rec = parseRecord(text);
  assert.ok(rec.errors.length > 0);
  assert.equal(serializeRecord(rec), text, "unmodified bad file still round-trips bytes");
  assert.throws(() => setFields(rec, { status: "done" }), ParseError);
});

test("deleteFields removes a key and refreshes data", () => {
  const text = "---\nid: task-6\nparent_task_id: TASK-1\nstatus: todo\n---\n";
  const rec = parseRecord(text);
  deleteFields(rec, ["parent_task_id", "not_present"]);
  assert.equal(rec.data["parent_task_id"], undefined);
  assert.equal(serializeRecord(rec), "---\nid: task-6\nstatus: todo\n---\n");
});

test("setBody and appendToBody", () => {
  const rec = parseRecord("---\nid: task-7\n---\nold body\n");
  setBody(rec, "new body\n");
  assert.equal(serializeRecord(rec), "---\nid: task-7\n---\nnew body\n");
  appendToBody(rec, "- 2026-06-17T09:00Z — completed; next 2026-06-24\n");
  assert.ok(serializeRecord(rec).endsWith("new body\n- 2026-06-17T09:00Z — completed; next 2026-06-24\n"));
  // appending to a body missing its trailing newline inserts one separator
  const rec2 = parseRecord("---\na: 1\n---\nno newline at end");
  appendToBody(rec2, "appended\n");
  assert.equal(rec2.body, "no newline at end\nappended\n");
});

test("writeRecord/updateRecordFile: atomic disk round-trip preserves untouched fixture lines", (t) => {
  const dir = makeTmpDir();
  t.after(() => rmrf(dir));
  const source = ALL_FIXTURES[0] as string;
  const target = path.join(dir, path.basename(source));
  fs.copyFileSync(source, target);

  const before = fs.readFileSync(target, "utf8");
  const updated = updateRecordFile(target, { status: "doing" });
  assert.equal(updated.data["status"], "doing");
  const after = fs.readFileSync(target, "utf8");
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  assert.equal(afterLines.length, beforeLines.length);
  const diffs = beforeLines.filter((l, i) => l !== afterLines[i]);
  assert.equal(diffs.length, 1);

  // a fresh read + unmodified write is byte-stable
  const rec = readRecord(target);
  writeRecord(target, rec);
  assert.equal(fs.readFileSync(target, "utf8"), after);
});

test("PRD §4.4 canonical task shape parses with expected types", () => {
  const text = [
    "---",
    "id: task-141",
    "title: Fix the frontmatter codec",
    "status: doing            # todo | doing | waiting | review | done",
    "quadrant: q2             # q1–q4; propose-then-discuss, never silently auto-set",
    "labels: [codec]          # optional; also the home of review/proposal shapes",
    "hidden_until: null       # date | null — hidden from default listings until then",
    "created: 2026-06-10",
    "updated: 2026-06-10T14:02:00Z",
    "---",
    "",
    "## Description",
    "",
  ].join("\n");
  const rec = parseRecord(text);
  assert.equal(rec.data["id"], "task-141");
  assert.deepEqual(rec.data["labels"], ["codec"]);
  assert.equal(rec.data["hidden_until"], null);
  assert.equal(typeof rec.data["created"], "string", "core schema: dates stay strings");
  assert.equal(serializeRecord(rec), text);
  setFields(rec, { hidden_until: "2026-09-01" });
  const out = serializeRecord(rec);
  assert.ok(out.includes("quadrant: q2             # q1–q4; propose-then-discuss, never silently auto-set"));
  assert.ok(out.includes("hidden_until: 2026-09-01"));
});
