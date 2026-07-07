import * as assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMissPolicy,
  applyOverlapPolicy,
  computeDueOccurrences,
} from "../src/primitives/automation-scheduler.js";

function localDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

function localKey(year: number, month: number, day: number, hour: number, minute: number): string {
  return localDate(year, month, day, hour, minute).toISOString();
}

function keys(items: Array<{ key: string }>): string[] {
  return items.map((item) => item.key);
}

function cursorKey(result: { nextCursor: { scheduledAt: Date | null } }): string | null {
  return result.nextCursor.scheduledAt?.toISOString() ?? null;
}

function codes(items: Array<{ code: string }>): string[] {
  return items.map((item) => item.code);
}

test("computeDueOccurrences: cron DOM and DOW restrictions use union semantics", () => {
  const scan = computeDueOccurrences({
    cron: "0 9 1 * 1",
    cursorScheduledAt: localDate(2026, 5, 31, 9, 0),
    now: localDate(2026, 6, 2, 10, 0),
  });

  assert.deepEqual(keys(scan.occurrences), [
    localKey(2026, 6, 1, 9, 0),
  ]);
});

test("skip within grace starts only the latest due occurrence", () => {
  const result = applyMissPolicy({
    cron: "0 * * * *",
    cursorScheduledAt: localDate(2026, 6, 25, 9, 0),
    now: localDate(2026, 6, 25, 10, 4, 59),
    missPolicy: "skip",
    misfireGraceSeconds: 300,
  });

  assert.deepEqual(keys(result.runsToStart), [localKey(2026, 6, 25, 10, 0)]);
  assert.deepEqual(result.skipped, []);
  assert.equal(cursorKey(result), localKey(2026, 6, 25, 10, 0));
  assert.equal(result.rejected, false);
});

test("skip outside grace records the miss and advances the cursor", () => {
  const result = applyMissPolicy({
    cron: "0 * * * *",
    cursorScheduledAt: localDate(2026, 6, 25, 9, 0),
    now: localDate(2026, 6, 25, 10, 6),
    missPolicy: "skip",
    misfireGraceSeconds: 300,
  });

  assert.deepEqual(result.runsToStart, []);
  assert.deepEqual(keys(result.skipped), [localKey(2026, 6, 25, 10, 0)]);
  assert.equal(result.skipped[0]?.reason, "missed-outside-grace");
  assert.equal(cursorKey(result), localKey(2026, 6, 25, 10, 0));
});

test("catch-up starts oldest first, caps by maxCatchUp, and records overflow", () => {
  const result = applyMissPolicy({
    cron: "0 * * * *",
    cursorScheduledAt: localDate(2026, 6, 25, 8, 0),
    now: localDate(2026, 6, 25, 12, 0),
    missPolicy: "catch-up",
    maxCatchUp: 2,
  });

  assert.deepEqual(keys(result.runsToStart), [
    localKey(2026, 6, 25, 9, 0),
    localKey(2026, 6, 25, 10, 0),
  ]);
  assert.deepEqual(keys(result.skipped), [
    localKey(2026, 6, 25, 11, 0),
    localKey(2026, 6, 25, 12, 0),
  ]);
  assert.deepEqual(result.skipped.map((item) => item.reason), ["skipped-over-cap", "skipped-over-cap"]);
  assert.equal(cursorKey(result), localKey(2026, 6, 25, 12, 0));
});

test("reserved miss policies return unsupported rejected decisions", () => {
  for (const missPolicy of ["fail-loud", "coalesce"] as const) {
    const result = applyMissPolicy({
      cron: "0 * * * *",
      cursorScheduledAt: localDate(2026, 6, 25, 9, 0),
      now: localDate(2026, 6, 25, 10, 0),
      missPolicy,
    });

    assert.equal(result.unsupported, true);
    assert.equal(result.rejected, true);
    assert.deepEqual(result.runsToStart, []);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(codes(result.errors), ["unsupported-miss-policy"]);
    assert.equal(cursorKey(result), localKey(2026, 6, 25, 9, 0));
  }
});

test("missing cursor seeds from the latest due occurrence instead of creating a backlog", () => {
  const result = applyMissPolicy({
    cron: "0 * * * *",
    cursorScheduledAt: null,
    now: localDate(2026, 6, 25, 10, 3),
    missPolicy: "skip",
    misfireGraceSeconds: 300,
  });

  assert.deepEqual(keys(result.runsToStart), [localKey(2026, 6, 25, 10, 0)]);
  assert.deepEqual(result.skipped, []);
  assert.equal(cursorKey(result), localKey(2026, 6, 25, 10, 0));
  assert.ok(codes(result.warnings).includes("cursor-seeded"));
});

test("catch-up scan is bounded and cannot generate an unbounded backlog", () => {
  const result = applyMissPolicy({
    cron: "* * * * *",
    cursorScheduledAt: localDate(2026, 1, 1, 0, 0),
    now: localDate(2026, 1, 2, 0, 0),
    missPolicy: "catch-up",
    maxCatchUp: 2,
    maxScanMinutes: 5,
  });

  assert.deepEqual(keys(result.runsToStart), [
    localKey(2026, 1, 1, 23, 56),
    localKey(2026, 1, 1, 23, 57),
  ]);
  assert.deepEqual(keys(result.skipped), [
    localKey(2026, 1, 1, 23, 58),
    localKey(2026, 1, 1, 23, 59),
    localKey(2026, 1, 2, 0, 0),
  ]);
  assert.deepEqual(result.skipped.map((item) => item.reason), [
    "skipped-over-cap",
    "skipped-over-cap",
    "skipped-over-cap",
  ]);
  assert.ok(codes(result.warnings).includes("lookback-capped"));
  assert.equal(cursorKey(result), localKey(2026, 1, 2, 0, 0));
});

test("overlap policy defaults to skip for an active run and reserves queue/coalesce/fail-loud", () => {
  const skipped = applyOverlapPolicy({ activeRunPresent: true });
  assert.equal(skipped.shouldStart, false);
  assert.equal(skipped.action, "skip");
  assert.equal(skipped.rejected, false);

  for (const overlapPolicy of ["queue", "coalesce", "fail-loud"] as const) {
    const result = applyOverlapPolicy({ activeRunPresent: true, overlapPolicy });
    assert.equal(result.shouldStart, false);
    assert.equal(result.action, "unsupported");
    assert.equal(result.unsupported, true);
    assert.equal(result.rejected, true);
    assert.deepEqual(codes(result.errors), ["unsupported-overlap-policy"]);
  }
});
