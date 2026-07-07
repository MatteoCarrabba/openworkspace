export type MissPolicy = "skip" | "catch-up" | "fail-loud" | "coalesce";
export type OverlapPolicy = "skip" | "queue" | "coalesce" | "fail-loud" | "allow";

export interface ScheduleCursor {
  scheduledAt: Date | null;
}

export interface DueOccurrence {
  scheduledAt: Date;
  key: string;
  lateBySeconds: number;
}

export type SkippedOccurrenceReason =
  | "miss-policy-skip"
  | "missed-outside-grace"
  | "skipped-over-cap";

export interface SkippedOccurrence extends DueOccurrence {
  reason: SkippedOccurrenceReason;
}

export interface ScheduleMessage {
  code: string;
  message: string;
}

export interface DueOccurrenceScan {
  occurrences: DueOccurrence[];
  cursor: ScheduleCursor;
  scanStart: Date | null;
  scanEnd: Date;
  capped: boolean;
  seeded: boolean;
  warnings: ScheduleMessage[];
}

export interface ScheduleDecision {
  missPolicy: MissPolicy;
  runsToStart: DueOccurrence[];
  skipped: SkippedOccurrence[];
  nextCursor: ScheduleCursor;
  warnings: ScheduleMessage[];
  errors: ScheduleMessage[];
  unsupported: boolean;
  rejected: boolean;
}

export interface ComputeDueOccurrencesInput {
  cron: string;
  cursorScheduledAt?: Date | string | null;
  now: Date | string;
  maxLookbackSeconds?: number;
  maxScanMinutes?: number;
  /**
   * With no durable cursor, start from the latest due occurrence instead of
   * inventing a backlog. This keeps first activation bounded and explicit.
   */
  seedFromLatest?: boolean;
}

export interface ApplyMissPolicyInput extends ComputeDueOccurrencesInput {
  missPolicy?: MissPolicy;
  misfireGraceSeconds?: number;
  maxCatchUp?: number;
}

export interface OverlapDecision {
  overlapPolicy: OverlapPolicy;
  shouldStart: boolean;
  action: "start" | "skip" | "unsupported" | "allow";
  warnings: ScheduleMessage[];
  errors: ScheduleMessage[];
  unsupported: boolean;
  rejected: boolean;
}

export interface ApplyOverlapPolicyInput {
  activeRunPresent: boolean;
  overlapPolicy?: OverlapPolicy;
  activeRunCount?: number;
  maxConcurrency?: number;
}

export interface CronFields {
  minute: number[] | null;
  hour: number[] | null;
  dom: number[] | null;
  month: number[] | null;
  dow: number[] | null;
}

const MINUTE_MS = 60_000;
const DEFAULT_MISFIRE_GRACE_SECONDS = 300;
const DEFAULT_MAX_CATCH_UP = 1;
const DEFAULT_MAX_SCAN_MINUTES = 45 * 24 * 60;
const HARD_MAX_SCAN_MINUTES = 366 * 24 * 60;

function message(code: string, messageText: string): ScheduleMessage {
  return { code, message: messageText };
}

function toDate(value: Date | string, fieldName: string): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${fieldName} must be a valid Date or date string`);
  }
  return date;
}

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function occurrenceKey(scheduledAt: Date): string {
  return floorToMinute(scheduledAt).toISOString();
}

function occurrence(scheduledAt: Date, now: Date): DueOccurrence {
  const onMinute = floorToMinute(scheduledAt);
  return {
    scheduledAt: onMinute,
    key: occurrenceKey(onMinute),
    lateBySeconds: Math.max(0, Math.floor((now.getTime() - onMinute.getTime()) / 1000)),
  };
}

function parseCronField(
  spec: string,
  fieldName: string,
  min: number,
  max: number,
  normalize?: (n: number) => number,
): number[] | null {
  if (spec === "*") return null;

  const values: number[] = [];
  for (const token of spec.split(",")) {
    if (!/^\d+$/.test(token)) {
      throw new Error(
        `cron ${fieldName} field: unsupported token "${token}" - only numbers, comma-lists, and * are supported`,
      );
    }
    const n = Number(token);
    if (n < min || n > max) {
      throw new Error(`cron ${fieldName} field: ${n} out of range ${min}-${max}`);
    }
    const normalized = normalize !== undefined ? normalize(n) : n;
    if (!values.includes(normalized)) values.push(normalized);
  }
  values.sort((a, b) => a - b);
  return values;
}

export function parseScheduleCron(expr: string): CronFields {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }

  const minute = fields[0];
  const hour = fields[1];
  const dom = fields[2];
  const month = fields[3];
  const dow = fields[4];
  if (minute === undefined || hour === undefined || dom === undefined || month === undefined || dow === undefined) {
    throw new Error(
      `cron expression "${expr}" must have exactly 5 fields (minute hour day-of-month month day-of-week)`,
    );
  }

  return {
    minute: parseCronField(minute, "minute", 0, 59),
    hour: parseCronField(hour, "hour", 0, 23),
    dom: parseCronField(dom, "day-of-month", 1, 31),
    month: parseCronField(month, "month", 1, 12),
    dow: parseCronField(dow, "day-of-week", 0, 7, (n) => (n === 7 ? 0 : n)),
  };
}

function fieldMatches(values: number[] | null, actual: number): boolean {
  return values === null || values.includes(actual);
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fieldMatches(fields.minute, date.getMinutes())) return false;
  if (!fieldMatches(fields.hour, date.getHours())) return false;
  if (!fieldMatches(fields.month, date.getMonth() + 1)) return false;

  const domMatches = fieldMatches(fields.dom, date.getDate());
  const dowMatches = fieldMatches(fields.dow, date.getDay());
  if (fields.dom !== null && fields.dow !== null) return domMatches || dowMatches;
  return domMatches && dowMatches;
}

function normalizePositiveInteger(value: number | undefined, defaultValue: number, fieldName: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value: number | undefined, defaultValue: number, fieldName: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function scanLimitMinutes(input: ComputeDueOccurrencesInput, warnings: ScheduleMessage[]): number {
  const byLookback =
    input.maxLookbackSeconds === undefined
      ? DEFAULT_MAX_SCAN_MINUTES
      : normalizePositiveInteger(Math.ceil(input.maxLookbackSeconds / 60), DEFAULT_MAX_SCAN_MINUTES, "maxLookbackSeconds");
  const byScan = normalizePositiveInteger(input.maxScanMinutes, DEFAULT_MAX_SCAN_MINUTES, "maxScanMinutes");
  const requested = Math.min(byLookback, byScan);
  if (requested > HARD_MAX_SCAN_MINUTES) {
    warnings.push(
      message(
        "scan-window-clamped",
        `scan window clamped from ${requested} minutes to ${HARD_MAX_SCAN_MINUTES} minutes`,
      ),
    );
    return HARD_MAX_SCAN_MINUTES;
  }
  return requested;
}

export function computeDueOccurrences(input: ComputeDueOccurrencesInput): DueOccurrenceScan {
  const fields = parseScheduleCron(input.cron);
  const now = toDate(input.now, "now");
  const scanEnd = floorToMinute(now);
  const cursorDate = input.cursorScheduledAt === undefined || input.cursorScheduledAt === null
    ? null
    : floorToMinute(toDate(input.cursorScheduledAt, "cursorScheduledAt"));
  const warnings: ScheduleMessage[] = [];
  const maxMinutes = scanLimitMinutes(input, warnings);
  const seedFromLatest = input.seedFromLatest ?? true;

  if (cursorDate !== null && cursorDate.getTime() > scanEnd.getTime()) {
    warnings.push(message("cursor-in-future", "schedule cursor is later than now; no due occurrences were computed"));
    return {
      occurrences: [],
      cursor: { scheduledAt: cursorDate },
      scanStart: null,
      scanEnd,
      capped: false,
      seeded: false,
      warnings,
    };
  }

  if (cursorDate === null && seedFromLatest) {
    let scanStart = scanEnd;
    for (let scanned = 0, t = scanEnd.getTime(); scanned < maxMinutes; scanned += 1, t -= MINUTE_MS) {
      const candidate = new Date(t);
      scanStart = candidate;
      if (cronMatches(fields, candidate)) {
        warnings.push(message("cursor-seeded", "missing schedule cursor; seeded from the latest due occurrence"));
        return {
          occurrences: [occurrence(candidate, now)],
          cursor: { scheduledAt: null },
          scanStart,
          scanEnd,
          capped: false,
          seeded: true,
          warnings,
        };
      }
    }
    warnings.push(
      message("cursor-seed-empty", "missing schedule cursor and no due occurrence was found inside the scan window"),
    );
    return {
      occurrences: [],
      cursor: { scheduledAt: null },
      scanStart,
      scanEnd,
      capped: true,
      seeded: true,
      warnings,
    };
  }

  const requestedStart = cursorDate === null
    ? addMinutes(scanEnd, -(maxMinutes - 1))
    : addMinutes(cursorDate, 1);
  const earliestStart = addMinutes(scanEnd, -(maxMinutes - 1));
  const capped = requestedStart.getTime() < earliestStart.getTime();
  const scanStart = capped ? earliestStart : requestedStart;
  if (capped) {
    warnings.push(
      message(
        "lookback-capped",
        `due occurrence scan was capped at ${maxMinutes} minute(s); older occurrences were not enumerated`,
      ),
    );
  }

  const occurrences: DueOccurrence[] = [];
  for (let t = scanStart.getTime(); t <= scanEnd.getTime(); t += MINUTE_MS) {
    const candidate = new Date(t);
    if (cronMatches(fields, candidate)) {
      occurrences.push(occurrence(candidate, now));
    }
  }

  return {
    occurrences,
    cursor: { scheduledAt: cursorDate },
    scanStart,
    scanEnd,
    capped,
    seeded: false,
    warnings,
  };
}

function emptyDecision(missPolicy: MissPolicy, cursorScheduledAt: Date | null): ScheduleDecision {
  return {
    missPolicy,
    runsToStart: [],
    skipped: [],
    nextCursor: { scheduledAt: cursorScheduledAt },
    warnings: [],
    errors: [],
    unsupported: false,
    rejected: false,
  };
}

function skippedOccurrence(occ: DueOccurrence, reason: SkippedOccurrenceReason): SkippedOccurrence {
  return { ...occ, scheduledAt: new Date(occ.scheduledAt.getTime()), reason };
}

function latestOccurrence(occurrences: DueOccurrence[]): DueOccurrence | null {
  return occurrences.length === 0 ? null : occurrences[occurrences.length - 1] ?? null;
}

export function applyMissPolicy(input: ApplyMissPolicyInput): ScheduleDecision {
  const missPolicy = input.missPolicy ?? "skip";
  const cursorScheduledAt = input.cursorScheduledAt === undefined || input.cursorScheduledAt === null
    ? null
    : floorToMinute(toDate(input.cursorScheduledAt, "cursorScheduledAt"));
  const decision = emptyDecision(missPolicy, cursorScheduledAt);

  if (missPolicy === "fail-loud" || missPolicy === "coalesce") {
    decision.unsupported = true;
    decision.rejected = true;
    decision.errors.push(
      message(
        "unsupported-miss-policy",
        `miss_policy "${missPolicy}" is reserved for Automation Runtime v2 but is not implemented yet`,
      ),
    );
    return decision;
  }

  const misfireGraceSeconds = normalizeNonNegativeInteger(
    input.misfireGraceSeconds,
    DEFAULT_MISFIRE_GRACE_SECONDS,
    "misfireGraceSeconds",
  );
  const scan = computeDueOccurrences(input);
  decision.warnings.push(...scan.warnings);

  if (scan.occurrences.length === 0) {
    return decision;
  }

  const latest = latestOccurrence(scan.occurrences);
  if (latest === null) return decision;
  decision.nextCursor = { scheduledAt: new Date(latest.scheduledAt.getTime()) };

  if (missPolicy === "skip") {
    const older = scan.occurrences.slice(0, -1);
    decision.skipped.push(...older.map((occ) => skippedOccurrence(occ, "miss-policy-skip")));
    if (latest.lateBySeconds <= misfireGraceSeconds) {
      decision.runsToStart.push(latest);
    } else {
      decision.skipped.push(skippedOccurrence(latest, "missed-outside-grace"));
    }
    return decision;
  }

  const maxCatchUp = normalizeNonNegativeInteger(input.maxCatchUp, DEFAULT_MAX_CATCH_UP, "maxCatchUp");
  decision.runsToStart.push(...scan.occurrences.slice(0, maxCatchUp));
  decision.skipped.push(...scan.occurrences.slice(maxCatchUp).map((occ) => skippedOccurrence(occ, "skipped-over-cap")));
  return decision;
}

export function applyOverlapPolicy(input: ApplyOverlapPolicyInput): OverlapDecision {
  const overlapPolicy = input.overlapPolicy ?? "skip";
  const warnings: ScheduleMessage[] = [];
  const errors: ScheduleMessage[] = [];

  if (!input.activeRunPresent) {
    return {
      overlapPolicy,
      shouldStart: true,
      action: overlapPolicy === "allow" ? "allow" : "start",
      warnings,
      errors,
      unsupported: false,
      rejected: false,
    };
  }

  if (overlapPolicy === "skip") {
    return {
      overlapPolicy,
      shouldStart: false,
      action: "skip",
      warnings,
      errors,
      unsupported: false,
      rejected: false,
    };
  }

  if (overlapPolicy === "queue" || overlapPolicy === "coalesce" || overlapPolicy === "fail-loud") {
    errors.push(
      message(
        "unsupported-overlap-policy",
        `overlap_policy "${overlapPolicy}" is reserved for Automation Runtime v2 but is not implemented yet`,
      ),
    );
    return {
      overlapPolicy,
      shouldStart: false,
      action: "unsupported",
      warnings,
      errors,
      unsupported: true,
      rejected: true,
    };
  }

  const activeRunCount = normalizePositiveInteger(input.activeRunCount, 1, "activeRunCount");
  const maxConcurrency = normalizePositiveInteger(input.maxConcurrency, 1, "maxConcurrency");
  if (maxConcurrency <= 1) {
    errors.push(message("allow-requires-concurrency", 'overlap_policy "allow" requires maxConcurrency greater than 1'));
    return {
      overlapPolicy,
      shouldStart: false,
      action: "unsupported",
      warnings,
      errors,
      unsupported: false,
      rejected: true,
    };
  }
  if (activeRunCount >= maxConcurrency) {
    warnings.push(message("max-concurrency-reached", "active run count is already at maxConcurrency"));
    return {
      overlapPolicy,
      shouldStart: false,
      action: "skip",
      warnings,
      errors,
      unsupported: false,
      rejected: false,
    };
  }

  return {
    overlapPolicy,
    shouldStart: true,
    action: "allow",
    warnings,
    errors,
    unsupported: false,
    rejected: false,
  };
}
