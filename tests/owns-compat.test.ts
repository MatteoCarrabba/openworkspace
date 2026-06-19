/**
 * Backward-compat regression (project-graph feature, locked-design requirement):
 * a project.toml that carries BOTH `lifecycle` and `[[owns]]` must still be
 * read correctly by the pre-existing typed lifecycle reader — old code reads
 * its lifecycle fine and ignores `owns`. This asserts the [[owns]] schema
 * addition is additive and tolerated by every named-key reader.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { readDeclaredLifecycle } from "../src/lib/workspace.js";
import { makeTmpWorkspace } from "./helpers.js";

test("compat: readDeclaredLifecycle tolerates a project.toml that also has [[owns]]", (t) => {
  const tw = makeTmpWorkspace();
  t.after(tw.cleanup);
  const p = tw.addProject("Parent");
  fs.mkdirSync(path.join(p.root, "_project"), { recursive: true });
  fs.writeFileSync(
    path.join(p.root, "_project", "project.toml"),
    [
      `lifecycle = "dormant"`,
      `lifecycle_set = "2026-01-02"`,
      ``,
      `[[owns]]`,
      `ref = "Child"`,
      `kind = "subproject"`,
      ``,
      `[[owns]]`,
      `ref = "https://github.com/x/y.git"`,
      `kind = "remote"`,
      ``,
    ].join("\n"),
  );

  const result = readDeclaredLifecycle(p.root);
  assert.equal(result.lifecycle, "dormant");
  assert.equal(result.setAt, "2026-01-02");
  assert.equal(result.problem, null);
});
