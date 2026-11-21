import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

/**
 * Fixture-only test of the REAL evaluate-only entrypoint.
 *
 * tests/fixtures/reminder-evaluate-harness.mjs imports
 * scripts/reminder-evaluate-cron.ts unmodified, with outbound network blocked,
 * Prisma replaced through lib/prisma.ts's own global seam, the live readers
 * redirected to fixtures, and the clock frozen. It reports what was touched as
 * one __HARNESS_JSON__ line.
 *
 * Nothing here reads production, opens a socket, applies a migration or sends.
 * No credential is passed to the child: the environment is built from scratch.
 */

const HARNESS = "tests/fixtures/reminder-evaluate-harness.mjs";
/** 2026-11-16 in Phoenix. 16:05Z = 09:05, inside the window. */
const IN_WINDOW = "2026-11-16T16:05:00Z";
/** 20:00Z = 13:00 Phoenix, after 09:15. */
const AFTER_WINDOW = "2026-11-16T20:00:00Z";
/** 21:30Z = 14:30 Phoenix, used with --ignore-window. */
const LATE = "2026-11-16T21:30:00Z";
const TWO_EXCLUSIONS = "cl-excl-1,cl-excl-2";

type Harness = {
  fetch: string[]; sockets: string[]; dns: string[]; modules: string[];
  prismaCalls: string[]; forbidden: string[]; readers: string[];
  stubbedReaders: boolean;
  candidateQuery: null | { whereKeys: string[]; statuses: string[] | null; amountDueGt: number | null; hasIssuedAtFloor: boolean };
  runs: Array<{
    topLevelKeys: string[]; nestedWriteKeys: string[]; mode: string; state: string;
    phoenixDate: string; candidates: number; eligible: number; held: number;
    exclusionsVerified: boolean; sendsAttempted: number; notes: string | null;
    rows: Array<{ invoiceNumber: string | null; decision: string; category: string | null;
      categorySource: string | null; milestoneDay: number | null; audience: string | null;
      daysPastDue: number | null; holds: string }>;
  }>;
};

function run(opts: { now: string; env?: Record<string, string>; args?: string[] }) {
  // Built from scratch: no DATABASE_URL, no GHL_API_KEY, no Jobber secret.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
    NODE_ENV: "test", HARNESS_NOW: opts.now, ...(opts.env ?? {}),
  };
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync(process.execPath, ["--import", "tsx", HARNESS, ...(opts.args ?? [])],
      { cwd: process.cwd(), env, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
  } catch (err: any) {
    status = err?.status ?? 1;
    stdout = String(err?.stdout ?? "") + String(err?.stderr ?? "");
  }
  const marker = stdout.indexOf("__HARNESS_JSON__");
  assert.notEqual(marker, -1, `harness produced no report:\n${stdout}`);
  const line = stdout.slice(marker + "__HARNESS_JSON__".length).split("\n")[0];
  return { status, stdout, harness: JSON.parse(line) as Harness };
}

/** Every case must satisfy these, whatever else it asserts. */
function assertSealed(h: Harness, where: string) {
  assert.deepEqual(h.fetch, [], `${where}: outbound fetch attempted`);
  assert.deepEqual(h.sockets, [], `${where}: socket opened`);
  assert.deepEqual(h.dns, [], `${where}: DNS lookup attempted`);
  assert.deepEqual(h.forbidden, [], `${where}: forbidden model or module reached`);
  assert.equal(h.stubbedReaders, true, `${where}: the live readers module was NOT stubbed`);
  const allowed = new Set(["invoiceRecord.findMany", "reminderEvaluationRun.create", "$disconnect", "$connect"]);
  for (const call of h.prismaCalls) {
    assert.ok(allowed.has(call), `${where}: unexpected Prisma access ${call}`);
  }
  for (const banned of ["notification-sender", "notification-dispatch", "notification-ghl-transport",
    "lib/ghl.ts", "lib/jobber.ts", "lib/sync.ts", "reminder-day21-pilot"]) {
    assert.ok(!h.modules.some(m => m.includes(banned)),
      `${where}: ${banned} entered the module graph`);
  }
}

// ---------------------------------------------------------------------------

test("disabled mode reads nothing, records nothing and reaches nothing", () => {
  const { status, stdout, harness } = run({ now: IN_WINDOW });
  assert.equal(status, 0);
  assert.match(stdout, /disabled \(FLEXX_REMINDER_EVALUATE_MODE=unset\); nothing read, nothing recorded/);
  assertSealed(harness, "disabled");
  // The only Prisma touch is the teardown disconnect.
  assert.deepEqual(harness.prismaCalls, ["$disconnect"]);
  assert.equal(harness.candidateQuery, null, "the candidate cache was queried while disabled");
  assert.deepEqual(harness.readers, [], "a source read happened while disabled");
  assert.deepEqual(harness.runs, [], "a run was recorded while disabled");
});

test("a mode other than exactly \"evaluate\" is also disabled", () => {
  for (const mode of ["Evaluate", "evaluate ", "send", "true"]) {
    const { status, harness } = run({ now: IN_WINDOW, env: { FLEXX_REMINDER_EVALUATE_MODE: mode } });
    assert.equal(status, 0, `mode=${mode}`);
    assertSealed(harness, `mode=${mode}`);
    assert.deepEqual(harness.runs, [], `mode=${mode} recorded a run`);
    assert.deepEqual(harness.readers, [], `mode=${mode} performed a source read`);
  }
});

test("outside the window the skip is recorded and no source is read", () => {
  const { status, stdout, harness } = run({
    now: AFTER_WINDOW,
    env: { FLEXX_REMINDER_EVALUATE_MODE: "evaluate", FLEXX_REMINDER_VERIFIED_EXCLUSIONS: TWO_EXCLUSIONS },
  });
  assert.equal(status, 0);
  assertSealed(harness, "outside_window");
  assert.match(stdout, /inWindow=false ignoreWindow=false/);
  assert.match(stdout, /note: outside_arizona_window_no_catch_up/);

  // No source read of any kind: not one reader method was invoked.
  assert.deepEqual(harness.readers, [], "a source read happened outside the window");

  // The skip IS recorded, so an absent record means the runner never executed.
  assert.equal(harness.runs.length, 1);
  const [recorded] = harness.runs;
  assert.equal(recorded.state, "outside_window");
  assert.equal(recorded.candidates, 0);
  assert.equal(recorded.rows.length, 0);
  assert.equal(recorded.sendsAttempted, 0);
  assert.equal(recorded.notes, "outside_arizona_window_no_catch_up");
});

test("in the window candidates are evaluated and nothing is sent", () => {
  const { status, stdout, harness } = run({
    now: IN_WINDOW,
    env: { FLEXX_REMINDER_EVALUATE_MODE: "evaluate", FLEXX_REMINDER_VERIFIED_EXCLUSIONS: TWO_EXCLUSIONS },
  });
  assert.equal(status, 0);
  assertSealed(harness, "in_window");
  assert.match(stdout, /inWindow=true/);
  assert.match(stdout, /sends attempted: 0 \(this runner has no send path\)/);

  // The candidate query is the collections scope, not every invoice ever.
  assert.deepEqual(harness.candidateQuery?.whereKeys, ["amountDue", "invoiceStatus", "issuedAt"]);
  assert.deepEqual(harness.candidateQuery?.statuses, ["awaiting_payment", "past_due"]);
  assert.equal(harness.candidateQuery?.amountDueGt, 0);
  assert.equal(harness.candidateQuery?.hasIssuedAtFloor, true);

  // Exactly one recorded run, writing only its own two tables.
  assert.equal(harness.runs.length, 1);
  const [recorded] = harness.runs;
  assert.equal(recorded.mode, "evaluate");
  assert.equal(recorded.state, "completed");
  assert.equal(recorded.phoenixDate, "2026-11-16");
  assert.equal(recorded.exclusionsVerified, true);
  assert.equal(recorded.sendsAttempted, 0, "sendsAttempted must be 0 on every path");
  assert.deepEqual(recorded.nestedWriteKeys, ["rows"],
    "the only nested write may be ReminderEvaluationRow");
  assert.deepEqual(
    harness.prismaCalls.filter(c => c !== "$disconnect").sort(),
    ["invoiceRecord.findMany", "reminderEvaluationRun.create"],
    "only the candidate read and the run write may touch the database");

  // Four fixtures, four distinct decisions.
  const by = new Map(recorded.rows.map(r => [r.invoiceNumber, r]));
  assert.equal(recorded.rows.length, 4);
  assert.equal(recorded.candidates, 4);

  // 9001: due 2026-10-26, so day 21 falls today. Irrigation agreed by both
  // sources, one exact contact, one open overdue card, clean history, two
  // verified exclusions -> genuinely eligible, and STILL sends nothing.
  const eligible = by.get("9001")!;
  assert.equal(eligible.decision, "eligible");
  assert.equal(eligible.category, "irrigation");
  assert.equal(eligible.categorySource, "agreed");
  assert.equal(eligible.milestoneDay, 21);
  assert.equal(eligible.audience, "internal");
  assert.equal(eligible.daysPastDue, 21);
  assert.equal(eligible.holds, "");
  assert.equal(recorded.eligible, 1);
  assert.match(stdout, /#9001 eligible .*channels=\[email:eligible,sms:eligible\]/);

  // 9003: two exact contacts. Held, never merged, never chosen between.
  const held = by.get("9003")!;
  assert.equal(held.decision, "held");
  assert.match(held.holds, /ambiguous_destination_contacts: 2 exact matches, not merged/);
  assert.equal(held.milestoneDay, null, "no ladder may be chosen without a confirmed category");

  // 9004: settled in source. Reported separately from "not eligible".
  const settled = by.get("9004")!;
  assert.equal(settled.decision, "no_longer_owes");
  assert.match(settled.holds, /settled_in_source: status=paid balance=0/);

  // Every reader call was answered from fixtures, and the readers were reached.
  assert.ok(harness.readers.includes("readInvoice:inv-eligible"));
  assert.ok(harness.readers.includes("sendHistory:inv-eligible"));
});

test("an old milestone stays held and is never replayed, even with --ignore-window", () => {
  const { status, stdout, harness } = run({
    now: LATE, args: ["--ignore-window"],
    env: { FLEXX_REMINDER_EVALUATE_MODE: "evaluate", FLEXX_REMINDER_VERIFIED_EXCLUSIONS: TWO_EXCLUSIONS },
  });
  assert.equal(status, 0);
  assertSealed(harness, "ignore_window");
  assert.match(stdout, /inWindow=false ignoreWindow=true/);

  const [recorded] = harness.runs;
  const by = new Map(recorded.rows.map(r => [r.invoiceNumber, r]));

  // Nothing at all is eligible once 09:15 Phoenix has passed, flag or no flag.
  assert.equal(recorded.eligible, 0, "--ignore-window must never produce an eligible row");
  assert.equal(recorded.sendsAttempted, 0);

  // 9001 was eligible at 09:05 on this same Phoenix date. At 14:30 it is
  // skipped outright rather than carried forward.
  const passed = by.get("9001")!;
  assert.equal(passed.decision, "window_passed");
  assert.match(passed.holds, /window_passed_today: day 21 was scheduled for 2026-11-16 09:00 Phoenix and did not send; skipped, never replayed/);

  // 9002's whole irrigation ladder (10, 15, 21) is in the past. It is handed to
  // a person, never re-sent, and --ignore-window does not change that.
  const old = by.get("9002")!;
  assert.equal(old.decision, "not_due");
  assert.match(old.holds, /past_milestones_for_human_reconciliation: 10,15,21 \(never replayed\)/);
  assert.equal(old.daysPastDue, 76);
  assert.ok(!/eligible/.test(old.decision));
});

// --- the guards above are not vacuous: each one trips on demand ------------

test("the harness fails the run on unexpected database, network or sender access", () => {
  const cases: Array<[string, RegExp]> = [
    ["prisma", /HARNESS_FORBIDDEN_PRISMA:syncRun/],
    ["fetch", /HARNESS_BLOCKED_FETCH/],
    ["module", /HARNESS_FORBIDDEN_MODULE:\/lib\/ghl\.ts/],
  ];
  for (const [which, expected] of cases) {
    const { status, stdout } = run({ now: IN_WINDOW, env: { HARNESS_SELFTEST: which } });
    assert.notEqual(status, 0, `${which}: guard did not fail the run`);
    assert.match(stdout, expected, `${which}: wrong failure`);
    assert.ok(!/HARNESS_SELFTEST_DID_NOT_TRIP/.test(stdout), `${which}: guard never fired`);
  }
});
