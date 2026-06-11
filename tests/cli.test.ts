/**
 * CLI end-to-end tests: spawn the compiled `dist/src/cli.js` against temp
 * workspaces, with the machine store injected via OPENWORKSPACE_STORE_DIR
 * (never the real ~/Library). Covers dispatch, --json, strict flag parsing,
 * and the 0/1/2 exit-code contract.
 */

import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { makeTmpDir, rmrf } from "./helpers.js";

const CLI = path.resolve(__dirname, "..", "src", "cli.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, storeDir: string): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, OPENWORKSPACE_STORE_DIR: storeDir, OW_ACTOR: "cli-test" },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

interface Fixture {
  root: string; // workspace root (a colon-and-space path inside)
  projectDir: string;
  storeDir: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = makeTmpDir("ow-cli-ws-");
  const storeDir = makeTmpDir("ow-cli-store-");
  const init = run(["home", "init"], root, storeDir);
  assert.equal(init.status, 0, init.stderr);
  const projectDir = path.join(root, "CLI: Proj A");
  const initProj = run(["init", projectDir], root, storeDir);
  assert.equal(initProj.status, 0, initProj.stderr);
  return {
    root,
    projectDir,
    storeDir,
    cleanup: () => {
      rmrf(root);
      rmrf(storeDir);
    },
  };
}

test("cli: no args prints usage and exits 1; help exits 0", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const bare = run([], fx.root, fx.storeDir);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /projects — OpenWorkspace CLI/);

  const help = run(["help"], fx.root, fx.storeDir);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /projects task create/);
  assert.match(help.stdout, /Exit codes: 0 ok · 1 error · 2 canonical-resolution failure/);

  const unknown = run(["frobnicate"], fx.root, fx.storeDir);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command: frobnicate/);
});

test("cli: home init/list/scan/doctor against a temp workspace", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  assert.ok(fs.existsSync(path.join(fx.root, ".openworkspace", "config.toml")));
  assert.ok(fs.existsSync(path.join(fx.projectDir, "_project", "id")));

  const list = run(["home", "list", "--json"], fx.root, fx.storeDir);
  assert.equal(list.status, 0, list.stderr);
  const projects = JSON.parse(list.stdout) as Array<{ relPath: string; lifecycle: string }>;
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.relPath, "CLI: Proj A");
  assert.equal(projects[0]?.lifecycle, "active");

  const scan = run(["home", "scan", "--json"], fx.root, fx.storeDir);
  assert.equal(scan.status, 0, scan.stderr);
  const parsed = JSON.parse(scan.stdout) as { counts: { active: number } };
  assert.equal(parsed.counts.active, 1);

  const doctor = run(["home", "doctor"], fx.root, fx.storeDir);
  assert.equal(doctor.status, 0, doctor.stderr + doctor.stdout);
  assert.match(doctor.stdout, /doctor: no findings/);

  // re-init is idempotent and keeps the same workspace id
  const again = run(["home", "init", "--json"], fx.root, fx.storeDir);
  assert.equal(again.status, 0);
  const ids = [JSON.parse(again.stdout) as { workspaceId: string }];
  assert.match(ids[0]?.workspaceId ?? "", /^[0-9a-f-]{36}$/);
});

test("cli: no-arg init defaults to the cwd, with guard rails", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // a fresh directory inside the workspace: succeeds, stamps the skeleton there
  const fresh = path.join(fx.root, "Fresh: Proj B");
  fs.mkdirSync(fresh);
  const ok = run(["init", "--json"], fresh, fx.storeDir);
  assert.equal(ok.status, 0, ok.stderr);
  const result = JSON.parse(ok.stdout) as { projectRoot: string; uid: string };
  assert.equal(fs.realpathSync(result.projectRoot), fs.realpathSync(fresh));
  assert.ok(fs.existsSync(path.join(fresh, "_project", "id")));

  // re-running in the now-initialized cwd refuses (write-once _project/id)
  const reinit = run(["init"], fresh, fx.storeDir);
  assert.equal(reinit.status, 1);
  assert.match(reinit.stderr, /already a project/);

  // the workspace root itself: refuses, and stamps nothing
  const atRoot = run(["init"], fx.root, fx.storeDir);
  assert.equal(atRoot.status, 1);
  assert.match(atRoot.stderr, /workspace root/);
  assert.ok(!fs.existsSync(path.join(fx.root, "_project")));

  // a configured shelf root: refuses, and stamps nothing
  const shelf = path.join(fx.root, "Dormant Projects");
  fs.mkdirSync(shelf);
  const atShelf = run(["init"], shelf, fx.storeDir);
  assert.equal(atShelf.status, 1);
  assert.match(atShelf.stderr, /shelf root/);
  assert.ok(!fs.existsSync(path.join(shelf, "_project")));

  // outside any workspace: refuses loudly, pointing at the explicit form
  const outside = makeTmpDir("ow-cli-nows-");
  t.after(() => rmrf(outside));
  const noWs = run(["init"], outside, fx.storeDir);
  assert.equal(noWs.status, 1);
  assert.match(noWs.stderr, /not inside a workspace/);
  assert.match(noWs.stderr, /projects init <path>/);
  assert.ok(!fs.existsSync(path.join(outside, "_project")));
});

test("cli: task lifecycle — create, list, guarded done, edit, hide, recur", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const cwd = fx.projectDir; // default project = walk-up from cwd

  const created = run(["task", "create", "Ship the thing", "--quadrant", "q2", "--json"], cwd, fx.storeDir);
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout) as { id: string; quadrant: string };
  assert.equal(task.id, "task-1");
  assert.equal(task.quadrant, "q2");

  const child = run(["task", "create", "Subpiece", "--parent", "task-1", "--json"], cwd, fx.storeDir);
  assert.equal(child.status, 0, child.stderr);
  assert.equal((JSON.parse(child.stdout) as { id: string }).id, "task-1.1");

  const list = run(["task", "list", "--json"], cwd, fx.storeDir);
  const entries = JSON.parse(list.stdout) as Array<{ id: string; subtaskCount: number }>;
  assert.deepEqual(entries.map((e) => e.id), ["task-1"]); // top-level only by default
  assert.equal(entries[0]?.subtaskCount, 1);

  // done without a Final Summary refuses (exit 1)
  const refused = run(["task", "status", "task-1.1", "done"], cwd, fx.storeDir);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Final Summary/);

  // add the summary by hand (any editor counts), then done passes
  const childPath = path.join(fx.projectDir, "_project", "tasks", "task-1.1 - Subpiece.md");
  fs.appendFileSync(childPath, "\n## Final Summary\n\nDecided: skip.\n");
  const done = run(["task", "done", "task-1.1"], cwd, fx.storeDir);
  assert.equal(done.status, 0, done.stderr);

  // greedy-parse defense: an undeclared flag is an error, not a positional
  const greedy = run(["task", "create", "Oops", "--quadrnt", "q2"], cwd, fx.storeDir);
  assert.equal(greedy.status, 1);
  assert.match(greedy.stderr, /quadrnt/);

  // hide + recur round-trip; --project ref form from the workspace root
  const hide = run(["task", "hide", "task-1", "--until", "2099-01-01", "--project", "CLI: Proj A"], fx.root, fx.storeDir);
  assert.equal(hide.status, 0, hide.stderr);
  const hiddenList = run(["task", "list", "--json", "--project", "CLI: Proj A"], fx.root, fx.storeDir);
  assert.deepEqual(JSON.parse(hiddenList.stdout), []);

  const recur = run(["task", "recur", "task-1", "weekly"], cwd, fx.storeDir);
  assert.equal(recur.status, 0, recur.stderr);
  const recurringDone = run(["task", "done", "task-1", "--json"], cwd, fx.storeDir);
  assert.equal(recurringDone.status, 0, recurringDone.stderr);
  const occurrence = JSON.parse(recurringDone.stdout) as { next: string; task: { status: string } };
  assert.match(occurrence.next, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(occurrence.task.status, "done"); // standing record stays open
});

test("cli: decision flow — new, accept, supersede; immutability surfaces as exit 1", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const cwd = fx.projectDir;

  const d1 = run(["decision", "new", "Use maildir for forum", "--json"], cwd, fx.storeDir);
  assert.equal(d1.status, 0, d1.stderr);
  assert.equal((JSON.parse(d1.stdout) as { id: string; status: string }).status, "draft");

  const accept = run(["decision", "accept", "1"], cwd, fx.storeDir);
  assert.equal(accept.status, 0, accept.stderr);

  const d2 = run(["decision", "new", "Actually, tuple spaces", "--json"], cwd, fx.storeDir);
  assert.equal(d2.status, 0);
  const supersede = run(["decision", "supersede", "1", "--by", "2"], cwd, fx.storeDir);
  assert.equal(supersede.status, 0, supersede.stderr);

  const listJson = run(["decision", "list", "--json"], cwd, fx.storeDir);
  const all = JSON.parse(listJson.stdout) as Array<{ id: string; status: string; supersededBy: string | null }>;
  assert.equal(all.find((d) => d.id === "decision-1")?.status, "superseded");
  assert.equal(all.find((d) => d.id === "decision-1")?.supersededBy, "decision-2");

  // accepted records are immutable: re-accept refuses
  const reAccept = run(["decision", "accept", "2"], cwd, fx.storeDir);
  assert.equal(reAccept.status, 0, reAccept.stderr);
  const reReAccept = run(["decision", "accept", "2"], cwd, fx.storeDir);
  assert.equal(reReAccept.status, 1);
});

test("cli: forum flow inside the canonical workspace; doctor flags planted violations", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const cwd = fx.projectDir;

  assert.equal(run(["forum", "announce", "--doing", "cli test pass"], cwd, fx.storeDir).status, 0);
  assert.equal(run(["forum", "open", "CLI thread"], cwd, fx.storeDir).status, 0);
  const post = run(
    ["forum", "post", "cli-thread", "ping", "--kind", "question", "--to", "someone-else", "--json"],
    cwd,
    fx.storeDir,
  );
  assert.equal(post.status, 0, post.stderr);

  const who = run(["forum", "who", "--json"], cwd, fx.storeDir);
  const roster = JSON.parse(who.stdout) as Array<{ participant: string }>;
  assert.ok(roster.some((e) => e.participant === "cli-test"));

  const inbox = run(["forum", "inbox", "--as", "someone-else", "--json"], cwd, fx.storeDir);
  assert.equal((JSON.parse(inbox.stdout) as unknown[]).length, 1);

  assert.equal(run(["forum", "resolve", "cli-thread"], cwd, fx.storeDir).status, 0);
  assert.equal(run(["forum", "archive", "cli-thread"], cwd, fx.storeDir).status, 0);

  // plant a violation: state-named subdir under tasks/ → doctor exits 1
  fs.mkdirSync(path.join(fx.projectDir, "_project", "tasks", "done"));
  const doctor = run(["doctor"], cwd, fx.storeDir);
  assert.equal(doctor.status, 1);
  assert.match(doctor.stdout, /state-named subdirectory/);
});

test("cli: canonical-resolution failure is exit 2 (forum verb outside any known workspace)", (t) => {
  const orphan = makeTmpDir("ow-cli-orphan-");
  const storeDir = makeTmpDir("ow-cli-orphan-store-");
  t.after(() => {
    rmrf(orphan);
    rmrf(storeDir);
  });
  // a project with NO workspace marker above it and a fresh (empty) store
  const projectDir = path.join(orphan, "Lonely");
  fs.mkdirSync(path.join(projectDir, "_project"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "_project", "id"), "lonely-uid\n");

  const result = run(["forum", "announce", "--doing", "hello?"], projectDir, storeDir);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot resolve canonical location/);
});

test("cli: lifecycle moves the project dir and show reflects it", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  const toDormant = run(["lifecycle", "CLI: Proj A", "--to", "dormant", "--json"], fx.root, fx.storeDir);
  assert.equal(toDormant.status, 0, toDormant.stderr);
  const moved = JSON.parse(toDormant.stdout) as { root: string; lifecycle: string };
  assert.equal(moved.lifecycle, "dormant");
  assert.ok(fs.existsSync(path.join(fx.root, "Dormant Projects", "CLI: Proj A", "_project", "id")));
  assert.ok(!fs.existsSync(fx.projectDir));

  const show = run(["show", "--project", path.join("Dormant Projects", "CLI: Proj A"), "--json"], fx.root, fx.storeDir);
  assert.equal(show.status, 0, show.stderr);
  assert.equal((JSON.parse(show.stdout) as { lifecycle: string }).lifecycle, "dormant");
});

// ---------------------------------------------------------------------------
// Regressions: registry seeding, the mint-suffix knob, forum sweep, dashboard config
// ---------------------------------------------------------------------------

test("cli: home init seeds the machine store and writes this machine's synced registry file", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // workspaces.json knows the canonical checkout immediately — not only after
  // the first forum verb (PRD §6.4: UID-registry-first from day one)
  const workspaces = JSON.parse(
    fs.readFileSync(path.join(fx.storeDir, "workspaces.json"), "utf8"),
  ) as string[];
  assert.ok(workspaces.includes(fx.root), `workspaces.json missing ${fx.root}: ${workspaces.join(",")}`);

  // and the new project is already in the UID cache (warm resolution)
  const uid = fs.readFileSync(path.join(fx.projectDir, "_project", "id"), "utf8").trim();
  const cache = JSON.parse(fs.readFileSync(path.join(fx.storeDir, "uid-cache.json"), "utf8")) as Record<string, string>;
  assert.equal(cache[uid], fx.projectDir);

  // §7.3: .openworkspace/machines/<machine-id>.toml exists with a heartbeat
  const machineId = fs.readFileSync(path.join(fx.storeDir, "machine-id"), "utf8").trim();
  const regPath = path.join(fx.root, ".openworkspace", "machines", `${machineId}.toml`);
  assert.ok(fs.existsSync(regPath), `missing machine registry file ${regPath}`);
  const reg = fs.readFileSync(regPath, "utf8");
  assert.match(reg, /machine_id = /);
  assert.match(reg, /heartbeat = /);
});

test("cli: home mint-suffix wires §4.4 machine-suffixed minting end to end", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // default: no suffix
  const show0 = run(["home", "mint-suffix", "--json"], fx.root, fx.storeDir);
  assert.equal(show0.status, 0);
  assert.equal((JSON.parse(show0.stdout) as { mintSuffix: string | null }).mintSuffix, null);

  // set the knob; every subsequent mint on this "machine" takes the suffix
  assert.equal(run(["home", "mint-suffix", "mini"], fx.root, fx.storeDir).status, 0);
  const created = run(["task", "create", "Minted off-canonical", "--json"], fx.projectDir, fx.storeDir);
  assert.equal(created.status, 0, created.stderr);
  const task = JSON.parse(created.stdout) as { id: string };
  assert.equal(task.id, "task-1-mini");

  // a dotted child of the suffixed parent composes the parent's identity
  const child = run(["task", "create", "Child", "--parent", "task-1-mini", "--json"], fx.projectDir, fx.storeDir);
  assert.equal(child.status, 0, child.stderr);
  assert.equal((JSON.parse(child.stdout) as { id: string }).id, "task-1.1-mini");

  // decisions mint with the suffix too
  const dec = run(["decision", "new", "Pick a path", "--json"], fx.projectDir, fx.storeDir);
  assert.equal(dec.status, 0, dec.stderr);
  assert.equal((JSON.parse(dec.stdout) as { id: string }).id, "decision-1-mini");

  // invalid suffixes are rejected; --clear restores plain minting
  assert.equal(run(["home", "mint-suffix", "Bad_Suffix"], fx.root, fx.storeDir).status, 1);
  assert.equal(run(["home", "mint-suffix", "--clear"], fx.root, fx.storeDir).status, 0);
  const plain = run(["task", "create", "Back home", "--json"], fx.projectDir, fx.storeDir);
  assert.equal((JSON.parse(plain.stdout) as { id: string }).id, "task-2");
});

test("cli: home runner-node — show, validated set, clear (decision-1 machine-local fact)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // default: unset (the fallback posture)
  const show0 = run(["home", "runner-node", "--json"], fx.root, fx.storeDir);
  assert.equal(show0.status, 0, show0.stderr);
  assert.equal((JSON.parse(show0.stdout) as { runnerNode: string | null }).runnerNode, null);
  const human0 = run(["home", "runner-node"], fx.root, fx.storeDir);
  assert.match(human0.stdout, /no runner-node configured/);

  // a nonexistent path is rejected loudly — nothing persisted
  const missing = run(["home", "runner-node", path.join(fx.root, "nope", "node")], fx.root, fx.storeDir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /does not exist/);
  assert.equal(
    (JSON.parse(run(["home", "runner-node", "--json"], fx.root, fx.storeDir).stdout) as { runnerNode: string | null })
      .runnerNode,
    null,
  );

  // a real executable sets and reads back (process.execPath always qualifies)
  const set = run(["home", "runner-node", process.execPath, "--json"], fx.root, fx.storeDir);
  assert.equal(set.status, 0, set.stderr);
  assert.equal((JSON.parse(set.stdout) as { runnerNode: string }).runnerNode, process.execPath);
  const show1 = run(["home", "runner-node"], fx.root, fx.storeDir);
  assert.ok(show1.stdout.includes(`runner-node: ${process.execPath}`), show1.stdout);

  // --clear restores the fallback posture
  assert.equal(run(["home", "runner-node", "--clear"], fx.root, fx.storeDir).status, 0);
  const show2 = run(["home", "runner-node", "--json"], fx.root, fx.storeDir);
  assert.equal((JSON.parse(show2.stdout) as { runnerNode: string | null }).runnerNode, null);
});

test("cli: forum sweep removes own-machine stale presence and PROPOSES thread archives", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // a stale own-machine presence file + a foreign machine's stale file
  const machineId = fs.readFileSync(path.join(fx.storeDir, "machine-id"), "utf8").trim();
  const presenceDir = path.join(fx.projectDir, "_project", "forum", "presence");
  const oldTs = "2026-01-01T00:00:00Z";
  fs.writeFileSync(
    path.join(presenceDir, `${machineId}--old-agent.md`),
    `---\nparticipant: old-agent\nmachine: ${machineId}\nts: ${oldTs}\n---\n`,
  );
  fs.writeFileSync(
    path.join(presenceDir, "other-machine--their-agent.md"),
    `---\nparticipant: their-agent\nmachine: other-machine\nts: ${oldTs}\n---\n`,
  );
  // an anciently-resolved thread
  const threadDir = path.join(fx.projectDir, "_project", "forum", "threads", "2026-01-02--done-stream");
  fs.mkdirSync(threadDir, { recursive: true });
  fs.writeFileSync(
    path.join(threadDir, "thread.md"),
    `---\ntitle: Done\nstatus: resolved\nopened: 2026-01-02T00:00:00Z\nresolved: 2026-01-03T00:00:00Z\n---\n`,
  );

  const result = run(["forum", "sweep", "--json"], fx.projectDir, fx.storeDir);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { presenceRemoved: string[]; archiveProposals: Array<{ name: string }> };
  assert.equal(parsed.presenceRemoved.length, 1, "only the OWN-machine stale file is removed (P15)");
  assert.match(parsed.presenceRemoved[0] ?? "", /old-agent\.md$/);
  assert.ok(fs.existsSync(path.join(presenceDir, "other-machine--their-agent.md")), "foreign presence untouched");
  assert.deepEqual(parsed.archiveProposals.map((p) => p.name), ["2026-01-02--done-stream"]);
  assert.ok(fs.existsSync(threadDir), "proposal only — the thread was NOT archived");
});

test("cli: dashboard --config is accepted per §8 and fails loudly on a bad file", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // strict parseArgs no longer rejects the §8 flag; a missing config file is
  // an ordinary exit-1 error (the server never starts)
  const missing = run(["dashboard", "dev", "--config", "no-such-config.toml"], fx.root, fx.storeDir);
  assert.equal(missing.status, 1);
  assert.ok(!/Unknown option/i.test(missing.stderr), missing.stderr);

  const badPort = path.join(fx.root, "dash.toml");
  fs.writeFileSync(badPort, `port = "not-a-number"\n`);
  const bad = run(["dashboard", "dev", "--config", badPort], fx.root, fx.storeDir);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /port.*must be an integer/);
});

test("cli: dashboard accepts --host / --allow-host and validates the config host keys", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);

  // strict parseArgs must NOT reject the new flags (they're declared). A
  // non-numeric --port still fails at validation, proving the flags parsed.
  const flags = run(
    ["dashboard", "dev", "--host", "0.0.0.0", "--allow-host", "a.ts.net", "--allow-host", "b.ts.net", "--port", "nope"],
    fx.root,
    fx.storeDir,
  );
  assert.equal(flags.status, 1);
  assert.ok(!/Unknown option/i.test(flags.stderr), flags.stderr);
  assert.match(flags.stderr, /invalid --port/);

  // config `host` must be a string
  const badHost = path.join(fx.root, "dash-host.toml");
  fs.writeFileSync(badHost, `host = 123\n`);
  const bh = run(["dashboard", "dev", "--config", badHost], fx.root, fx.storeDir);
  assert.equal(bh.status, 1);
  assert.match(bh.stderr, /host.*must be a string/);

  // config `allowed_hosts` must be an array of strings
  const badAllow = path.join(fx.root, "dash-allow.toml");
  fs.writeFileSync(badAllow, `allowed_hosts = "not-an-array"\n`);
  const ba = run(["dashboard", "dev", "--config", badAllow], fx.root, fx.storeDir);
  assert.equal(ba.status, 1);
  assert.match(ba.stderr, /allowed_hosts.*must be an array of strings/);
});

// --- decision-2: metadata-primary lifecycle + reconcile ---

test("cli: lifecycle --to dormant writes project.toml AND moves the folder (metadata-primary)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const r = run(["lifecycle", "CLI: Proj A", "--to", "dormant", "--json"], fx.root, fx.storeDir);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout) as { root: string; lifecycle: string };
  assert.equal(parsed.lifecycle, "dormant");
  // folder moved into the shelf
  const shelved = path.join(fx.root, "Dormant Projects", "CLI: Proj A");
  assert.ok(fs.existsSync(shelved), "folder filed into Dormant Projects/");
  // AND the declared metadata is written (the source of truth)
  const toml = fs.readFileSync(path.join(shelved, "_project", "project.toml"), "utf8");
  assert.match(toml, /lifecycle = "dormant"/);
  assert.match(toml, /lifecycle_set =/, "the audit stamp is recorded");
});

test("cli: lifecycle --to ongoing is rejected (ongoing dropped 2026-06-11)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const r = run(["lifecycle", "CLI: Proj A", "--to", "ongoing", "--json"], fx.root, fx.storeDir);
  assert.notEqual(r.status, 0, "ongoing is no longer a valid lifecycle value");
  assert.match(r.stderr, /active\|dormant\|archived/);
  // unchanged: still top-level, no project.toml written
  assert.ok(fs.existsSync(fx.projectDir), "the project is untouched");
});

test("cli: reconcile dry-run heals an iCloud-glitch move via the intent-log; --apply moves it", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  // declare dormant — this moves the folder into the shelf AND records an intent
  // line in the store.
  const shelf = path.join(fx.root, "Dormant Projects");
  const shelved = path.join(shelf, "CLI: Proj A");
  assert.equal(run(["lifecycle", "CLI: Proj A", "--to", "dormant"], fx.root, fx.storeDir).status, 0);
  assert.ok(fs.existsSync(shelved), "filed into the shelf");

  // simulate iCloud spuriously moving the folder back to the top level (no
  // command): metadata still says dormant, location now reads active → glitch.
  fs.renameSync(shelved, fx.projectDir);

  // dry-run proposes a revert, changes nothing
  const dry = run(["reconcile", "--json"], fx.root, fx.storeDir);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout) as { actions: Array<{ kind: string }> };
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0]?.kind, "revert-location");
  assert.ok(fs.existsSync(fx.projectDir), "dry-run did not move it");

  // apply moves it back into the shelf (metadata wins; glitch undone)
  const applied = run(["reconcile", "--apply"], fx.root, fx.storeDir);
  assert.equal(applied.status, 0, applied.stderr);
  assert.ok(fs.existsSync(shelved), "reconcile --apply reverted the glitch back to the shelf");
});

test("cli: reconcile on a clean workspace is a no-op (exit 0)", (t) => {
  const fx = makeFixture();
  t.after(fx.cleanup);
  const r = run(["reconcile"], fx.root, fx.storeDir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no drift/);
});
