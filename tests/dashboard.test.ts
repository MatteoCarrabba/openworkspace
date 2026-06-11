/**
 * Dashboard v1 tests — scan shape against a temp workspace, Host-header
 * rejection (DNS-rebinding defense), loopback-only binding, no mutation
 * routes. Everything runs against os.tmpdir(); the live workspace and the
 * real ~/Library are never touched.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { test } from "node:test";

import {
  AutomationsScanResult,
  RunningDashboard,
  ScanResult,
  buildAllowedHosts,
  hostAllowed,
  scanAutomations,
  scanWorkspace,
  startDashboard,
} from "../src/dashboard/server.js";
import { MARKER_DIR, openWorkspace } from "../src/lib/workspace.js";
import { makeTmpWorkspace, TmpWorkspace } from "./helpers.js";

const NOW = new Date("2026-06-10T15:00:00Z");

function writeTask(projectRoot: string, fileName: string, frontmatter: string, body = ""): void {
  const dir = path.join(projectRoot, "_project", "tasks");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), `---\n${frontmatter}\n---\n${body}`);
}

/** A workspace with the shapes the scan must handle. Colon + space in a path. */
function buildFixtureWorkspace(): TmpWorkspace {
  const tmp = makeTmpWorkspace('workspace_id = "ws-dash-test"\n');

  const alpha = tmp.addProject("Alpha Project", "uid-alpha");
  writeTask(
    alpha.root,
    "task-1 - parent.md",
    "id: task-1\ntitle: Parent task\nstatus: doing\nquadrant: q2",
    "## Description\n\nParent body with `code` and **bold**.\n"
  );
  writeTask(alpha.root, "task-1.1 - child done.md", "id: task-1.1\ntitle: Child done\nstatus: done");
  writeTask(alpha.root, "task-1.2 - child waiting.md", "id: task-1.2\ntitle: Child waiting\nstatus: waiting");
  writeTask(alpha.root, "task-1.2.1 - grandchild.md", "id: task-1.2.1\ntitle: Grandchild\nstatus: todo");
  writeTask(alpha.root, "task-2 - review me.md", "id: task-2\ntitle: Review me\nstatus: review");
  writeTask(
    alpha.root,
    "task-3 - hidden future.md",
    "id: task-3\ntitle: Hidden future\nstatus: todo\nhidden_until: 2026-07-01"
  );
  writeTask(
    alpha.root,
    "task-4 - unhid today.md",
    "id: task-4\ntitle: Unhid today\nstatus: todo\nhidden_until: 2026-06-10"
  );
  // archive/ is retention — must NOT appear in the scan
  const archiveDir = path.join(alpha.root, "_project", "tasks", "archive");
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(
    path.join(archiveDir, "task-99 - archived.md"),
    "---\nid: task-99\ntitle: Archived\nstatus: done\n---\n"
  );

  // Doctor-error material, in a project with colon + space in the name
  const beta = tmp.addProject("Beta: With Colon", "uid-beta");
  writeTask(beta.root, "task-1 - done but recurring.md", "id: task-1\ntitle: Done but recurring\nstatus: done\nrecur: weekly");
  writeTask(beta.root, "task-2 - bad hidden.md", "id: task-2\ntitle: Bad hidden\nstatus: todo\nhidden_until: not-a-date");
  fs.writeFileSync(
    path.join(beta.root, "_project", "tasks", "task-3 - broken yaml.md"),
    "---\ntitle: [unclosed\n---\nbody\n"
  );

  tmp.addProject(path.join("Dormant Projects", "Sleepy"), "uid-sleepy");
  tmp.addProject(path.join("Archives", "Finished"), "uid-finished");
  return tmp;
}

async function get(
  port: number,
  reqPath: string,
  options: { method?: string; host?: string | null } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (options.host !== null) headers["host"] = options.host ?? `127.0.0.1:${port}`;
    const req = http.request(
      { host: "127.0.0.1", port, path: reqPath, method: options.method ?? "GET", headers, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function startFixtureDashboard(tmp: TmpWorkspace): Promise<RunningDashboard> {
  return startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
}

// ---------------------------------------------------------------------------
// scanWorkspace (direct, no HTTP)

test("scan: projects carry lifecycle, name, uid; shelves included", () => {
  const tmp = buildFixtureWorkspace();
  try {
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    assert.equal(scan.workspace.workspaceId, "ws-dash-test");
    assert.equal(scan.workspace.root, tmp.root);
    assert.equal(scan.generatedAt, NOW.toISOString());

    const byUid = new Map(scan.projects.map((p) => [p.uid, p]));
    assert.equal(byUid.get("uid-alpha")?.lifecycle, "active");
    assert.equal(byUid.get("uid-alpha")?.name, "Alpha Project");
    assert.equal(byUid.get("uid-beta")?.name, "Beta: With Colon");
    assert.equal(byUid.get("uid-sleepy")?.lifecycle, "dormant");
    assert.equal(byUid.get("uid-finished")?.lifecycle, "archived");

    assert.deepEqual(scan.counts, { active: 2, dormant: 1, archived: 1, all: 4 });
  } finally {
    tmp.cleanup();
  }
});

test("scan: dotted hierarchy — parentId/depth from the ID alone", () => {
  const tmp = buildFixtureWorkspace();
  try {
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    const alpha = scan.projects.find((p) => p.uid === "uid-alpha")!;
    const byId = new Map(alpha.tasks.map((t) => [t.id, t]));

    assert.equal(byId.get("task-1")?.parentId, null);
    assert.equal(byId.get("task-1")?.depth, 0);
    assert.equal(byId.get("task-1.2")?.parentId, "task-1");
    assert.equal(byId.get("task-1.2")?.depth, 1);
    assert.equal(byId.get("task-1.2.1")?.parentId, "task-1.2");
    assert.equal(byId.get("task-1.2.1")?.depth, 2);

    // sorted numerically by ID parts
    assert.deepEqual(
      alpha.tasks.map((t) => t.id),
      ["task-1", "task-1.1", "task-1.2", "task-1.2.1", "task-2", "task-3", "task-4"]
    );

    // archive/ excluded
    assert.equal(byId.has("task-99"), false);
  } finally {
    tmp.cleanup();
  }
});

test("scan: truthful rollups inherit the most attention-demanding descendant", () => {
  const tmp = buildFixtureWorkspace();
  try {
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    const alpha = scan.projects.find((p) => p.uid === "uid-alpha")!;
    const byId = new Map(alpha.tasks.map((t) => [t.id, t]));

    const parent = byId.get("task-1")!;
    assert.deepEqual(parent.rollup, { total: 3, done: 1, status: "waiting" });
    const mid = byId.get("task-1.2")!;
    assert.deepEqual(mid.rollup, { total: 1, done: 0, status: "waiting" });
    assert.equal(byId.get("task-2")?.rollup, null);
  } finally {
    tmp.cleanup();
  }
});

test("scan: hidden_until filtering flags + tasks-unhidden-today", () => {
  const tmp = buildFixtureWorkspace();
  try {
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    const alpha = scan.projects.find((p) => p.uid === "uid-alpha")!;
    const byId = new Map(alpha.tasks.map((t) => [t.id, t]));

    assert.equal(byId.get("task-3")?.hidden, true);
    assert.equal(byId.get("task-3")?.unhiddenToday, false);
    assert.equal(byId.get("task-4")?.hidden, false);
    assert.equal(byId.get("task-4")?.unhiddenToday, true);
    assert.equal(byId.get("task-1")?.hidden, false);
    assert.equal(alpha.taskCounts.hidden, 1);
  } finally {
    tmp.cleanup();
  }
});

test("scan: attention counts — waiting/review/unhiddenToday over active projects, doctor errors", () => {
  const tmp = buildFixtureWorkspace();
  try {
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    assert.equal(scan.attention.waiting, 1); // task-1.2
    assert.equal(scan.attention.review, 1); // task-2
    assert.equal(scan.attention.unhiddenToday, 1); // task-4
    // beta: done+recur, bad hidden_until, broken yaml frontmatter
    assert.equal(scan.attention.doctorErrors, 3);
    assert.equal(scan.doctor.errors.length, 3);
    const messages = scan.doctor.errors.map((e) => e.message).join("\n");
    assert.match(messages, /status done with recur set/);
    assert.match(messages, /unparseable hidden_until/);
    assert.match(messages, /unparseable frontmatter/);
    for (const e of scan.doctor.errors) assert.equal(e.project, "Beta: With Colon");
  } finally {
    tmp.cleanup();
  }
});

test("scan: duplicate project UIDs count as doctor errors", () => {
  const tmp = makeTmpWorkspace();
  try {
    tmp.addProject("One", "uid-dup");
    tmp.addProject("Two", "uid-dup");
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    assert.equal(scan.attention.doctorErrors, 1);
    assert.match(scan.doctor.errors[0]!.message, /duplicate project uid uid-dup/);
  } finally {
    tmp.cleanup();
  }
});

test("scan: attention ignores dormant/archived projects", () => {
  const tmp = makeTmpWorkspace();
  try {
    const sleepy = tmp.addProject(path.join("Dormant Projects", "Sleepy"), "uid-s");
    writeTask(sleepy.root, "task-1 - w.md", "id: task-1\ntitle: W\nstatus: waiting");
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    assert.equal(scan.attention.waiting, 0);
    // ...but the task is still in the project payload for the Dormant scope
    assert.equal(scan.projects[0]?.tasks.length, 1);
  } finally {
    tmp.cleanup();
  }
});

test("scan: project without a tasks dir yields empty tasks, no errors", () => {
  const tmp = makeTmpWorkspace();
  try {
    tmp.addProject("Bare", "uid-bare");
    const scan = scanWorkspace(openWorkspace(tmp.root), NOW);
    assert.deepEqual(scan.projects[0]?.tasks, []);
    assert.equal(scan.attention.doctorErrors, 0);
  } finally {
    tmp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// HTTP surface

test("http: binds 127.0.0.1 only", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  const addr = running.server.address();
  assert.ok(addr && typeof addr !== "string");
  assert.equal(addr.address, "127.0.0.1");
});

test("http: GET /api/scan returns the live scan as JSON", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  const res = await get(running.port, "/api/scan");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /application\/json/);
  const scan = JSON.parse(res.body) as ScanResult;
  assert.equal(scan.workspace.workspaceId, "ws-dash-test");
  assert.equal(scan.counts.all, 4);
  assert.equal(scan.attention.waiting, 1);
  assert.equal(scan.attention.doctorErrors, 3);
  const alpha = scan.projects.find((p) => p.uid === "uid-alpha")!;
  assert.equal(alpha.tasks.find((t2) => t2.id === "task-1")?.rollup?.status, "waiting");
  // body ships for the detail pane
  assert.match(alpha.tasks.find((t2) => t2.id === "task-1")!.body, /Parent body/);
});

test("http: scan is live — a task added after startup appears on the next request", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  const before = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  const alphaRoot = path.join(tmp.root, "Alpha Project");
  writeTask(alphaRoot, "task-5 - fresh.md", "id: task-5\ntitle: Fresh\nstatus: todo");
  const after = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  const count = (s: ScanResult) => s.projects.find((p) => p.uid === "uid-alpha")!.tasks.length;
  assert.equal(count(after), count(before) + 1);
});

test("http: Host header validated — DNS-rebinding defense", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  for (const bad of ["evil.example.com", "evil.example.com:80", `attacker.test:${running.port}`, "[::1]:8080", ""]) {
    const res = await get(running.port, "/api/scan", { host: bad });
    assert.equal(res.status, 403, `host ${JSON.stringify(bad)} must be rejected`);
  }
  for (const good of [`127.0.0.1:${running.port}`, "127.0.0.1", `localhost:${running.port}`, "localhost", "LOCALHOST"]) {
    const res = await get(running.port, "/api/scan", { host: good });
    assert.equal(res.status, 200, `host ${JSON.stringify(good)} must be accepted`);
  }
});

test("hostAllowed: unit edges", () => {
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed("127.0.0.1.evil.com"), false);
  assert.equal(hostAllowed("localhost.evil.com"), false);
  assert.equal(hostAllowed("[::1]"), false); // spec: localhost/127.0.0.1 only
  assert.equal(hostAllowed("127.0.0.1:9999"), true);
});

// ---------------------------------------------------------------------------
// Tailnet-serving opt-in (configurable bind host + extensible allowlist).
// SECURE DEFAULT (no host/allow-host configured) stays localhost-only.

test("buildAllowedHosts: default ∪ configured; :port and IPv6 brackets normalized", () => {
  // default-only: exactly the secure set
  const def = buildAllowedHosts();
  assert.equal(def.has("localhost"), true);
  assert.equal(def.has("127.0.0.1"), true);
  assert.equal(def.has("matteos-mac-mini.tailbd8a21.ts.net"), false);

  // configured: tailnet name (with a :port), a tailnet IP, plus the defaults
  const ext = buildAllowedHosts(["matteos-mac-mini.tailbd8a21.ts.net:7777", "100.120.153.52", "[::1]"]);
  assert.equal(ext.has("localhost"), true, "default survives");
  assert.equal(ext.has("127.0.0.1"), true, "default survives");
  assert.equal(ext.has("matteos-mac-mini.tailbd8a21.ts.net"), true, ":port stripped");
  assert.equal(ext.has("100.120.153.52"), true);
  assert.equal(ext.has("::1"), true, "IPv6 brackets stripped");
});

test("hostAllowed: a configured allow-host passes (with/without :port); unconfigured still 403-worthy", () => {
  const allowed = buildAllowedHosts(["matteos-mac-mini.tailbd8a21.ts.net", "100.120.153.52"]);
  // configured host passes, bare and with a :port
  assert.equal(hostAllowed("matteos-mac-mini.tailbd8a21.ts.net", allowed), true);
  assert.equal(hostAllowed("matteos-mac-mini.tailbd8a21.ts.net:7777", allowed), true);
  assert.equal(hostAllowed("100.120.153.52:7777", allowed), true);
  // the secure defaults still pass
  assert.equal(hostAllowed("localhost", allowed), true);
  assert.equal(hostAllowed("127.0.0.1:7777", allowed), true);
  // an UNCONFIGURED host is still rejected — DNS-rebinding defense intact
  assert.equal(hostAllowed("evil.example.com", allowed), false);
  assert.equal(hostAllowed("other.ts.net", allowed), false);
});

test("http: binds a NON-localhost host when asked (0.0.0.0)", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW, host: "0.0.0.0" });
  t.after(() => running.close());

  const addr = running.server.address();
  assert.ok(addr && typeof addr !== "string");
  assert.equal(addr.address, "0.0.0.0", "bound the requested host, not loopback");
  assert.match(running.url, /^http:\/\/0\.0\.0\.0:/);
});

test("http: a configured allowed-host passes; an unconfigured one still 403s", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  // bind 0.0.0.0 (reachable over 127.0.0.1) and allow a tailnet name.
  const running = await startDashboard({
    workspaceRoot: tmp.root,
    now: () => NOW,
    host: "0.0.0.0",
    allowedHosts: ["matteos-mac-mini.tailbd8a21.ts.net"],
  });
  t.after(() => running.close());

  // the configured tailnet Host passes (bare and with a :port)
  for (const ok of ["matteos-mac-mini.tailbd8a21.ts.net", `matteos-mac-mini.tailbd8a21.ts.net:${running.port}`]) {
    const res = await get(running.port, "/api/scan", { host: ok });
    assert.equal(res.status, 200, `configured host ${JSON.stringify(ok)} must pass`);
  }
  // the secure defaults still pass
  assert.equal((await get(running.port, "/api/scan", { host: "localhost" })).status, 200);
  // an UNCONFIGURED host is still rejected
  for (const bad of ["evil.example.com", "other.ts.net", `attacker.test:${running.port}`]) {
    const res = await get(running.port, "/api/scan", { host: bad });
    assert.equal(res.status, 403, `unconfigured host ${JSON.stringify(bad)} must 403`);
  }
});

test("http: DEFAULT behavior unchanged — no host/allow-host ⇒ loopback bind + loopback-only Host", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
  t.after(() => running.close());

  const addr = running.server.address();
  assert.ok(addr && typeof addr !== "string");
  assert.equal(addr.address, "127.0.0.1", "secure default still binds loopback");

  // a tailnet name is NOT allowed by default
  assert.equal(
    (await get(running.port, "/api/scan", { host: "matteos-mac-mini.tailbd8a21.ts.net" })).status,
    403,
  );
  // loopback still works
  assert.equal((await get(running.port, "/api/scan", { host: "127.0.0.1" })).status, 200);
});

test("http: zero mutation endpoints — non-GET/HEAD rejected everywhere", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    for (const reqPath of ["/api/scan", "/", "/api/task", "/anything"]) {
      const res = await get(running.port, reqPath, { method });
      assert.equal(res.status, 405, `${method} ${reqPath} must be 405`);
      assert.equal(res.headers["allow"], "GET, HEAD");
    }
  }
});

test("http: serves the single-file index.html at /", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  const res = await get(running.port, "/");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /text\/html/);
  assert.match(res.body, /OpenWorkspace dashboard v1/);
  assert.match(res.body, /\/api\/scan/);
  // no external CDN deps in the page
  assert.doesNotMatch(res.body, /https?:\/\/(cdn|unpkg|jsdelivr|googleapis)/);
});

test("http: unknown GET paths are 404, not file reads", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  for (const p of ["/etc/passwd", "/../package.json", "/api/other"]) {
    const res = await get(running.port, p);
    assert.equal(res.status, 404, `${p} must 404`);
  }
});

test("http: scan endpoint writes nothing into the workspace", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startFixtureDashboard(tmp);
  t.after(() => running.close());

  const snapshot = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        out.push(full);
        if (e.isDirectory()) walk(full);
      }
    };
    walk(tmp.root);
    return out.sort();
  };
  const before = snapshot();
  await get(running.port, "/api/scan");
  await get(running.port, "/");
  assert.deepEqual(snapshot(), before);
});

// ---------------------------------------------------------------------------
// In-memory scan cache (short-TTL, stale-while-revalidate). All against a temp
// workspace with a MUTABLE injected clock so TTL behavior is deterministic.

/** A clock the test advances by hand; drives both `now()` and the cache age. */
function mutableClock(start: Date): { now: () => Date; advance: (ms: number) => void } {
  let cur = start.getTime();
  return { now: () => new Date(cur), advance: (ms: number) => (cur += ms) };
}

/** Let the cache's setImmediate background rebuild run to completion. */
function flushBackground(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve())));
}

const TTL = 15_000;

test("cache: serves a stale-but-recent result within the TTL, then rebuilds after it", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const clock = mutableClock(NOW);
  const running = await startDashboard({ workspaceRoot: tmp.root, now: clock.now, cacheTtlMs: TTL });
  t.after(() => running.close());

  // 1) Cold request builds and caches.
  const first = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  const alphaCount = (s: ScanResult) => s.projects.find((p) => p.uid === "uid-alpha")!.tasks.length;
  const n0 = alphaCount(first);

  // Mutate the live tree, then request again BEFORE the TTL elapses.
  writeTask(path.join(tmp.root, "Alpha Project"), "task-5 - fresh.md", "id: task-5\ntitle: Fresh\nstatus: todo");
  clock.advance(TTL - 1);
  const cachedResp = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(alphaCount(cachedResp), n0, "within TTL ⇒ still the cached scan, new task NOT yet visible");
  assert.equal(cachedResp.generatedAt, first.generatedAt, "cached scan keeps its original build time");

  // Cross the TTL: this request serves stale-but-recent AND triggers a rebuild.
  clock.advance(2);
  const staleResp = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(alphaCount(staleResp), n0, "expired request still serves the prior (recent) scan synchronously");

  // After the background rebuild lands, the next request reflects the live tree.
  await flushBackground();
  const rebuilt = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(alphaCount(rebuilt), n0 + 1, "after the background rebuild the new task appears");
});

test("cache: TTL 0 disables caching — every request is fresh against the live tree", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const clock = mutableClock(NOW);
  // cacheTtlMs defaults to 0; pass it explicitly to be unambiguous.
  const running = await startDashboard({ workspaceRoot: tmp.root, now: clock.now, cacheTtlMs: 0 });
  t.after(() => running.close());

  const alphaCount = (s: ScanResult) => s.projects.find((p) => p.uid === "uid-alpha")!.tasks.length;
  const before = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  // No clock advance at all: a new task must appear on the very next request.
  writeTask(path.join(tmp.root, "Alpha Project"), "task-5 - fresh.md", "id: task-5\ntitle: Fresh\nstatus: todo");
  const after = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(alphaCount(after), alphaCount(before) + 1, "TTL 0 ⇒ no cache ⇒ immediately fresh");
});

test("cache: the scan timestamp reflects BUILD time, never request time (honest freshness)", async (t) => {
  const tmp = buildFixtureWorkspace();
  t.after(() => tmp.cleanup());
  const clock = mutableClock(NOW);
  const running = await startDashboard({ workspaceRoot: tmp.root, now: clock.now, cacheTtlMs: TTL });
  t.after(() => running.close());

  // Cold build stamps generatedAt at NOW.
  const first = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(first.generatedAt, NOW.toISOString());

  // Advance the clock well within the TTL and request again: the served
  // timestamp must NOT move to the (later) request time — it stays the build time.
  clock.advance(TTL - 1);
  const later = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(later.generatedAt, NOW.toISOString(), "cached scan never shows a fake-fresh time");

  // Force a rebuild at a known later instant; the new scan stamps THAT instant.
  clock.advance(2); // now NOW + TTL + 1 ⇒ expired
  const rebuildInstant = clock.now();
  await get(running.port, "/api/scan"); // serves stale, kicks off rebuild at rebuildInstant
  await flushBackground();
  const rebuilt = JSON.parse((await get(running.port, "/api/scan")).body) as ScanResult;
  assert.equal(rebuilt.generatedAt, rebuildInstant.toISOString(), "rebuilt scan stamps its own build time");
});

// ---------------------------------------------------------------------------
// Automations view — synced per-machine registries × declared manifests.
// Everything against a temp workspace with MOCK machine registries + manifests.
// Cases exercised: active-here, declared-elsewhere (declared-but-not-activated),
// and activated-but-undeclared drift; plus heartbeat staleness + last-run join.

function writeManifest(projectRoot: string, name: string, body: string): void {
  const dir = path.join(projectRoot, "_project", "automations", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "automation.toml"), body);
}

function writeRegistry(wsRoot: string, machineId: string, body: string): void {
  const dir = path.join(wsRoot, MARKER_DIR, "machines");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${machineId}.toml`), body);
}

/**
 * A workspace whose automations cover the join cases:
 *  - "brief-refresh" (uid-alpha): declared [mini, laptop]; activated on mini
 *    (with a last-run) — laptop is declared-but-not-activated drift.
 *  - "finance-sync" (uid-alpha): declared [mini]; activated on mini — clean.
 *  - "rogue" (uid-beta): declared [] (no-machines ⇒ invalid manifest), yet the
 *    mini registry activates it — activated-but-undeclared drift + invalid.
 * The mini heartbeat is fresh; the laptop heartbeat is stale (2 days old).
 */
function buildAutomationsWorkspace(): TmpWorkspace {
  const tmp = makeTmpWorkspace('workspace_id = "ws-auto-test"\n');
  const alpha = tmp.addProject("Alpha Project", "uid-alpha");
  const beta = tmp.addProject("Beta: With Colon", "uid-beta");

  writeManifest(
    alpha.root,
    "brief-refresh",
    'machines = ["mini", "laptop"]\n[schedule]\ncron = "0 7 * * *"\n[run]\ncommand = ["echo", "hi"]\n',
  );
  writeManifest(
    alpha.root,
    "finance-sync",
    'machines = ["mini"]\n[schedule]\ncron = "30 6 * * *"\n[run]\ncommand = ["echo", "sync"]\n',
  );
  // invalid: no machines declared
  writeManifest(
    beta.root,
    "rogue",
    '[schedule]\ncron = "0 0 * * *"\n[run]\ncommand = ["echo", "rogue"]\n',
  );

  // mini: fresh, activates brief-refresh + finance-sync (alpha) + rogue (beta).
  writeRegistry(
    tmp.root,
    "mini",
    [
      'machine_id = "mini"',
      'heartbeat = "2026-06-10T14:50:00Z"', // 10 min before NOW
      "",
      "[[activations]]",
      'project_uid = "uid-alpha"',
      'name = "brief-refresh"',
      'label = "com.openworkspace.uid-alpha.brief-refresh"',
      'applied_at = "2026-06-01T00:00:00Z"',
      'schedule = "cron 0 7 * * *"',
      "",
      "[[activations]]",
      'project_uid = "uid-alpha"',
      'name = "finance-sync"',
      'label = "com.openworkspace.uid-alpha.finance-sync"',
      'applied_at = "2026-06-01T00:00:00Z"',
      'schedule = "cron */15 * * * *"',
      "",
      "[[activations]]",
      'project_uid = "uid-beta"',
      'name = "rogue"',
      'label = "com.openworkspace.uid-beta.rogue"',
      'applied_at = "2026-06-01T00:00:00Z"',
      'schedule = "cron 0 0 * * *"',
      "",
      "[last_runs.\"uid-alpha--brief-refresh\"]",
      'started_at = "2026-06-10T07:00:00Z"',
      'finished_at = "2026-06-10T07:00:12Z"',
      'status = "ok"',
      "exit_code = 0",
      "",
      "[last_runs.\"uid-alpha--finance-sync\"]",
      'started_at = "2026-06-10T14:45:00Z"',
      'finished_at = "2026-06-10T14:45:03Z"',
      'status = "fail"',
      "exit_code = 1",
      "",
    ].join("\n") + "\n",
  );

  // laptop: stale (2 days old), declares brief-refresh but has NO activations.
  writeRegistry(
    tmp.root,
    "laptop",
    ['machine_id = "laptop"', 'heartbeat = "2026-06-08T15:00:00Z"', ""].join("\n") + "\n",
  );

  return tmp;
}

test("automations scan: machine registry strip — ids, staleness, activation counts", () => {
  const tmp = buildAutomationsWorkspace();
  try {
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    assert.equal(r.workspace.workspaceId, "ws-auto-test");
    assert.equal(r.generatedAt, NOW.toISOString());
    const byId = new Map(r.machines.map((m) => [m.machineId, m]));
    assert.equal(byId.get("mini")?.staleMinutes, 10);
    assert.equal(byId.get("mini")?.activationCount, 3);
    assert.equal(byId.get("laptop")?.staleMinutes, 2 * 24 * 60);
    assert.equal(byId.get("laptop")?.activationCount, 0);
  } finally {
    tmp.cleanup();
  }
});

test("automations scan: active-here joins last-run + schedule; declared-elsewhere flagged", () => {
  const tmp = buildAutomationsWorkspace();
  try {
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    const br = r.automations.find((a) => a.name === "brief-refresh")!;
    assert.deepEqual(br.declaredMachines, ["mini", "laptop"]);
    assert.deepEqual(br.activatedOn, ["mini"]);
    assert.equal(br.valid, true);
    assert.equal(br.schedule, "cron 0 7 * * *");

    const mini = br.machines.find((m) => m.machineId === "mini")!;
    assert.equal(mini.activated, true);
    assert.equal(mini.declared, true);
    assert.equal(mini.lastRun?.status, "ok");
    assert.equal(mini.lastRun?.finishedAt, "2026-06-10T07:00:12Z");
    assert.equal(mini.staleMinutes, 10);

    const laptop = br.machines.find((m) => m.machineId === "laptop")!;
    assert.equal(laptop.activated, false);
    assert.equal(laptop.declared, true);
    assert.equal(laptop.lastRun, null);

    // declared-but-not-activated drift on laptop
    assert.equal(br.drift.length, 1);
    assert.equal(br.drift[0]!.kind, "declared-not-activated");
    assert.equal(br.drift[0]!.machineId, "laptop");
  } finally {
    tmp.cleanup();
  }
});

test("automations scan: clean automation has no drift; fail last-run surfaced", () => {
  const tmp = buildAutomationsWorkspace();
  try {
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    const fs2 = r.automations.find((a) => a.name === "finance-sync")!;
    assert.deepEqual(fs2.activatedOn, ["mini"]);
    assert.equal(fs2.drift.length, 0);
    const mini = fs2.machines.find((m) => m.machineId === "mini")!;
    assert.equal(mini.lastRun?.status, "fail");
    assert.equal(mini.lastRun?.exitCode, 1);
  } finally {
    tmp.cleanup();
  }
});

test("automations scan: activated-but-undeclared drift on an invalid manifest", () => {
  const tmp = buildAutomationsWorkspace();
  try {
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    const rogue = r.automations.find((a) => a.name === "rogue")!;
    assert.equal(rogue.valid, false);
    assert.ok(rogue.problems.length >= 1, "invalid manifest carries problems");
    // declaredMachines empty (manifest invalid), but mini's registry activates it
    assert.deepEqual(rogue.declaredMachines, []);
    assert.deepEqual(rogue.activatedOn, ["mini"]);
    const mini = rogue.machines.find((m) => m.machineId === "mini")!;
    assert.equal(mini.activated, true);
    assert.equal(mini.declared, false);
    assert.equal(rogue.drift.length, 1);
    assert.equal(rogue.drift[0]!.kind, "activated-undeclared");
    assert.equal(rogue.drift[0]!.machineId, "mini");
  } finally {
    tmp.cleanup();
  }
});

test("automations scan: flattened drift carries automation + project context", () => {
  const tmp = buildAutomationsWorkspace();
  try {
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    // two drift items total: laptop declared-not-activated, mini activated-undeclared
    assert.equal(r.drift.length, 2);
    const kinds = r.drift.map((d) => d.kind).sort();
    assert.deepEqual(kinds, ["activated-undeclared", "declared-not-activated"]);
    for (const d of r.drift) {
      assert.ok(typeof d.automation === "string" && d.automation.length > 0);
      assert.ok(typeof d.project === "string" && d.project.length > 0);
    }
  } finally {
    tmp.cleanup();
  }
});

test("automations scan: empty workspace — no machines, no automations, no drift", () => {
  const tmp = makeTmpWorkspace();
  try {
    tmp.addProject("Bare", "uid-bare");
    const r = scanAutomations(openWorkspace(tmp.root), NOW);
    assert.deepEqual(r.machines, []);
    assert.deepEqual(r.automations, []);
    assert.deepEqual(r.drift, []);
  } finally {
    tmp.cleanup();
  }
});

test("http: GET /api/automations returns the expected shape as JSON", async (t) => {
  const tmp = buildAutomationsWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
  t.after(() => running.close());

  const res = await get(running.port, "/api/automations");
  assert.equal(res.status, 200);
  assert.match(String(res.headers["content-type"]), /application\/json/);
  const r = JSON.parse(res.body) as AutomationsScanResult;
  assert.equal(r.workspace.workspaceId, "ws-auto-test");
  assert.equal(r.automations.length, 3);
  assert.equal(r.machines.length, 2);
  assert.equal(r.drift.length, 2);
  const br = r.automations.find((a) => a.name === "brief-refresh")!;
  assert.deepEqual(br.activatedOn, ["mini"]);
});

test("http: /api/automations is live — a new registry activation appears next request", async (t) => {
  const tmp = buildAutomationsWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
  t.after(() => running.close());

  const before = JSON.parse((await get(running.port, "/api/automations")).body) as AutomationsScanResult;
  assert.deepEqual(before.automations.find((a) => a.name === "brief-refresh")!.activatedOn, ["mini"]);

  // laptop activates brief-refresh ⇒ drift resolves, activatedOn grows.
  writeRegistry(
    tmp.root,
    "laptop",
    [
      'machine_id = "laptop"',
      'heartbeat = "2026-06-10T14:55:00Z"',
      "",
      "[[activations]]",
      'project_uid = "uid-alpha"',
      'name = "brief-refresh"',
      'label = "com.openworkspace.uid-alpha.brief-refresh"',
      'applied_at = "2026-06-10T00:00:00Z"',
      'schedule = "cron 0 7 * * *"',
      "",
    ].join("\n") + "\n",
  );
  const after = JSON.parse((await get(running.port, "/api/automations")).body) as AutomationsScanResult;
  assert.deepEqual(after.automations.find((a) => a.name === "brief-refresh")!.activatedOn, ["laptop", "mini"]);
  assert.equal(after.automations.find((a) => a.name === "brief-refresh")!.drift.length, 0);
});

test("http: /api/automations honors the Host-header defense + GET/HEAD-only", async (t) => {
  const tmp = buildAutomationsWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
  t.after(() => running.close());

  // bad Host rejected
  assert.equal((await get(running.port, "/api/automations", { host: "evil.example.com" })).status, 403);
  // good Host accepted
  assert.equal((await get(running.port, "/api/automations", { host: "127.0.0.1" })).status, 200);
  // mutation methods rejected, Allow header set
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await get(running.port, "/api/automations", { method });
    assert.equal(res.status, 405, `${method} /api/automations must be 405`);
    assert.equal(res.headers["allow"], "GET, HEAD");
  }
});

test("http: /api/automations writes nothing into the workspace", async (t) => {
  const tmp = buildAutomationsWorkspace();
  t.after(() => tmp.cleanup());
  const running = await startDashboard({ workspaceRoot: tmp.root, now: () => NOW });
  t.after(() => running.close());

  const snapshot = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        out.push(full);
        if (e.isDirectory()) walk(full);
      }
    };
    walk(tmp.root);
    return out.sort();
  };
  const before = snapshot();
  await get(running.port, "/api/automations");
  assert.deepEqual(snapshot(), before);
});

test("automations cache: TTL stale-while-revalidate parity with /api/scan", async (t) => {
  const tmp = buildAutomationsWorkspace();
  t.after(() => tmp.cleanup());
  const clock = mutableClock(NOW);
  const running = await startDashboard({ workspaceRoot: tmp.root, now: clock.now, cacheTtlMs: TTL });
  t.after(() => running.close());

  const driftN = (s: AutomationsScanResult) => s.drift.length;
  const first = JSON.parse((await get(running.port, "/api/automations")).body) as AutomationsScanResult;
  assert.equal(driftN(first), 2);
  assert.equal(first.generatedAt, NOW.toISOString());

  // Resolve the laptop drift on disk, then request within the TTL: still cached.
  writeRegistry(
    tmp.root,
    "laptop",
    [
      'machine_id = "laptop"',
      'heartbeat = "2026-06-10T14:55:00Z"',
      "",
      "[[activations]]",
      'project_uid = "uid-alpha"',
      'name = "brief-refresh"',
      'schedule = "cron 0 7 * * *"',
      "",
    ].join("\n") + "\n",
  );
  clock.advance(TTL - 1);
  const cached = JSON.parse((await get(running.port, "/api/automations")).body) as AutomationsScanResult;
  assert.equal(driftN(cached), 2, "within TTL ⇒ cached, disk change not yet visible");
  assert.equal(cached.generatedAt, first.generatedAt, "cached automations scan keeps its build time");

  // Cross the TTL ⇒ serves stale, triggers a background rebuild.
  clock.advance(2);
  await get(running.port, "/api/automations");
  await flushBackground();
  const rebuilt = JSON.parse((await get(running.port, "/api/automations")).body) as AutomationsScanResult;
  assert.equal(driftN(rebuilt), 1, "after rebuild the resolved laptop drift is gone (only rogue remains)");
});
