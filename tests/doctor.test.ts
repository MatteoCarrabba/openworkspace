/**
 * Doctor checks (PRD §10) — the additions beyond the acceptance suite:
 * bare secret values (hard error), secret schemes without resolvers,
 * conflict artifacts under .git/, state-named subdirs under ANY primitive,
 * resolved-thread archive proposals, unanswered-question aging, doc-currency,
 * machine-registry heartbeat staleness, and git-posture reconciliation.
 * Everything runs against temp dirs.
 */

import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
  DoctorIssue,
  ExecFn,
  ExecResult,
  doctorProject,
  doctorWorkspace,
  doctorWorkspaceOnly,
  runnerPostureIssues,
} from "../src/doctor.js";
import { FORUM_README, PROJECT_README, initProject, updateMachineRegistry } from "../src/init.js";
import { checkDocCurrency } from "../src/lib/clisurface.js";
import { MachineStore, activationRecordPath, appendLifecycleIntent, writeRunnerNode } from "../src/lib/machine.js";
import { writeToml } from "../src/lib/toml.js";
import { OwnEdge, writeDeclaredLifecycle, writeOwns } from "../src/lib/workspace.js";
import { detectCycle } from "../src/lib/owns.js";
import { makeTmpDir, makeTmpStore, makeTmpWorkspace, rmrf } from "./helpers.js";

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function writeManifest(projectRoot: string, name: string, toml: string): void {
  const dir = path.join(projectRoot, "_project", "automations", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "automation.toml"), toml);
}

// ---------------------------------------------------------------------------
// Secrets (PRD §7.5)
// ---------------------------------------------------------------------------

test("doctor: bare secret value under [secrets] is a hard ERROR from both doctors", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Leaky");
  writeManifest(p.root, "leak", `name = "leak"\n[secrets]\nPLAIN = "sk-ant-actual-value-12345"\n`);

  const projectIssues = doctorProject(p.root);
  const bare = projectIssues.filter((i) => /bare secret value/.test(i.message));
  assert.equal(bare.length, 1);
  assert.equal(bare[0]?.severity, "error");
  assert.match(bare[0]?.message ?? "", /"PLAIN"/);

  // and the workspace doctor (which runs project checks) sees it too
  const wsReport = doctorWorkspace(tw.ws);
  assert.ok(wsReport.issues.some((i) => /bare secret value/.test(i.message)));
  assert.ok(wsReport.errors >= 1);
});

test("doctor: secret pointer with no resolver warns at workspace level; quiet once mapped", (t) => {
  const noResolver = makeTmpWorkspace();
  t.after(noResolver.cleanup);
  const p1 = noResolver.addProject("PtrProj");
  writeManifest(p1.root, "auto", `[secrets]\nTOKEN = "op://AI Secrets/item/field"\n`);
  const warned = doctorWorkspaceOnly(noResolver.ws).filter((i) => /secret scheme "op" has no resolver/.test(i.message));
  assert.equal(warned.length, 1);
  assert.equal(warned[0]?.severity, "warn");
  // a pointer is NOT a bare value
  assert.ok(!doctorProject(p1.root).some((i) => /bare secret value/.test(i.message)));

  const withResolver = makeTmpWorkspace(`[secrets.resolvers]\nop = "op read {ref}"\n`);
  t.after(withResolver.cleanup);
  const p2 = withResolver.addProject("PtrProj");
  writeManifest(p2.root, "auto", `[secrets]\nTOKEN = "op://AI Secrets/item/field"\n`);
  assert.ok(!doctorWorkspaceOnly(withResolver.ws).some((i) => /no resolver/.test(i.message)));
});

// ---------------------------------------------------------------------------
// Conflict artifacts — including under .git/ (PRD §5.5 rev 3)
// ---------------------------------------------------------------------------

test("doctor: iCloud conflict artifacts are detected under .git/ too", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const gitSub = path.join(tw.root, ".git", "some");
  fs.mkdirSync(gitSub, { recursive: true });
  fs.writeFileSync(path.join(gitSub, "ORIG_HEAD"), "x\n");
  fs.writeFileSync(path.join(gitSub, "ORIG_HEAD 2"), "x\n");
  fs.writeFileSync(path.join(tw.root, "note.md"), "x\n");
  fs.writeFileSync(path.join(tw.root, "note 2.md"), "x\n");

  const issues = doctorWorkspaceOnly(tw.ws);
  const conflicts = issues.filter((i) => /sync-conflict artifact/.test(i.message));
  const files = conflicts.map((i) => i.file);
  assert.ok(files.includes(path.join(".git", "some", "ORIG_HEAD 2")), `missing .git finding: ${files.join(", ")}`);
  assert.ok(files.includes("note 2.md"));
  for (const c of conflicts) assert.equal(c.severity, "error");
});

// ---------------------------------------------------------------------------
// State-named subdirs under ANY primitive (PRD §4.3/§10)
// ---------------------------------------------------------------------------

test("doctor: state-named subdirs flagged under plans/, automations/, forum/ — wiki exempt", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);
  const p = path.join(projectRoot, "_project");
  fs.mkdirSync(path.join(p, "plans", "done"), { recursive: true });
  fs.mkdirSync(path.join(p, "automations", "pending"), { recursive: true });
  fs.mkdirSync(path.join(p, "forum", "resolved"), { recursive: true });
  fs.mkdirSync(path.join(p, "wiki", "open-problems"), { recursive: true }); // wiki subfolders are mandated content
  fs.mkdirSync(path.join(p, "automations", "daily-sync"), { recursive: true }); // a normal automation name

  const issues = doctorProject(projectRoot);
  const stateNamed = issues.filter((i) => /state-named subdirectory/.test(i.message));
  const flaggedFiles = stateNamed.map((i) => i.file).sort();
  assert.deepEqual(flaggedFiles, [
    path.join("_project", "automations", "pending"),
    path.join("_project", "forum", "resolved"),
    path.join("_project", "plans", "done"),
  ]);
  for (const i of stateNamed) assert.equal(i.severity, "error");
  // forum's own structure and ordinary names are never flagged
  assert.ok(!issues.some((i) => /threads|presence|daily-sync|open-problems/.test(i.file ?? "")));
});

// ---------------------------------------------------------------------------
// Forum retention + coordination aging (PRD §4.6/§10)
// ---------------------------------------------------------------------------

function makeThread(
  projectRoot: string,
  name: string,
  meta: string,
  messages: Array<{ filename: string; text: string }> = [],
): void {
  const dir = path.join(projectRoot, "_project", "forum", "threads", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "thread.md"), meta);
  for (const m of messages) fs.writeFileSync(path.join(dir, m.filename), m.text);
}

test("doctor: resolved thread untouched >30 days gets an archive PROPOSAL (warn)", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);
  const now = new Date("2026-06-10T12:00:00Z");
  makeThread(
    projectRoot,
    "2026-04-01--old-stream",
    `---\ntitle: Old\nstatus: resolved\nopened: 2026-04-01T10:00:00Z\nresolved: 2026-04-02T10:00:00Z\n---\n`,
    [{ filename: "20260401T100500Z--a--ab12.md", text: `---\nfrom: a\nkind: note\nts: 2026-04-01T10:05:00Z\n---\nx\n` }],
  );
  makeThread(
    projectRoot,
    "2026-06-01--fresh-stream",
    `---\ntitle: Fresh\nstatus: resolved\nopened: 2026-06-01T10:00:00Z\nresolved: 2026-06-05T10:00:00Z\n---\n`,
  );

  const issues = doctorProject(projectRoot, { now });
  const proposals = issues.filter((i) => /untouched for >30 days/.test(i.message));
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]?.severity, "warn");
  assert.match(proposals[0]?.message ?? "", /forum archive 2026-04-01--old-stream/);
});

test("doctor: unanswered to: question aging >7 days in an OPEN thread warns; answered/resolved stay quiet", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);
  const now = new Date("2026-06-10T12:00:00Z");
  const q = (id: string, ts: string, to: string) =>
    ({ filename: `${id}.md`, text: `---\nfrom: a\nkind: question\nts: ${ts}\nto: ${to}\n---\nq?\n` });

  // open thread: one old unanswered question, one old ANSWERED question, one fresh question
  makeThread(
    projectRoot,
    "2026-05-20--stream",
    `---\ntitle: S\nstatus: open\nopened: 2026-05-20T10:00:00Z\n---\n`,
    [
      q("20260520T100000Z--a--aaaa", "2026-05-20T10:00:00Z", "matteo"),
      q("20260521T100000Z--a--bbbb", "2026-05-21T10:00:00Z", "claude-b"),
      {
        filename: "20260522T100000Z--claude-b--cccc.md",
        text: `---\nfrom: claude-b\nkind: answer\nts: 2026-05-22T10:00:00Z\nre: 20260521T100000Z--a--bbbb\n---\nyes\n`,
      },
      q("20260609T100000Z--a--dddd", "2026-06-09T10:00:00Z", "matteo"),
    ],
  );
  // resolved thread with an old unanswered question: thread-level dealt-with
  makeThread(
    projectRoot,
    "2026-05-01--closed",
    `---\ntitle: C\nstatus: resolved\nopened: 2026-05-01T10:00:00Z\nresolved: 2026-06-09T10:00:00Z\n---\n`,
    [q("20260501T100000Z--a--eeee", "2026-05-01T10:00:00Z", "matteo")],
  );

  const issues = doctorProject(projectRoot, { now });
  const aging = issues.filter((i) => /unanswered question/.test(i.message));
  assert.equal(aging.length, 1, JSON.stringify(aging));
  assert.equal(aging[0]?.severity, "warn");
  assert.match(aging[0]?.file ?? "", /20260520T100000Z--a--aaaa\.md$/);
  assert.match(aging[0]?.message ?? "", /to matteo/);
});

// ---------------------------------------------------------------------------
// Doc-currency (R2/R3, §10)
// ---------------------------------------------------------------------------

test("doc-currency: the shipped orientation artifacts are clean", () => {
  assert.deepEqual(checkDocCurrency(PROJECT_README), []);
  assert.deepEqual(checkDocCurrency(FORUM_README), []);
  const skill = path.resolve(__dirname, "..", "..", "skills", "using-openworkspace", "SKILL.md");
  assert.deepEqual(checkDocCurrency(fs.readFileSync(skill, "utf8")), []);
  const readme = path.resolve(__dirname, "..", "..", "README.md");
  assert.deepEqual(checkDocCurrency(fs.readFileSync(readme, "utf8")), []);
});

test("doc-currency: dead commands and retired primitive dirs in a stamped README are flagged", (t) => {
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);
  const readmePath = path.join(projectRoot, "_project", "README.md");
  fs.appendFileSync(
    readmePath,
    "\nUse `projects reflection list` to review, or `projects task burndown`.\nRetrospectives live in `_project/reflections/`.\n",
  );

  const findings = doctorProject(projectRoot).filter((i) => /doc-currency/.test(i.message));
  assert.equal(findings.length, 3, JSON.stringify(findings));
  for (const f of findings) {
    assert.equal(f.severity, "warn");
    assert.equal(f.file, path.join("_project", "README.md"));
  }
  const reasons = findings.map((f) => f.message).join("\n");
  assert.match(reasons, /unknown command "reflection"/);
  assert.match(reasons, /unknown task subcommand "burndown"/);
  assert.match(reasons, /retired primitive directory "reflections\/"/);
});

test("doc-currency: prose mentions of the word projects are not commands", () => {
  assert.deepEqual(checkDocCurrency("All projects are directories. We manage projects here.\n"), []);
  // comments inside code blocks are not commands either
  assert.deepEqual(checkDocCurrency("```sh\nprojects home list   # what projects exist\n```\n"), []);
});

// ---------------------------------------------------------------------------
// Machine registry heartbeat (§7.3/§10)
// ---------------------------------------------------------------------------

test("doctor: machine-registry heartbeat staleness — fresh quiet, stale warns", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const now = new Date("2026-06-10T12:00:00Z");
  updateMachineRegistry(tw.root, "laptop", now);
  updateMachineRegistry(tw.root, "mini", new Date("2026-05-01T12:00:00Z"));

  const issues = doctorWorkspaceOnly(tw.ws, undefined, { now });
  const stale = issues.filter((i) => /heartbeat stale/.test(i.message));
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.severity, "warn");
  assert.match(stale[0]?.file ?? "", /machines[/\\]mini\.toml$/);
  assert.ok(!issues.some((i) => /laptop\.toml/.test(i.file ?? "")));

  // sole-writer re-heartbeat preserves foreign keys in the machine's own file
  const miniPath = path.join(tw.root, ".openworkspace", "machines", "mini.toml");
  fs.writeFileSync(miniPath, fs.readFileSync(miniPath, "utf8") + `custom_note = "keep me"\n`);
  updateMachineRegistry(tw.root, "mini", now);
  const text = fs.readFileSync(miniPath, "utf8");
  assert.match(text, /custom_note = "keep me"/);
  assert.ok(!doctorWorkspaceOnly(tw.ws, undefined, { now }).some((i) => /heartbeat stale/.test(i.message)));
});

// ---------------------------------------------------------------------------
// Git-posture reconciliation (§6.1) + stale worktree registrations (§6.3)
// ---------------------------------------------------------------------------

test("doctor: _project/id git-ignored and tracked-should-be-ignored files are proposed for repair", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const tmp = makeTmpDir();
  t.after(() => rmrf(tmp));
  git(["init", "-q"], tmp);
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);
  // allowlist-style root gitignore that never admitted the project
  fs.writeFileSync(path.join(tmp, ".gitignore"), "*\n!.gitignore\n");
  // and a presence file that got committed despite the stamp
  const presence = path.join(projectRoot, "_project", "forum", "presence", "mbp--claude.md");
  fs.writeFileSync(presence, "---\nparticipant: claude\n---\n");
  git(["add", "-f", "Proj/_project/forum/presence/mbp--claude.md"], tmp);
  git(["commit", "-q", "-m", "oops"], tmp);

  const issues = doctorProject(projectRoot);
  assert.ok(
    issues.some((i) => /_project\/id is git-ignored.*allowlist/.test(i.message)),
    JSON.stringify(issues),
  );
  const tracked = issues.filter((i) => /tracked but should be ignored/.test(i.message));
  assert.equal(tracked.length, 1);
  assert.match(tracked[0]?.file ?? "", /forum\/presence\/mbp--claude\.md$/);
  assert.match(tracked[0]?.message ?? "", /git rm --cached/);
});

test("git posture: the stamped /archive/ pattern is ANCHORED — tasks/archive/ and forum threads/archive/ stay committed (§4.8/§11.4)", (t) => {
  // Regression: the unanchored `archive/` pattern (copied verbatim from the
  // PRD §6.1 example) matched at ANY depth below _project/, git-ignoring
  // tasks/archive/ and forum/threads/archive/ — archived records silently
  // fell out of git, violating "archived records get committed homes".
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const tmp = makeTmpDir("ow-anchor-");
  t.after(() => rmrf(tmp));
  git(["init", "-q"], tmp);
  const projectRoot = path.join(tmp, "Proj");
  initProject(projectRoot);

  const checkIgnored = (rel: string): boolean => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--", rel], { cwd: tmp, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  // committed retention homes must NOT be ignored by the stamp
  assert.equal(checkIgnored("Proj/_project/tasks/archive/task-141 - x.md"), false);
  assert.equal(checkIgnored("Proj/_project/forum/threads/archive/2026-01-01--t/thread.md"), false);
  // the gitignored bulk archive (and presence, logs) still are
  assert.equal(checkIgnored("Proj/_project/archive/legacy-imports/x/task.md"), true);
  assert.equal(checkIgnored("Proj/_project/forum/presence/m--p.md"), true);
  assert.equal(checkIgnored("Proj/_project/automations/n/logs/m/1.log"), true);

  // the stamped posture is doctor-clean…
  assert.ok(!doctorProject(projectRoot).some((i) => /UNANCHORED|git-posture stamp/.test(i.message)));
  // …and a legacy UNANCHORED stamp gets the anchoring proposal
  fs.writeFileSync(
    path.join(projectRoot, "_project", ".gitignore"),
    "forum/presence/\nautomations/*/logs/\narchive/\n",
  );
  const issues = doctorProject(projectRoot);
  const anchor = issues.filter((i) => /UNANCHORED `archive\/` pattern/.test(i.message));
  assert.equal(anchor.length, 1);
  assert.equal(anchor[0]?.severity, "warn");
  assert.ok(issues.some((i) => /stamp incomplete — missing: \/archive\//.test(i.message)));
});

test("doctor: stale git-worktree registration proposes prune; in-tree worktree warned", (t) => {
  if (!gitAvailable()) {
    t.skip("git not available");
    return;
  }
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  git(["init", "-q"], tw.root);
  fs.writeFileSync(path.join(tw.root, "file.txt"), "x\n");
  git(["add", "."], tw.root);
  git(["commit", "-q", "-m", "init"], tw.root);

  const wtParent = makeTmpDir("ow-doctor-wt-");
  t.after(() => rmrf(wtParent));
  const wt = path.join(wtParent, "gone");
  git(["worktree", "add", "-q", wt, "-b", "b1"], tw.root);
  fs.rmSync(wt, { recursive: true, force: true }); // crashed/cleaned agent left a registration

  const issues = doctorWorkspaceOnly(tw.ws);
  const stale = issues.filter((i) => /stale git worktree registration/.test(i.message));
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.severity, "warn");
  assert.match(stale[0]?.message ?? "", /git worktree prune/);

  // a live worktree INSIDE the workspace violates the §6.3 rule
  const inside = path.join(tw.root, "wt-inside");
  git(["worktree", "add", "-q", inside, "-b", "b2"], tw.root);
  const issues2 = doctorWorkspaceOnly(tw.ws);
  assert.ok(issues2.some((i) => /worktree inside the workspace root/.test(i.message)));
});

// ---------------------------------------------------------------------------
// Runner posture + grant staleness (decision-1, PRD §7.4) — all machine-local,
// all behind the injectable ExecFn seam; nothing here runs real codesign or
// sqlite3, and nothing reads the real TCC db or ~/Library.
// ---------------------------------------------------------------------------

/** ExecFn fake keyed by command name; unknown commands fail loudly. */
function fakeExec(table: Record<string, ExecResult>): ExecFn {
  return (cmd) => table[cmd] ?? { status: 1, stdout: "", stderr: `no fake wired for ${cmd}` };
}

const CODESIGN_DEVELOPER_ID: ExecResult = {
  status: 0,
  stdout: "",
  // codesign -dv writes details to stderr; the Authority chain is the probe's input
  stderr:
    "Executable=/fixed/path/node\nIdentifier=node\nSignature size=8979\n" +
    "Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)\n" +
    "Authority=Developer ID Certification Authority\nAuthority=Apple Root CA\n",
};

/** Plant a minimal activation record so "automations exist on this machine". */
function plantActivation(store: MachineStore): void {
  writeToml(activationRecordPath(store, "11111111-1111-1111-1111-111111111111", "nightly"), {
    project_uid: "11111111-1111-1111-1111-111111111111",
    name: "nightly",
    machine_id: "testmac",
    label: "com.openworkspace.x.nightly",
    plist_path: "/tmp/x.plist",
    applied_at: "2026-06-10T00:00:00Z",
    direct_exec: false,
    schedule: "cron 0 22 * * *",
  });
}

/** An existing executable to point runner-node at (validation requires it). */
function fakeNodeAt(dir: string, ...rel: string[]): string {
  const bin = path.join(dir, ...rel);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(bin, 0o755);
  return bin;
}

/** Common options: claude pointed at a nonexistent path unless a test wires one. */
function postureOpts(store: MachineStore, exec: ExecFn, extra: { tccDbPath?: string; claudeBinPath?: string } = {}) {
  return {
    store,
    exec,
    claudeBinPath: extra.claudeBinPath ?? path.join(store.dir, "no-claude-here"),
    ...(extra.tccDbPath !== undefined ? { tccDbPath: extra.tccDbPath } : {}),
  };
}

test("doctor posture: runner-node-unset warns only when activations exist AND nothing is configured", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const neverExec: ExecFn = () => {
    throw new Error("exec must not be called when there is nothing to probe");
  };

  // no activations on this machine → all checks silent (no noise on laptops)
  assert.deepEqual(runnerPostureIssues(postureOpts(store, neverExec)), []);

  // activations + no runner-node → the unset warn (and only it)
  plantActivation(store);
  const issues = runnerPostureIssues(postureOpts(store, neverExec));
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.severity, "warn");
  assert.match(issues[0]?.message ?? "", /^runner-node-unset:/);
  assert.match(issues[0]?.message ?? "", /projects home runner-node/);

  // configuring a healthy runner-node clears it
  writeRunnerNode(store, fakeNodeAt(store.dir, "bin", "node"));
  const after = runnerPostureIssues(postureOpts(store, fakeExec({ codesign: CODESIGN_DEVELOPER_ID })));
  assert.deepEqual(after, []);
});

test("doctor posture: runner-node-provenance — Cellar path, ad-hoc signature, missing Authority, codesign failure", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  const provenance = (issues: DoctorIssue[]) =>
    issues.filter((i) => /^runner-node-provenance:/.test(i.message));

  // a Homebrew Cellar path warns WITHOUT shelling out (the path is the tell)
  const neverExec: ExecFn = () => {
    throw new Error("Cellar detection must not need codesign");
  };
  writeRunnerNode(store, fakeNodeAt(store.dir, "Cellar", "node", "24.1.0", "bin", "node"));
  let found = provenance(runnerPostureIssues(postureOpts(store, neverExec)));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "warn");
  assert.match(found[0]?.message ?? "", /Homebrew Cellar/);
  assert.match(found[0]?.message ?? "", /official nodejs\.org pkg build/);

  // a fixed path outside Cellar goes through codesign: Developer ID = quiet
  writeRunnerNode(store, fakeNodeAt(store.dir, "fixed", "node"));
  assert.deepEqual(provenance(runnerPostureIssues(postureOpts(store, fakeExec({ codesign: CODESIGN_DEVELOPER_ID })))), []);

  // ad-hoc signature (Homebrew-built node copied elsewhere) warns
  const adhoc = fakeExec({
    codesign: { status: 0, stdout: "", stderr: "Executable=/fixed/node\nIdentifier=node\nSignature=adhoc\n" },
  });
  found = provenance(runnerPostureIssues(postureOpts(store, adhoc)));
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? "", /ad-hoc\/unstable signature/);

  // signed but with no Developer-ID/Apple Authority chain warns too
  const oddAuthority = fakeExec({
    codesign: { status: 0, stdout: "", stderr: "Executable=/fixed/node\nAuthority=Some Random CA\n" },
  });
  assert.equal(provenance(runnerPostureIssues(postureOpts(store, oddAuthority))).length, 1);

  // codesign failing outright (unsigned binary) warns — never throws
  const failing = fakeExec({
    codesign: { status: 1, stdout: "", stderr: "code object is not signed at all" },
  });
  found = provenance(runnerPostureIssues(postureOpts(store, failing)));
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? "", /codesign -dv` failed/);
});

test("doctor posture: claude-grant-staleness — matching row quiet, stale row warns, unreadable db is info-unverifiable", (t) => {
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  plantActivation(store);
  writeRunnerNode(store, fakeNodeAt(store.dir, "fixed", "node")); // keep unset-warn out of the way

  // a realistic versioned install: ~/.local/bin/claude → versions/2.0.13/claude
  const home = makeTmpDir("ow-claude-home-");
  t.after(() => rmrf(home));
  const versioned = fakeNodeAt(home, "share", "claude", "versions", "2.0.13", "claude");
  const claudeBin = path.join(home, "bin", "claude");
  fs.mkdirSync(path.dirname(claudeBin), { recursive: true });
  fs.symlinkSync(versioned, claudeBin);
  const staleness = (issues: DoctorIssue[]) =>
    issues.filter((i) => /^claude-grant-staleness:/.test(i.message));

  // TCC row matching the CURRENT version → quiet
  const matching = fakeExec({
    codesign: CODESIGN_DEVELOPER_ID,
    sqlite3: { status: 0, stdout: `${versioned}\n`, stderr: "" },
  });
  assert.deepEqual(staleness(runnerPostureIssues(postureOpts(store, matching, { claudeBinPath: claudeBin }))), []);

  // only an OLDER version's path-keyed row → stale, warn (re-seed proposal)
  const stale = fakeExec({
    codesign: CODESIGN_DEVELOPER_ID,
    sqlite3: { status: 0, stdout: `${home}/share/claude/versions/2.0.5/claude\n`, stderr: "" },
  });
  let found = staleness(runnerPostureIssues(postureOpts(store, stale, { claudeBinPath: claudeBin })));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "warn");
  assert.match(found[0]?.message ?? "", /2\.0\.13/);
  assert.match(found[0]?.message ?? "", /re-seed/);

  // no row at all is also stale (the grant was never seeded or was revoked)
  const empty = fakeExec({
    codesign: CODESIGN_DEVELOPER_ID,
    sqlite3: { status: 0, stdout: "", stderr: "" },
  });
  assert.equal(staleness(runnerPostureIssues(postureOpts(store, empty, { claudeBinPath: claudeBin }))).length, 1);

  // sqlite3 unable to read the db → INFO "unverifiable", never warn/error
  const unreadable = fakeExec({
    codesign: CODESIGN_DEVELOPER_ID,
    sqlite3: { status: 1, stdout: "", stderr: "Error: unable to open database" },
  });
  found = staleness(runnerPostureIssues(postureOpts(store, unreadable, { claudeBinPath: claudeBin })));
  assert.equal(found.length, 1);
  assert.equal(found[0]?.severity, "info");
  assert.match(found[0]?.message ?? "", /unverifiable/);

  // no claude installed at all → nothing to go stale, silent
  assert.deepEqual(
    staleness(runnerPostureIssues(postureOpts(store, fakeExec({ codesign: CODESIGN_DEVELOPER_ID })))),
    [],
  );
});

test("doctor posture: rides doctorWorkspaceOnly/doctorWorkspace when a store is provided; skipped without one", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  plantActivation(store);
  const exec = fakeExec({ codesign: CODESIGN_DEVELOPER_ID });
  const claudeBinPath = path.join(store.dir, "no-claude-here");

  // without a store the posture checks are skipped by construction
  assert.ok(!doctorWorkspaceOnly(tw.ws).some((i) => /runner-node-unset/.test(i.message)));

  const issues = doctorWorkspaceOnly(tw.ws, undefined, { store, exec, claudeBinPath });
  assert.ok(issues.some((i) => i.severity === "warn" && /^runner-node-unset:/.test(i.message)));
  // ...and the full doctorWorkspace report counts it as a warning, not an error
  const report = doctorWorkspace(tw.ws, { store, exec, claudeBinPath });
  assert.equal(report.errors, 0);
  assert.ok(report.warnings >= 1);
  assert.equal(report.infos, 0);
});

// --- decision-2: drift reporting (doctor reports, reconcile heals) ---

test("doctor: an unknown declared lifecycle value is an error", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Bad");
  fs.writeFileSync(path.join(p.root, "_project", "project.toml"), 'lifecycle = "hibernating"\n');
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(
    issues.some((i) => i.severity === "error" && /declared lifecycle invalid/.test(i.message)),
    "doctor flags the invalid enum value",
  );
});

test("doctor: location/metadata drift is REPORTED (warn) and points at reconcile — only with a store", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  // declared dormant (persisted in metadata) but the folder sits at the TOP
  // LEVEL (active location) → drift; the intent matches the metadata, nothing
  // points at the location → glitch → revert is proposed.
  const p = tw.addProject("Habits");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-11T00:00:00Z");
  appendLifecycleIntent(store, { uid: p.uid, to: "dormant", at: "2026-06-11T00:00:00Z", machine: "mbp" });

  // without a store, the drift detection is skipped (no tiebreaker substrate)
  const noStore = doctorWorkspaceOnly(tw.ws);
  assert.ok(!noStore.some((i) => /reconcile/.test(i.message)), "no drift check runs without a store");

  // with a store, the glitch drift is reported and reconcile is proposed
  const withStore = doctorWorkspaceOnly(tw.ws, undefined, { store });
  assert.ok(
    withStore.some((i) => i.severity === "warn" && /lifecycle drift/.test(i.message) && /reconcile/.test(i.message)),
    "doctor warns about drift and names reconcile",
  );
});

test("doctor: ambiguous drift surfaces as info with both fix commands", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const { store, cleanup } = makeTmpStore();
  t.after(cleanup);
  // declared dormant but the folder sits at the TOP LEVEL (active), with NO
  // local intent and no git → ambiguous (can't tell drag from glitch).
  const p = tw.addProject("Writing");
  writeDeclaredLifecycle(p.root, "dormant", "2026-06-01T00:00:00Z"); // contradicts location, no intent
  const issues = doctorWorkspaceOnly(tw.ws, undefined, { store });
  const amb = issues.find((i) => i.severity === "info" && /ambiguous lifecycle drift/.test(i.message));
  assert.ok(amb !== undefined);
  assert.match(amb.message, /--to active/);
  assert.match(amb.message, /--revert/);
});

// ---------------------------------------------------------------------------
// Project graph — [[owns]] edge invariants (a–e) (project-graph feature)
// ---------------------------------------------------------------------------

function subEdge(ref: string): OwnEdge {
  return { ref, kind: "subproject", name: null, lifecycle: null };
}

// (a) dangling edge ----------------------------------------------------------

test("owns doctor (a): a subproject edge to a nonexistent dir is an ERROR", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeOwns(p.root, [subEdge("Nope")]);
  const issues = doctorWorkspaceOnly(tw.ws);
  const dangling = issues.filter((i) => /dangling owns edge/.test(i.message));
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0]?.severity, "error");
  assert.match(dangling[0]?.message ?? "", /Nope \(subproject\) resolves to missing/);
});

test("owns doctor (a): a code edge to a bare repo is NOT flagged (healthy)", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  fs.mkdirSync(path.join(tw.root, "bare"));
  writeOwns(p.root, [{ ref: "bare", kind: "code", name: null, lifecycle: null }]);
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(!issues.some((i) => /dangling owns edge/.test(i.message)));
});

// (b) cycle ------------------------------------------------------------------

test("owns doctor (b): Foo owns Bar, Bar owns Foo → one cycle ERROR naming both", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const foo = tw.addProject("Foo");
  const bar = tw.addProject("Bar");
  writeOwns(foo.root, [subEdge("Bar")]);
  writeOwns(bar.root, [subEdge("Foo")]);
  const issues = doctorWorkspaceOnly(tw.ws);
  const cycles = issues.filter((i) => /ownership cycle/.test(i.message));
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0]?.severity, "error");
  assert.match(cycles[0]?.message ?? "", /Foo/);
  assert.match(cycles[0]?.message ?? "", /Bar/);
});

test("owns doctor (b): a DAG (Foo owns Bar, Foo owns Baz) → no cycle", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const foo = tw.addProject("Foo");
  tw.addProject("Bar");
  tw.addProject("Baz");
  writeOwns(foo.root, [subEdge("Bar"), subEdge("Baz")]);
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(!issues.some((i) => /ownership cycle/.test(i.message)));
});

// (c) parent/child disagreement (physical nesting w/o declared edge) ---------

test("owns doctor (c): a nested project with no owns edge from the enclosing project → WARN", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const parent = tw.addProject("Parent");
  tw.addProject(path.join("Parent", "Nested"));
  // parent declares nothing
  void parent;
  const issues = doctorWorkspaceOnly(tw.ws);
  const nesting = issues.filter((i) => /physically nested under/.test(i.message));
  assert.equal(nesting.length, 1);
  assert.equal(nesting[0]?.severity, "warn");
  assert.match(nesting[0]?.message ?? "", /Parent\/Nested/);
});

test("owns doctor (c): a nested project WITH a declared owns edge → no warning", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const parent = tw.addProject("Parent");
  tw.addProject(path.join("Parent", "Nested"));
  writeOwns(parent.root, [subEdge(path.join("Parent", "Nested"))]);
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(!issues.some((i) => /physically nested under/.test(i.message)));
});

// (d) duplicate ownership ----------------------------------------------------

test("owns doctor (d): Foo and Baz both own Bar → one ERROR naming Foo+Baz", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const foo = tw.addProject("Foo");
  const baz = tw.addProject("Baz");
  tw.addProject("Bar");
  writeOwns(foo.root, [subEdge("Bar")]);
  writeOwns(baz.root, [subEdge("Bar")]);
  const issues = doctorWorkspaceOnly(tw.ws);
  const dupes = issues.filter((i) => /owned by multiple parents/.test(i.message));
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0]?.severity, "error");
  assert.match(dupes[0]?.message ?? "", /Foo/);
  assert.match(dupes[0]?.message ?? "", /Baz/);
});

test("owns doctor (d): a single owner per child → no duplicate-ownership finding", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const foo = tw.addProject("Foo");
  tw.addProject("Bar");
  writeOwns(foo.root, [subEdge("Bar")]);
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(!issues.some((i) => /owned by multiple parents/.test(i.message)));
});

// (e) ~/code name collision --------------------------------------------------

test("owns doctor (e): two kind:code edges both named firmware → one collision ERROR", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const a = tw.addProject("A");
  const b = tw.addProject("B");
  fs.mkdirSync(path.join(tw.root, "repo1"));
  fs.mkdirSync(path.join(tw.root, "repo2"));
  writeOwns(a.root, [{ ref: "repo1", kind: "code", name: "firmware", lifecycle: null }]);
  writeOwns(b.root, [{ ref: "repo2", kind: "code", name: "firmware", lifecycle: null }]);
  const issues = doctorWorkspaceOnly(tw.ws);
  const coll = issues.filter((i) => /code-child name collision/.test(i.message));
  assert.equal(coll.length, 1);
  assert.equal(coll[0]?.severity, "error");
  assert.match(coll[0]?.message ?? "", /firmware/);
});

test("owns doctor (e): distinct code names → no collision", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const a = tw.addProject("A");
  fs.mkdirSync(path.join(tw.root, "repo1"));
  fs.mkdirSync(path.join(tw.root, "repo2"));
  writeOwns(a.root, [
    { ref: "repo1", kind: "code", name: "fw-a", lifecycle: null },
    { ref: "repo2", kind: "code", name: "fw-b", lifecycle: null },
  ]);
  const issues = doctorWorkspaceOnly(tw.ws);
  assert.ok(!issues.some((i) => /code-child name collision/.test(i.message)));
});

// malformed-edge warnings ----------------------------------------------------

test("owns doctor: a malformed owns edge surfaces as a WARN", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  fs.mkdirSync(path.join(p.root, "_project"), { recursive: true });
  fs.writeFileSync(path.join(p.root, "_project", "project.toml"), `[[owns]]\nref = "X"\nkind = "bogus"\n`);
  const issues = doctorWorkspaceOnly(tw.ws);
  const mal = issues.filter((i) => /malformed owns edge/.test(i.message));
  assert.equal(mal.length, 1);
  assert.equal(mal[0]?.severity, "warn");
});

// workspace-doctor propagation + exit code ----------------------------------

test("owns doctor: an error-severity owns violation flows into doctorWorkspace counts", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  writeOwns(p.root, [subEdge("Nope")]); // dangling subproject → error
  const rep = doctorWorkspace(tw.ws);
  assert.ok(rep.issues.some((i) => /dangling owns edge/.test(i.message)));
  assert.ok(rep.errors >= 1);
});

// detectCycle pure unit ------------------------------------------------------

test("detectCycle: A→B→C→A returns a cycle; a DAG returns null", () => {
  const cyclic = new Map<string, string[]>([
    ["A", ["B"]],
    ["B", ["C"]],
    ["C", ["A"]],
  ]);
  const cycle = detectCycle(cyclic);
  assert.ok(cycle !== null);
  assert.equal(cycle?.[0], cycle?.[cycle.length - 1]);

  assert.equal(
    detectCycle(
      new Map<string, string[]>([
        ["A", ["B"]],
        ["B", []],
      ]),
    ),
    null,
  );
});
