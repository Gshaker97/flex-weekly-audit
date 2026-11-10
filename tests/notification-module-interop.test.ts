import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { notificationModuleFunctions } from "../lib/notification-module-interop";

type Binding = { binding: () => string };
const acquire = (namespace: unknown) => notificationModuleFunctions(namespace as Binding, ["binding"]);

test("lazy binding resolution supports named, default-only, mixed and both export shapes", () => {
  const named = () => "named", fallback = () => "default";
  for (const namespace of [{ binding: named }, { default: { binding: named } },
    { binding: undefined, default: { binding: named } }]) assert.equal(acquire(namespace).binding, named);
  assert.equal(acquire({ binding: named, default: { binding: fallback } }).binding, named);
  const mixed = notificationModuleFunctions({ first: named, second: undefined, default: { second: fallback } }, ["first", "second"]);
  assert.equal(mixed.first, named); assert.equal(mixed.second, fallback); assert.ok(Object.isFrozen(mixed));
});

test("absent, invalid and inherited exports fail closed without accepting a conflicting fallback", () => {
  for (const namespace of [null, undefined, {}, { default: null }, { default: {} },
    { binding: null }, { binding: false }, { binding: 1 }, { binding: "function" },
    { binding: {} }, { default: { binding: {} } }, { default: { default: { binding: () => "nested" } } },
    { binding: false, default: { binding: () => "must not mask invalid named export" } },
    Object.create({ binding: () => "inherited" })])
    assert.throws(() => acquire(namespace), /notification_module_function_unavailable:binding/);
});

test("native dynamic import resolves an actual default-only CommonJS fixture including a constructor", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const fixture = await import('./tests/fixtures/notification-default-only.cjs');
    assert.deepEqual(Object.keys(fixture).filter(key => key !== 'module.exports'), ['default']);
    const helper = await import('./lib/notification-module-interop.ts');
    const resolve = (helper.default ?? helper).notificationModuleFunctions;
    const bindings = resolve(fixture, ['binding', 'Reader']);
    assert.equal(bindings.binding(), 'default-only');
    assert.equal(new bindings.Reader().read(), 'fixture');
    assert.throws(() => resolve(fixture, ['absent']), /notification_module_function_unavailable/);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test("real notification runtime, CLI, coordinator, service, cron, pilot and source tests work with default-only lazy bindings", () => {
  const preload = resolve("tests/fixtures/notification-force-default.cjs");
  const dir = mkdtempSync(join(tmpdir(), "notification-interop-")), trace = join(dir, "resolved.jsonl");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`, NOTIFICATION_TEST_INTEROP_TRACE: trace };
  delete env.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=1",
      "tests/notification-recurring-coordinator.test.ts", "tests/notification-recurring-day10.test.ts",
      "tests/notification-recurring-cron.test.ts", "tests/notification-day10-pilot.test.ts", "tests/notification-runner.test.ts"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
      env,
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /# fail 0/);
    const resolved = new Set(readFileSync(trace, "utf8").trim().split("\n").flatMap(line => JSON.parse(line)));
    for (const name of ["Budget", "JobberReader", "requireTokenRunCoverage", "deployedNotificationInventoryReadBindings",
      "assertReadOnlyRequest", "readNotificationInventory", "readNotificationSourceBatch", "createGhlReadOnlyReader",
      "readNotificationHistory", "inspectRecurringReadScope", "readNotificationSource", "refreshNotificationSource",
      "composeNotificationEvidence", "bootstrapRecurringNotificationReadRuntime"])
      assert.ok(resolved.has(name), `Concrete default-only binding was not exercised: ${name}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concrete pilot bootstrap resolves default-only transport/source bindings with fake IO and preserves token/read-only guards", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--require", "./tests/fixtures/notification-force-default.cjs",
    "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    Object.assign(process.env, { RAILWAY_SERVICE_ID: 'ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f', RAILWAY_ENVIRONMENT_ID: 'bc72bc2d-9a4c-494d-8bee-9ca782db1240',
      RAILWAY_PROJECT_ID: '5d7858db-0443-4891-8a95-1eb1261d3e61', RAILWAY_DEPLOYMENT_ID:'synthetic', DATABASE_URL:'synthetic',
      GHL_API_KEY:'synthetic', GHL_LOCATION_ID:'location', GHL_INVOICE_WRITE_MODE:'review', GHL_PHONE_WRITES_ENABLED:'false', SYNC_ADMISSION_MODE:'cron_only', GHL_NOTIFICATIONS_ENABLED:'false' });
    let expiry = new Date(Date.now() + 910000), reads = 0, closes = 0;
    const sql = [], tx = { $executeRawUnsafe: async statement => sql.push(statement),
      jobberAuth: { findFirst: async () => ({ accessToken: 'synthetic', expiresAt: expiry }) } };
    globalThis.prisma = { $transaction: async fn => fn(tx), $disconnect: async () => { closes++; },
      customer: { findMany: async () => { reads++; return []; } }, invoiceRecord: { findMany: async () => [] } };
    globalThis.fetch = () => { throw Error('provider calls prohibited'); };
    const m = await import('./lib/notification-day10-runtime.ts'), bootstrap = (m.default ?? m).bootstrapDay10PilotRuntime;
    const scope = { accountId:'account', locationId:'location', action:'read-only', expiresAt:new Date(Date.now()+600000).toISOString() };
    const runtime = await bootstrap(scope); assert.equal(reads, 0);
    assert.deepEqual(sql, ['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '10000ms'"]);
    assert.deepEqual(await runtime.sourceIO.customers(), []); assert.equal(reads, 1);
    await assert.rejects(runtime.database.transaction(tx => tx.query('/* notification-ledger:reserve */ INSERT INTO fake VALUES (1)', [])));
    await runtime.close(); assert.equal(closes, 1);
    expiry = new Date(Date.now()+899000); await assert.rejects(bootstrap(scope), /INSUFFICIENT/);
    process.env.GHL_NOTIFICATIONS_ENABLED = 'true'; await assert.rejects(bootstrap(scope), /holds_required/);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test("default-disabled real entrypoints never import source/runtime modules or touch ambient IO", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    const assert = require('node:assert/strict'), Module = require('node:module'), original = Module._load;
    Module._load = function(request, ...args) {
      if (/notification-(?:recurring-cron-config|recurring-runtime|day10-runtime|source|inventory)(?:\\.ts)?$|source-audit\\/transport|(?:^|\\/)prisma(?:\\.ts)?$/.test(request))
        throw Error('ambient import: ' + request);
      return original.call(this, request, ...args);
    };
    Object.defineProperty(globalThis, 'prisma', { get() { throw Error('ambient database'); } });
    globalThis.fetch = () => { throw Error('ambient network'); };
    delete process.env.FLEXX_RECURRING_DAY10_MODE;
    (async () => {
      const cron = require('./lib/notification-recurring-cron.ts');
      assert.equal((await cron.runConfiguredRecurringDay10({ entrypoint:'standalone_cron' })).state, 'disabled');
      const coordinator = require('./lib/notification-recurring-coordinator.ts');
      assert.equal((await coordinator.createRecurringNotificationCoordinator().run()).state, 'disabled');
      const service = require('./lib/notification-recurring-day10.ts');
      assert.equal((await service.createRecurringDay10Service().run()).state, 'disabled');
      const runner = require('./lib/notification-runner.ts');
      assert.equal((await runner.createNotificationRunner().runOne()).state, 'disabled');
      const pilot = require('./lib/notification-day10-pilot.ts');
      assert.equal((await pilot.createDay10Pilot().run()).state, 'disabled');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});

test("installed read-only cron traverses concrete config, service and runtime through default-only exports without attempts", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--require", "./tests/fixtures/notification-force-default.cjs",
    "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    const at = Date.now(), serviceId = 'ee3a4c67-8b0c-48d2-871d-e20bed336c4a', environmentId = 'bc72bc2d-9a4c-494d-8bee-9ca782db1240', projectId = '5d7858db-0443-4891-8a95-1eb1261d3e61';
    Object.assign(process.env, { RAILWAY_SERVICE_ID:serviceId, RAILWAY_ENVIRONMENT_ID:environmentId, RAILWAY_PROJECT_ID:projectId,
      RAILWAY_DEPLOYMENT_ID:'synthetic', DATABASE_URL:'synthetic', GHL_API_KEY:'synthetic', GHL_LOCATION_ID:'location',
      GHL_INVOICE_WRITE_MODE:'review', GHL_PHONE_WRITES_ENABLED:'false', SYNC_ADMISSION_MODE:'cron_only', GHL_NOTIFICATIONS_ENABLED:'false',
      FLEXX_RECURRING_DAY10_MODE:'read-only', FLEXX_RECURRING_DAY10_ACCOUNT_ID:'account' });
    const body = await import('./lib/notification-copy-policy.ts');
    const quarantine = [{jobberClientId:'missing-a',email:null,phone:null},{jobberClientId:'missing-b',email:null,phone:null}];
    const policy = { accountId:'account', locationId:'location', validFrom:new Date(at-1000).toISOString(), validUntil:new Date(at+3600000).toISOString(),
      cohort:'source-verified-open-homeowner-invoices', quarantine, template:{id:'synthetic',version:'1',body:(body.default??body).ORIGINAL_DAY10_SMS_BODY},
      sender:'+16025550101', nativeSms:{version:'2021-07-28',status:'pending',receiptSource:'app',suffix:' Synthetic footer'},
      channel:'sms', dayPastDue:10, timeZone:'America/Phoenix', window:'[09:00:00,09:15:00)', missed:'no-catch-up', maximumAdmissionsPerRun:10, action:'read-only' };
    const raw = JSON.stringify({version:1,deployment:{projectId,environmentId,serviceId,accountId:'account',locationId:'location'},policy});
    process.env.FLEXX_RECURRING_DAY10_POLICY_JSON = raw;
    process.env.FLEXX_RECURRING_DAY10_POLICY_SHA256 = createHash('sha256').update(raw).digest('hex');
    const sql = [], calls = [];
    const customer = {findMany:async q=>q.select._count ? quarantine.map(x=>({...x,_count:{jobs:0,invoices:0}})) : quarantine};
    const invoiceRecord = {findMany:async()=>[]};
    const tx = {customer,invoiceRecord,$executeRawUnsafe:async s=>sql.push(s),jobberAuth:{findFirst:async()=>({accessToken:'synthetic',expiresAt:new Date(at+910000)})}};
    globalThis.prisma = {customer,invoiceRecord,$transaction:async fn=>fn(tx),$disconnect:async()=>{}};
    const page = {nodes:[],pageInfo:{hasNextPage:false,endCursor:null}};
    globalThis.fetch = async (input,init) => {
      const url = String(input); calls.push(url); let value;
      if(url==='https://api.getjobber.com/api/graphql') {
        assert.equal(init.method,'POST'); const {query:q}=JSON.parse(init.body); assert.match(q,/^query/);
        const data = q.includes('NotificationInventoryInvoices') ? {invoices:page} : q.includes('VerifyExplicitIdentityCoverage') ? {clients:page} : {client:null};
        value={data:{account:{id:'account'},...data}};
      } else if(url==='https://services.leadconnectorhq.com/contacts/search') {
        assert.equal(init.method,'POST'); assert.equal(init.redirect,'manual'); value={contacts:[],total:0};
      } else throw Error('unexpected provider operation');
      const response=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}); Object.defineProperty(response,'url',{value:url}); return response;
    };
    const m = await import('./lib/notification-recurring-cron.ts');
    const result = await (m.default??m).runConfiguredRecurringDay10({entrypoint:'standalone_cron'});
    assert.equal(result.state,'completed',JSON.stringify(result)); assert.equal(result.invoices,0); assert.equal(result.admissionAttempts,0); assert.equal(result.messageAttempts,0);
    assert.ok(calls.length>0); assert.ok(sql.includes('SET TRANSACTION READ ONLY'));
    const resolved = globalThis[Symbol.for('notification.test.default-only.calls')];
    for (const name of ['loadInstalledRecurringDay10CronService','installRecurringDay10Policy','createRecurringDay10Service',
      'deployedRecurringDay10Runtime','bootstrapRecurringDay10Runtime','deployedNotificationInventoryReadBindings','assertReadOnlyRequest'])
      assert.ok(resolved.includes(name),name);
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
