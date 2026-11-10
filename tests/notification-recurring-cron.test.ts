import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRecurringDay10CronHook, recurringDay10SyncIssue, type RecurringDay10CronSummary } from "../lib/notification-recurring-cron";
import { validateRecurringDay10CronInstallation } from "../lib/notification-recurring-cron-config";

function fixture() {
  const reports: RecurringDay10CronSummary[] = [], order: string[] = [];
  const outcome: any = { state: "completed", invoices: [], admissionAttempts: 0, messageAttempts: 0, retryAllowed: false };
  let mode: string | undefined, blocks = 0, loads = 0, runs = 0;
  const service = { run: async () => { runs++; order.push("service"); return outcome; } };
  const deps = { mode: () => mode, load: async (selected: string) => { loads++; order.push(`load:${selected}`); return service; },
    report: (summary: RecurringDay10CronSummary) => { order.push("report"); reports.push(summary); } };
  const context = { entrypoint: "standalone_cron" as const, writer: { block: async () => { order.push("block"); blocks++; } } };
  return { outcome, reports, order, deps, context, service, run: () => createRecurringDay10CronHook(deps)(context),
    setMode: (value: string | undefined) => { mode = value; }, counts: () => ({ blocks, loads, runs }) };
}

test("default/explicit disabled hook is exact no-op with throwing dependency and writer getters", async () => {
  for (const mode of [undefined, "disabled"]) {
    const deps: any = { mode: () => mode };
    for (const key of ["load", "report"]) Object.defineProperty(deps, key, { get() { throw Error(`unexpected ${key}`); } });
    const context: any = { entrypoint: "standalone_cron" };
    Object.defineProperty(context, "writer", { get() { throw Error("unexpected writer"); } });
    assert.equal((await createRecurringDay10CronHook(deps)(context)).state, "disabled");
  }
});
test("HTTP/manual path cannot even read mode, load a policy, block or report", async () => {
  const deps = new Proxy({}, { get() { throw Error("unexpected dependency"); } }) as any;
  assert.equal((await createRecurringDay10CronHook(deps)({ entrypoint: "http" } as any)).state, "disabled");
});
test("enabled valid mode loads once, runs once, reports counts and never retries", async () => {
  for (const mode of ["read-only", "attempt"]) {
    const f = fixture(); f.setMode(mode); f.outcome.admissionAttempts = 1; f.outcome.messageAttempts = 1;
    f.outcome.invoices = [{ holds: [], result: { state: "accepted" } }, { holds: ["not_current_day10"], result: null },
      { holds: ["private-customer-or-reason"], result: null }];
    const result = await f.run();
    assert.deepEqual(f.counts(), { blocks: 0, loads: 1, runs: 1 });
    assert.equal(result.heldInvoices, 1); assert.equal(result.invoices, 3);
    assert.deepEqual(f.order, [`load:${mode}`, "service", "report"]);
    assert.doesNotMatch(JSON.stringify(f.reports), /private-customer/);
  }
});
test("invalid mode is visibly held before loading a service", async () => {
  const f = fixture(); f.setMode("true"); assert.equal((await f.run()).code, "policy_unavailable");
  assert.deepEqual(f.counts(), { blocks: 0, loads: 0, runs: 0 }); assert.equal(f.reports.length, 1);
});
test("missing or invalid private configuration is held without aborting ordinary cache sync", async () => {
  const f = fixture(); f.setMode("attempt");
  f.deps.load = async () => { throw Error("private token customer@example.test"); };
  assert.equal((await f.run()).state, "held"); assert.equal(f.counts().runs, 0); assert.equal(f.counts().blocks, 0);
  assert.doesNotMatch(JSON.stringify(f.reports), /private token|customer@example/);
});
test("known held result is visible and no admission block or retry is manufactured", async () => {
  const f = fixture(); f.setMode("attempt"); f.outcome.state = "held";
  f.outcome.reasons = ["private-provider-error"];
  assert.equal((await f.run()).state, "held"); assert.deepEqual(f.counts(), { loads: 1, runs: 1, blocks: 0 });
  assert.equal(f.reports.length, 1); assert.doesNotMatch(JSON.stringify(f.reports), /provider-error/);
});
for (const kind of ["unknown", "nested-unknown", "reject", "malformed"]) test(`${kind} is visibly retained without globally blocking settled cache sync`, async () => {
  const f = fixture(); f.setMode("attempt");
  if (kind === "unknown") f.outcome.state = "unknown";
  if (kind === "nested-unknown") f.outcome.invoices = [{ holds: [], result: { state: "unknown" } }];
  if (kind === "malformed") f.outcome.messageAttempts = "customer@example.test";
  if (kind === "reject") f.service.run = async () => { f.order.push("service"); throw Error("secret-provider-error customer@example.test"); };
  const result = await f.run();
  assert.equal(result.state, "unknown"); assert.match(recurringDay10SyncIssue(result)!, /state=unknown/);
  assert.equal(f.counts().blocks, 0); assert.equal(f.reports.length, 1); assert.equal(f.reports[0].state, "unknown");
  assert.equal(f.order.at(-1), "report");
  assert.doesNotMatch(JSON.stringify(f.reports), /secret-provider-error|customer@example/);
});
test("in-flight service never releases hook/admission or reports before settlement", async () => {
  const f = fixture(); f.setMode("attempt"); let settle!: (value: any) => void, done = false;
  f.service.run = () => new Promise(resolve => { settle = resolve; });
  const run = f.run().finally(() => { done = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(done, false); assert.equal(f.reports.length, 0); assert.equal(f.counts().blocks, 0);
  settle({ ...f.outcome, state: "unknown" }); assert.equal((await run).state, "unknown");
  assert.equal(done, true); assert.equal(f.counts().blocks, 0);
});
test("ordinary outside-window and no-current-candidate outcomes create no failure issue", async () => {
  const f = fixture(); f.setMode("attempt");
  f.outcome.state = "held"; f.outcome.reasons = ["outside_arizona_window_no_catch_up"];
  const outside = await f.run(); assert.equal(outside.code, "outside_window");
  assert.equal(recurringDay10SyncIssue(outside), null); assert.equal(f.reports.length, 0);
  f.outcome.state = "completed"; f.outcome.invoices = [{ holds: ["not_current_day10"], result: null }];
  const empty = await f.run(); assert.equal(empty.heldInvoices, 0); assert.equal(recurringDay10SyncIssue(empty), null);
  assert.equal(recurringDay10SyncIssue({ ...empty, state: "disabled", code: "disabled" }), null);
});
test("current-window holds retain sanitized SyncRun issue without raw reasons", async () => {
  const f = fixture(); f.setMode("attempt");
  f.outcome.invoices = [{ holds: ["private source customer@example.test"], result: null }];
  const result = await f.run(), issue = recurringDay10SyncIssue(result)!;
  assert.match(issue, /held=1/); assert.doesNotMatch(issue, /private source|customer@example/);
});
test("each new hook invocation obtains a new service, never renews or reuses the old handle", async () => {
  const f = fixture(); f.setMode("read-only"); let created = 0;
  f.deps.load = async () => { created++; let used = false; return { run: async () => {
    assert.equal(used, false); used = true; return f.outcome;
  } }; };
  const hook = createRecurringDay10CronHook(f.deps); await hook(f.context); await hook(f.context); assert.equal(created, 2);
});

function installation() {
  const value: any = { version: 1, deployment: { projectId: "project", environmentId: "environment", serviceId: "cron", accountId: "account", locationId: "location" },
    policy: { accountId: "account", locationId: "location", action: "attempt", privateMarker: "synthetic-only" } };
  const env: Record<string, string | undefined> = { FLEXX_RECURRING_DAY10_MODE: "attempt", FLEXX_RECURRING_DAY10_ACCOUNT_ID: "account",
    RAILWAY_PROJECT_ID: "project", RAILWAY_ENVIRONMENT_ID: "environment", RAILWAY_SERVICE_ID: "cron", RAILWAY_DEPLOYMENT_ID: "deployment", GHL_LOCATION_ID: "location" };
  const encoded = () => { const raw = JSON.stringify(value); env.FLEXX_RECURRING_DAY10_POLICY_SHA256 = createHash("sha256").update(raw).digest("hex"); return raw; };
  return { value, env, encoded };
}
test("private deployment envelope binds reviewed hash, account, location and exact deployment", () => {
  const f = installation(); assert.deepEqual(validateRecurringDay10CronInstallation(f.encoded(), f.env, "attempt"), f.value.policy);
  f.env.FLEXX_RECURRING_DAY10_MODE = "read-only";
  assert.deepEqual(validateRecurringDay10CronInstallation(f.encoded(), f.env, "read-only"), f.value.policy);
});
for (const key of ["FLEXX_RECURRING_DAY10_MODE", "FLEXX_RECURRING_DAY10_POLICY_SHA256", "FLEXX_RECURRING_DAY10_ACCOUNT_ID",
  "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID", "RAILWAY_DEPLOYMENT_ID", "GHL_LOCATION_ID"]) {
  test(`installation rejects missing ${key}`, () => { const f = installation(), raw = f.encoded(); delete f.env[key];
    assert.throws(() => validateRecurringDay10CronInstallation(raw, f.env, "attempt")); });
}
for (const mutate of [
  (v: any) => { v.version = 2; }, (v: any) => { v.approved = true; },
  (v: any) => { v.deployment.serviceId = "web"; }, (v: any) => { v.policy.accountId = "other-account"; },
  (v: any) => { v.policy.locationId = "other-location"; }, (v: any) => { v.policy.action = "read-only"; },
  (v: any) => { v.deployment.extra = "unexpected"; },
]) test("matching hash alone cannot authorize invalid deployment or action scope", () => {
  const f = installation(); mutate(f.value); assert.throws(() => validateRecurringDay10CronInstallation(f.encoded(), f.env, "attempt"));
});
test("missing, modified, oversized or malformed private configuration fails closed", () => {
  const f = installation(), raw = f.encoded();
  assert.throws(() => validateRecurringDay10CronInstallation(undefined as any, f.env, "attempt"));
  assert.throws(() => validateRecurringDay10CronInstallation(raw + " ", f.env, "attempt"));
  assert.throws(() => validateRecurringDay10CronInstallation("x".repeat(32769), f.env, "attempt"));
  f.env.FLEXX_RECURRING_DAY10_POLICY_SHA256 = createHash("sha256").update("{").digest("hex");
  assert.throws(() => validateRecurringDay10CronInstallation("{", f.env, "attempt"));
});
test("real hook imports and disabled invocation do not initialize ambient Prisma or networking", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    delete process.env.FLEXX_RECURRING_DAY10_MODE;
    Object.defineProperty(globalThis, 'prisma', { get() { throw Error('ambient database'); } });
    globalThis.fetch = () => { throw Error('ambient network'); };
    const m = await import('./lib/notification-recurring-cron.ts');
    const result = await (m.default ?? m).runConfiguredRecurringDay10({ entrypoint: 'standalone_cron',
      writer: { block() { throw Error('unexpected barrier'); } } });
    if (result.state !== 'disabled') throw Error('not disabled');
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
});
test("actual sync has one awaited call after first normal token use and before any heavy feed", () => {
  const source = readFileSync("lib/sync.ts", "utf8"), hook = source.indexOf("await runConfiguredRecurringDay10(");
  assert.equal(source.match(/await runConfiguredRecurringDay10\(/g)?.length, 1);
  assert.ok(source.indexOf("await admitSyncRun(") < hook);
  assert.ok(source.indexOf("new SyncRunWriter(run.id)") < hook);
  assert.ok(source.indexOf("await fetchAllClients(since)") < hook);
  assert.ok(source.indexOf("await upsertClients(clientNodes)") < hook);
  assert.ok(source.indexOf("data: { customersFetched: clientNodes.length }") < hook);
  assert.ok(hook < source.indexOf("heavyFeeds = Promise.allSettled(["));
  assert.match(source.slice(hook, hook + 110), /entrypoint: opts.entrypoint \?\? "http"/);
  assert.ok(source.indexOf("recurringDay10Issue = recurringDay10SyncIssue(recurringDay10)") > hook);
  assert.ok(source.indexOf("data: { errorMessage: recurringDay10Issue }") < source.indexOf("heavyFeeds = Promise.allSettled(["));
  assert.match(source, /errorMessage: \[recurringDay10Issue, \.\.\.warnings\]/);
  assert.match(source, /errorMessage: \[recurringDay10Issue, `Visit sync failed:/);
  assert.match(source, /writer.finish\("failed", \[recurringDay10Issue,/);
  const cron = readFileSync("scripts/sync-cron.ts", "utf8");
  assert.match(cron, /await runFullSync\(\{ triggeredBy: "cron", entrypoint: "standalone_cron" \}\)/);
});
test("private deployment variable is bounded, immutable during run and needs no filesystem provisioning", () => {
  const source = readFileSync("lib/notification-recurring-cron-config.ts", "utf8");
  assert.match(source, /Buffer.byteLength\(raw, "utf8"\) > MAX_BYTES/);
  assert.match(source, /Object.freeze\(Object.fromEntries\(ENV_KEYS.map/);
  assert.match(source, /process.env\[key\] !== original\[key\]/);
  assert.match(source, /original.FLEXX_RECURRING_DAY10_POLICY_JSON/);
  assert.doesNotMatch(source, /node:fs|readFile|\/run\/secrets|refreshToken|forceRefresh|\bfetch\(/);
});
