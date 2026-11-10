import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecurringNotificationCoordinator, recurringCoordinatorReadiness, type RecurringNotificationReadRuntime } from "../lib/notification-recurring-coordinator";
import { readNotificationInventory, type NotificationInventoryIO } from "../lib/notification-inventory";
import { readNotificationSourceBatch, inspectNotificationSourceDestinations, type NotificationRecurringSourceIO } from "../lib/notification-source";
import type { ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import { notificationEventHash } from "../lib/notification-ledger";
import { eventKey } from "../lib/notification-gate";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";
import { createHash } from "node:crypto";
const NOW = Date.parse("2026-11-10T16:00:00.000Z");
async function clock(run: (advance: (ms: number) => void) => Promise<void>) {
  const real = Date.now; let at = NOW; Date.now = () => at;
  try { await run(ms => { at += ms; }); } finally { Date.now = real; }
}
function sourceFixture() {
  const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
  const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }];
  const fresh = { id: "owner", emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
  const invoice = (id: string, status = "past_due", balance = 137) => ({ id, invoiceNumber: id, invoiceStatus: status,
    amounts: { total: 137, invoiceBalance: balance }, issuedDate: "2026-10-20", dueDate: "2026-10-31", client: { id: "owner" } });
  const data: any = { customers: [owner, ...quarantine], active: [fresh], archived: [],
    contacts: [{ id: "contact", locationId: "location", email: owner.email, phone: owner.phone, tags: ["irrigation"] }],
    invoices: [invoice("old-paid", "paid", 0), invoice("invoice-a"), invoice("invoice-b")],
    stored: [{ jobberInvoiceId: "old-paid" }, { jobberInvoiceId: "invoice-a" }],
    counts: quarantine.map(row => ({ jobberClientId: row.jobberClientId, jobs: 0, invoices: 0 })), tokenRemaining: 900000 };
  const calls: { q: string; vars: any; options: any }[] = []; const counts = { customers: 0, contacts: 0, customer: 0, contact: 0 };
  const query: any = async (q: string, vars: any = {}, options: any) => {
    calls.push({ q, vars: structuredClone(vars), options }); assert.match(q, /^query\b/); assert.match(q, /account \{ id \}/);
    const page = (rows: any[]) => {
      const start = vars.after === null || vars.after === undefined ? 0 : Number(vars.after);
      const nodes = rows.slice(start, start + 25), end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: nodes.length ? String(end) : null } };
    };
    let result: any;
    if (q.includes("NotificationInventoryInvoices")) result = { invoices: page(data.invoices) };
    else if (q.includes("VerifyExplicitIdentityCoverage")) result = { clients: page(q.includes("isArchived: false") ? data.active : data.archived) };
    else if (q.includes("VerifyQuarantinedIdentity")) result = { client: data.reappears ? { id: vars.id } : null };
    else if (q.includes("VerifyDateOwnerInvoices")) result = { client: { id: vars.id, invoices: page(data.invoices.filter((row: any) => row.client.id === vars.id)) } };
    else result = { client: data.active.concat(data.archived).find((row: any) => row.id === vars.ownerId),
      invoice: data.invoices.find((row: any) => row.id === vars.invoiceId) ?? null };
    return structuredClone({ account: { id: data.account ?? "account" }, ...result });
  };
  const policy: ReviewedOmissionPolicy = { accountId: "account", reviewRef: "synthetic-standing-quarantine-policy",
    reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), quarantine: [quarantine[0], quarantine[1]] };
  const sourceIO: NotificationRecurringSourceIO = { locationId: () => data.location ?? "location", query,
    customers: async () => { counts.customers++; return data.customers; },
    contacts: async () => { counts.contacts++; return data.contacts; },
    customer: async id => { counts.customer++; return data.customers.find((row: any) => row.jobberClientId === id) ?? null; },
    contact: async id => { counts.contact++; return data.contacts.find((row: any) => row.id === id); },
    quarantineCounts: async () => data.counts, storedInvoices: async () => data.stored };
  const inventoryIO: NotificationInventoryIO = { locationId: sourceIO.locationId, tokenExpiresAt: () => new Date(Date.now() + data.tokenRemaining), query };
  const request = { version: 1 as const, accountId: "account", locationId: "location", reviewRef: "synthetic-standing-scope",
    expiresAt: new Date(Date.now() + 900000).toISOString() };
  return { data, owner, quarantine, fresh, invoice, calls, counts, policy, sourceIO, inventoryIO, request,
    scan: () => readNotificationInventory(request, inventoryIO), batch: () => readNotificationSourceBatch(policy, sourceIO) };
}
function fixture() {
  const f = sourceFixture();
  f.data.invoices = [f.invoice("invoice-a")]; f.data.stored = [{ jobberInvoiceId: "invoice-a" }];
  f.data.contacts[0].dndSettings = { SMS: { status: "inactive" }, Email: { status: "inactive" } };
  const http: string[] = [], sql: string[] = [];
  const body = (value: unknown) => new Response(JSON.stringify(value)).body!;
  const ledger: Record<string, unknown>[] = [];
  const runtime: RecurringNotificationReadRuntime = {
    accountId: "account", locationId: "location", inventoryIO: f.inventoryIO, sourceIO: f.sourceIO,
    verifyActiveHolds() {},
    contact: { accountId: "account", locationId: "location", credential: "synthetic-only", scopes: ["contacts.readonly"],
      fetch: async (url, init) => { assert.equal(init.method, "GET"); assert.equal(init.headers.Version, "2021-07-28"); http.push(url);
        return { status: 200, body: body({ contact: f.data.contacts[0] }) }; } },
    history: { accountId: "account", locationId: "location", select: async statement => { sql.push(statement); assert.match(statement, /^\/\* notification-history:read-only \*\/\s*SELECT/); return ledger; },
      get: async req => { http.push(req.url); assert.equal(req.method, "GET"); assert.equal(req.headers.Version, "2021-04-15");
        assert.equal(req.maximumAttempts, 1); return { status: 200, body: body({ conversations: [], total: 0 }) }; } },
  };
  const scope = { ...f.request, identityCoveragePolicy: f.policy };
  return { ...f, runtime, scope, http, sql, ledger, body,
    run: () => createRecurringNotificationCoordinator({ mode: "read-only", scope, runtime: async () => runtime }).run() };
}

test("default path is exact no-op, including throwing dependency getters", async () => {
  const options = Object.defineProperties({}, { scope: { get() { throw Error("scope accessed"); } }, runtime: { get() { throw Error("runtime accessed"); } } });
  assert.equal((await createRecurringNotificationCoordinator(options).run()).state, "disabled");
  assert.equal(recurringCoordinatorReadiness().sendCapable, false);
});
test("transitive imports and actual readiness CLI do not initialize ambient Prisma", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    let touches = 0; Object.defineProperty(globalThis, 'prisma', { get() { touches++; throw Error('ambient database'); } });
    globalThis.fetch = () => { throw Error('ambient network'); };
    const m = await import('./lib/notification-recurring-coordinator.ts');
    await (m.default ?? m).createRecurringNotificationCoordinator().run();
    await import('./lib/notification-recurring-runtime.ts');
    await import('./scripts/review-recurring-notifications.ts');
    if (touches) throw Error('ambient access');
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /"sendCapable":false/);
});
test("genuine complete discovery, batch, exact source, tags, DND and union history form redacted report", () => clock(async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.state, "read_only_report"); assert.equal(result.inventory.coverage, "exhausted-query-result");
  assert.equal(result.invoices[0].source, "verified_at_observation");
  assert.deepEqual(result.invoices[0].milestones.map(m => m.dayPastDue).sort((a,b) => a-b), [10,15,21]);
  assert.equal(result.invoices[0].channels.sms.readEligibility, "checks_passed_at_observation");
  assert.equal(result.invoices[0].channels.email.readEligibility, "checks_passed_at_observation");
  assert.equal(result.invoices[0].channels.email.transportReadiness, "email_transport_not_live_verified");
  assert.equal(result.invoices[0].milestones[0].timing, "current_window");
  assert.equal(result.invoices[0].milestones.filter(m => m.audience === "homeowner").every(m => m.priorAttempt === false), true);
  assert.equal(f.counts.customers, 1); assert.equal(f.counts.contacts, 1); assert.equal(f.http.length, 3); assert.equal(f.sql.length, 1);
  assert.equal(result.attempts, 0); assert.equal(result.reservationsCreated, 0); assert.equal(result.messagePolicyAdmission, "not_evaluated");
  for (const forbidden of ["invoice-a", "owner@example.test", "+16025550100", "synthetic-only", "137", "sourceRevision", "Authorization", "account", "location"]) {
    // Count labels may contain "account"; no configured identifiers may appear as values.
    assert.equal(JSON.stringify(result).includes(JSON.stringify(forbidden)), false, forbidden);
  }
}));
for (const channel of ["sms", "email"] as const) test(`${channel}-only recipient stays independently available without forced other channel`, () => clock(async () => {
  const f = fixture();
  if (channel === "sms") { f.owner.email = null as any; f.fresh.emails = []; f.data.contacts[0].email = null; }
  else { f.owner.phone = null as any; f.fresh.phones = []; f.data.contacts[0].phone = null; }
  const result = await f.run(), channels = result.invoices[0].channels;
  assert.equal(channels[channel].primary, "verified_matching_primary");
  assert.equal(channels[channel].readEligibility, "checks_passed_at_observation");
  assert.equal(channels[channel === "sms" ? "email" : "sms"].primary, "unavailable");
  assert.equal(f.http.length, 2);
}));
for (const [label, mutate, expected] of [
  ["missing SMS DND", (c: any) => { delete c.dndSettings.SMS; }, "held"],
  ["global active", (c: any) => { c.dnd = true; }, "blocked"],
  ["SMS permanent", (c: any) => { c.dndSettings.SMS.status = "permanent"; }, "blocked"],
  ["missing global defaults false", (c: any) => { delete c.dnd; }, "allowed"],
] as const) test(label, () => clock(async () => {
  const f = fixture(); mutate(f.data.contacts[0]); const result = await f.run();
  assert.equal(result.invoices[0].channels.sms.dnd, expected);
  assert.equal(result.invoices[0].channels.sms.suppression, expected === "blocked" ? "observed_suppression" : expected === "allowed"
    ? "no_suppression_in_verified_fields" : "unknown_not_observed_opt_out");
}));
for (const tags of [[], ["maintenance"], null]) test(`real tags ${JSON.stringify(tags)} preserve common Day10`, () => clock(async () => {
  const f = fixture(); f.data.contacts[0].tags = tags;
  const result = await f.run();
  assert.equal(result.invoices[0].milestones.find(m => m.dayPastDue === 10)!.planningHolds.length, 0);
  assert.equal(result.invoices[0].milestones.length, 6);
  assert.equal(result.invoices[0].milestones.find(m => m.dayPastDue === 20)!.category, tags === null ? null : "maintenance");
}));
test("history failure is held independently of allowed DND", () => clock(async () => {
  const f = fixture(); (f.runtime.history as any).get = undefined;
  const result = await f.run(); assert.equal(result.state, "held"); assert.equal(result.attempts, 0);
}));
test("unattributed outbound history cannot be erased", () => clock(async () => {
  const f = fixture(); (f.runtime.history as any).get = async (req: any) => ({ status: 200, body: f.body(req.url.includes("/search")
    ? { conversations: [{ id: "conversation", contactId: "contact", locationId: "location" }], total: 1 }
    : { messages: { messages: [{ id: "outbound", conversationId: "conversation", contactId: "contact", locationId: "location", type: 2,
      messageType: "TYPE_SMS", direction: "outbound", dateAdded: "2026-11-10T15:00:00.000Z", status: "sent" }], nextPage: false, lastMessageId: "outbound" } }) });
  const result = await f.run(); assert.equal(result.invoices[0].channels.sms.readEligibility, "held");
  assert.ok(result.invoices[0].channels.sms.holds.length);
  assert.equal(result.invoices[0].channels.sms.history, "attribution_unresolved_not_proof_of_reminder");
  assert.equal(result.invoices[0].milestones[0].priorAttempt, null);
}));
test("local unknown attempt remains visible across repeated read-only scans, no reserve or retry", () => clock(async () => {
  const f = fixture();
  const event: any = { accountId: "account", invoiceId: "invoice-a", ownerId: "owner", homeownerContactId: "contact",
    dayPastDue: 10, audience: "homeowner", sourceRevision: "source", ownerRevision: "owner", issuedDate: "2026-10-20", dueDate: "2026-10-31",
    balanceMinor: 13700, currency: null, category: null, recipientId: "contact", contactId: "contact", channel: "sms", destination: "+16025550100",
    templateId: "original", templateVersion: "1", bodyDigest: createHash("sha256").update(ORIGINAL_DAY10_SMS_BODY).digest("hex"), claimedFacts: [] };
  f.ledger.push({ id: "ledger-row", accountId: "account", invoiceId: "invoice-a", dayPastDue: 10, audience: "homeowner", contactId: "contact", channel: "sms",
    eventKey: eventKey(event), eventPayload: event, eventHash: notificationEventHash(event), state: "unknown", providerMessageId: null });
  const first = await f.run(), second = await f.run();
  for (const result of [first,second]) { assert.equal(result.invoices[0].milestones.find(m => m.dayPastDue === 10)!.priorAttempt, true); assert.equal(result.attempts, 0); }
}));
test("all inventory pages exhaust and all same-contact/day invoices and Angie members remain visible", () => clock(async () => {
  const f = fixture(); f.data.invoices = Array.from({ length: 26 }, (_, i) => f.invoice(`invoice-${i}`)); f.data.stored = [];
  const result = await f.run();
  assert.equal(result.inventory.pages, 2); assert.equal(result.invoices.length, 26); assert.equal(result.internalDigests[0].invoiceOrdinals.length, 26);
  assert.ok(result.invoices.every(row => row.milestones.find(m => m.dayPastDue === 10)!.planningHolds.includes("homeowner_contact_day_conflict")));
  assert.equal(f.counts.customers, 1); assert.equal(f.counts.contacts, 1);
}));
for (const kind of ["paid", "void", "missing-date", "partial-inventory", "source-drift", "population-failure"])
  test(`safe hold/exclusion for ${kind}`, () => clock(async () => {
    const f = fixture();
    if (kind === "paid") { f.data.invoices[0].invoiceStatus = "paid"; f.data.invoices[0].amounts.invoiceBalance = 0; }
    if (kind === "void") f.data.invoices[0].invoiceStatus = "void";
    if (kind === "missing-date") f.data.invoices[0].dueDate = null;
    if (kind === "partial-inventory") (f.runtime.inventoryIO as any).query = async () => { throw Error("secret provider data"); };
    if (kind === "source-drift") (f.runtime.sourceIO as any).customer = async () => ({ ...f.owner, phone: "+16025550102" });
    if (kind === "population-failure") f.data.counts[0].invoices = 1;
    const result = await f.run();
    assert.equal(result.attempts, 0); assert.equal(result.reservationsCreated, 0); assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(result.invoices.some(row => row.source === "verified_at_observation"), false);
  }));
for (const ms of [899999, 900000]) test(`unchanged time gate at +${ms}ms`, () => clock(async advance => {
  const f = fixture(); advance(ms); f.data.tokenRemaining = 1000000; f.scope.expiresAt = new Date(Date.now()+900000).toISOString();
  f.policy.expiresAt = f.scope.expiresAt;
  const result = await f.run(); assert.equal(result.invoices[0].milestones.find(m=>m.dayPastDue===10)!.timing,
    ms === 900000 ? "missed_no_catch_up" : "current_window");
}));
test("expired scope and forged source capability do not access IO", () => clock(async () => {
  const f = fixture(); f.scope.expiresAt = new Date(Date.now()).toISOString();
  assert.equal((await f.run()).state, "held"); assert.equal(f.calls.length, 0);
  assert.throws(() => inspectNotificationSourceDestinations({} as any));
}));
test("same coordinator is single-use and never repeats reads automatically", () => clock(async () => {
  const f = fixture(), coordinator = createRecurringNotificationCoordinator({ mode: "read-only", scope: f.scope, runtime: async () => f.runtime });
  await coordinator.run(); const reads = f.calls.length;
  assert.deepEqual((await coordinator.run()).holds, ["coordinator_already_consumed_no_retry"]); assert.equal(f.calls.length, reads);
}));
test("an observation expiring during the batch cannot be reported current", () => clock(async advance => {
  const f = fixture(); f.data.invoices.push(f.invoice("invoice-b"));
  const original = f.runtime.sourceIO.customer; let calls = 0;
  (f.runtime.sourceIO as any).customer = async (id: string) => { if (++calls === 2) advance(60000); return original(id); };
  const result = await f.run();
  assert.ok(result.invoices[0].holds.includes("observations_expired_before_report"));
  assert.equal(result.invoices[0].channels.sms.readEligibility, "held");
  assert.ok(result.durationMs >= 60000);
}));
test("population expiry reports unprocessed invoices without silent truncation or renewal", () => clock(async advance => {
  const f = fixture(); f.data.invoices.push(f.invoice("invoice-b"));
  const original = f.runtime.history.get;
  (f.runtime.history as any).get = async (req: any) => { const result = await original(req); advance(300000); return result; };
  const result = await f.run();
  assert.equal(result.invoices.length, 2);
  assert.ok(result.invoices[1].holds.includes("shared_population_expired_no_renewal"));
  assert.equal(f.counts.customers, 1); assert.equal(f.counts.contacts, 1);
}));
test("runtime scope mismatch fails before inventory or provider reads", () => clock(async () => {
  const f = fixture(); (f.runtime as any).locationId = "wrong";
  const result = await f.run(); assert.equal(result.state, "held"); assert.equal(f.calls.length, 0); assert.equal(f.http.length, 0);
}));
test("a stalled bootstrap has a bounded local deadline and cannot start later reads", async () => {
  const now = Date.now(), result = await createRecurringNotificationCoordinator({ mode: "read-only", scope: {
    version: 1, accountId: "account", locationId: "location", reviewRef: "synthetic", expiresAt: new Date(now+25).toISOString(),
    identityCoveragePolicy: { accountId: "account", reviewRef: "synthetic", reviewedAt: new Date(now-1000).toISOString(), expiresAt: new Date(now+10000).toISOString(),
      quarantine: [{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}] } }, runtime: async () => new Promise(() => {}) }).run();
  assert.deepEqual(result.holds, ["coordinator_deadline_no_retry"]); assert.equal(result.state, "held");
});
test("source turning paid between discovery and binding is excluded, not an open eligibility claim", () => clock(async () => {
  const f = fixture(), original = f.runtime.sourceIO.customer;
  (f.runtime.sourceIO as any).customer = async (id: string) => { f.data.invoices[0].invoiceStatus = "paid"; f.data.invoices[0].amounts.invoiceBalance = 0; return original(id); };
  const result = await f.run(); assert.equal(result.invoices[0].source, "held"); assert.equal(f.http.length, 0);
}));
test("read-only bootstrap uses existing auth with 900-second guard, and creates no provider call or write", () => {
  const script = `
    const { default: assert } = await import('node:assert/strict');
    Object.assign(process.env, { RAILWAY_SERVICE_ID: 'ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f', RAILWAY_ENVIRONMENT_ID: 'bc72bc2d-9a4c-494d-8bee-9ca782db1240',
      RAILWAY_PROJECT_ID: '5d7858db-0443-4891-8a95-1eb1261d3e61', RAILWAY_DEPLOYMENT_ID:'synthetic', DATABASE_URL:'synthetic',
      GHL_API_KEY:'synthetic', GHL_LOCATION_ID:'location', GHL_INVOICE_WRITE_MODE:'review', GHL_PHONE_WRITES_ENABLED:'false', SYNC_ADMISSION_MODE:'cron_only', GHL_NOTIFICATIONS_ENABLED:'false' });
    let expiry = new Date(Date.now()+910000), authReads = 0;
    const sql = []; const tx = { $executeRawUnsafe: async s => sql.push(s), jobberAuth: { findFirst: async () => { authReads++; return { accessToken:'synthetic', expiresAt:expiry }; } } };
    globalThis.prisma = { $transaction: async fn => fn(tx), customer: { findMany: async () => [] }, invoiceRecord:{ findMany:async()=>[] } };
    globalThis.fetch = () => { throw Error('no provider invocation'); };
    const module = await import('./lib/notification-recurring-runtime.ts');
    const bootstrap = (module.default ?? module).bootstrapRecurringNotificationReadRuntime;
    const scope = { version:1, accountId:'account', locationId:'location', reviewRef:'synthetic', expiresAt:new Date(Date.now()+600000).toISOString(), identityCoveragePolicy:{ accountId:'account' } };
    const runtime = await bootstrap(scope);
    assert.equal(authReads, 1); assert.deepEqual(sql, ['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '10000ms'"]);
    await assert.rejects(runtime.history.select('INSERT INTO fake VALUES (1)', []));
    await assert.rejects(Promise.resolve().then(() => runtime.contact.fetch('https://services.leadconnectorhq.com/contacts/contact', {method:'POST',redirect:'error'})));
    expiry = new Date(Date.now()+899000); await assert.rejects(bootstrap(scope), /INSUFFICIENT/);
    process.env.GHL_NOTIFICATIONS_ENABLED = 'true'; await assert.rejects(bootstrap(scope));
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
test("fake bootstrap through actual deployed readers exhausts inventory and source contacts without permitting message POST", () => {
  const script = `
    const { default: assert } = await import('node:assert/strict');
    const at = Date.parse('2026-11-10T16:00:00.000Z'); Date.now = () => at;
    Object.assign(process.env, { RAILWAY_SERVICE_ID:'ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f', RAILWAY_ENVIRONMENT_ID:'bc72bc2d-9a4c-494d-8bee-9ca782db1240',
      RAILWAY_PROJECT_ID:'5d7858db-0443-4891-8a95-1eb1261d3e61', RAILWAY_DEPLOYMENT_ID:'synthetic', DATABASE_URL:'synthetic', GHL_API_KEY:'synthetic',
      GHL_LOCATION_ID:'location', GHL_INVOICE_WRITE_MODE:'review', GHL_PHONE_WRITES_ENABLED:'false', SYNC_ADMISSION_MODE:'cron_only', GHL_NOTIFICATIONS_ENABLED:'false' });
    const owner = {jobberClientId:'owner',email:'owner@example.test',phone:'+16025550100'};
    const quarantine = [{jobberClientId:'missing-a',email:null,phone:null},{jobberClientId:'missing-b',email:null,phone:null}];
    const fresh = {id:'owner',emails:[{address:owner.email,primary:true}],phones:[{number:owner.phone,primary:true}]};
    const invoice = {id:'invoice',invoiceNumber:'001',invoiceStatus:'past_due',amounts:{total:137,invoiceBalance:137},issuedDate:'2026-10-20',dueDate:'2026-10-31',client:{id:'owner'}};
    const contact = {id:'contact',locationId:'location',email:owner.email,phone:owner.phone,tags:['irrigation'],dndSettings:{SMS:{status:'inactive'},Email:{status:'inactive'}}};
    const sql = [], calls = [];
    const tx = { $executeRawUnsafe:async s => sql.push(s), jobberAuth:{findFirst:async()=>({accessToken:'synthetic',expiresAt:new Date(at+910000)})},
      $queryRawUnsafe:async s => {sql.push(s);assert.match(s,/^\\/\\* notification-history:read-only \\*\\/\\s*SELECT/);return [];} };
    globalThis.prisma = { $transaction:async fn=>fn(tx), customer:{findMany:async q=>q.select._count ? quarantine.map(x=>({...x,_count:{jobs:0,invoices:0}})) : q.where ? [owner] : [owner,...quarantine]}, invoiceRecord:{findMany:async()=>[{jobberInvoiceId:'invoice'}]} };
    Object.assign(tx, { customer: globalThis.prisma.customer, invoiceRecord: globalThis.prisma.invoiceRecord });
    const page = nodes => ({nodes,pageInfo:{hasNextPage:false,endCursor:nodes.length?'done':null}});
    globalThis.fetch = async (input, init) => {
      const url=String(input);calls.push([url,init.method,init.redirect]); let value;
      if(url==='https://api.getjobber.com/api/graphql') {
        assert.equal(init.method,'POST'); const {query:q,variables:v}=JSON.parse(init.body);assert.match(q,/^query/);
        let data;
        if(q.includes('NotificationInventoryInvoices')) data={invoices:page([invoice])};
        else if(q.includes('VerifyExplicitIdentityCoverage')) data={clients:page(q.includes('isArchived: false')?[fresh]:[])};
        else if(q.includes('VerifyQuarantinedIdentity')) data={client:null};
        else if(q.includes('VerifyDateOwnerInvoices')) data={client:{id:'owner',invoices:page([invoice])}};
        else data={client:fresh,invoice};
        value={data:{account:{id:'account'},...data}};
      } else if(url==='https://services.leadconnectorhq.com/contacts/search') {
        assert.equal(init.method,'POST');assert.equal(init.redirect,'manual');assert.equal(JSON.parse(init.body).locationId,'location');value={contacts:[contact],total:1};
      } else if(url==='https://services.leadconnectorhq.com/contacts/contact') {
        assert.equal(init.method,'GET');value={contact};
      } else if(url.startsWith('https://services.leadconnectorhq.com/conversations/search?')) {
        assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.headers.Version,'2021-04-15');value={conversations:[],total:0};
      } else throw Error('Unexpected network target');
      const response=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(response,'url',{value:url});return response;
    };
    const r=await import('./lib/notification-recurring-runtime.ts'), c=await import('./lib/notification-recurring-coordinator.ts');
    const bootstrap=(r.default??r).bootstrapRecurringNotificationReadRuntime, coordinator=(c.default??c).createRecurringNotificationCoordinator;
    const scope={version:1,accountId:'account',locationId:'location',reviewRef:'synthetic',expiresAt:new Date(at+600000).toISOString(),identityCoveragePolicy:{accountId:'account',reviewRef:'synthetic',reviewedAt:new Date(at-1000).toISOString(),expiresAt:new Date(at+900000).toISOString(),quarantine}};
    const result=await coordinator({mode:'read-only',scope,runtime:()=>bootstrap(scope)}).run();
    assert.equal(result.state,'read_only_report',JSON.stringify(result));assert.equal(result.invoices[0].source,'verified_at_observation',JSON.stringify(result));
    assert.equal(result.invoices[0].channels.sms.readEligibility,'checks_passed_at_observation');assert.equal(result.invoices[0].channels.email.readEligibility,'checks_passed_at_observation');
    assert.equal(calls.filter(c=>c[0].endsWith('/contacts/search')).length,1);assert.ok(calls.some(c=>c[0].endsWith('/contacts/contact')&&c[2]==='manual'));
    assert.equal(calls.some(c=>c[0].includes('/conversations/messages')&&c[1]==='POST'),false);assert.equal(result.reservationsCreated,0);assert.equal(result.attempts,0);
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
});
test("Angie history is not inferred from a homeowner contact's empty history", () => clock(async () => {
  const result = await fixture().run(), internal = result.invoices[0].milestones.find(item => item.audience === "internal")!;
  assert.equal(internal.priorAttempt, null); assert.ok(internal.readHolds.includes("internal_history_not_evaluated"));
}));
test("held provider history preserves a positively observed local attempt without proving other-event absence", () => clock(async () => {
  const f = fixture();
  const event: any = { accountId: "account", invoiceId: "invoice-a", ownerId: "owner", homeownerContactId: "contact",
    dayPastDue: 10, audience: "homeowner", sourceRevision: "source", ownerRevision: "owner", issuedDate: "2026-10-20", dueDate: "2026-10-31",
    balanceMinor: 13700, currency: null, category: null, recipientId: "contact", contactId: "contact", channel: "sms", destination: "+16025550100",
    templateId: "original", templateVersion: "1", bodyDigest: createHash("sha256").update(ORIGINAL_DAY10_SMS_BODY).digest("hex"), claimedFacts: [] };
  f.ledger.push({ id: "ledger-row", accountId: "account", invoiceId: "invoice-a", dayPastDue: 10, audience: "homeowner", contactId: "contact", channel: "sms",
    eventKey: eventKey(event), eventPayload: event, eventHash: notificationEventHash(event), state: "unknown", providerMessageId: null });
  (f.runtime.history as any).get = async () => ({ status: 503, body: null });
  const result = await f.run(), milestones = result.invoices[0].milestones;
  assert.equal(milestones.find(m=>m.dayPastDue===10)!.priorAttempt, true);
  assert.equal(milestones.find(m=>m.dayPastDue===15)!.priorAttempt, null);
  assert.ok(milestones.find(m=>m.dayPastDue===15)!.readHolds.includes("history_absence_unproven"));
}));
test("real deadline during a stalled selected read retains every discovered invoice ordinal and digest member", () => clock(async () => {
  const f = fixture(); f.data.invoices.push(f.invoice("invoice-b"), f.invoice("invoice-c"));
  f.scope.expiresAt = new Date(Date.now()+150).toISOString(); let entered = 0;
  (f.runtime.sourceIO as any).customer = async () => { entered++; return new Promise(() => {}); };
  const result = await f.run();
  assert.equal(entered, 1); assert.equal(result.state, "held");
  assert.deepEqual(result.invoices.map(row=>row.invoiceOrdinal), [1,2,3]);
  assert.ok(result.invoices.every(row=>row.holds.includes("invoice_not_evaluated_before_deadline_no_retry")));
  assert.deepEqual(result.internalDigests[0].invoiceOrdinals, [1,2,3]);
}));

for (const stalled of ["open", "read"]) test(`readiness deadline covers stalled file ${stalled}`, () => {
  const script = `
    const fs = require("node:fs/promises");
    const never = () => new Promise(() => {});
    fs.open = ${JSON.stringify(stalled)} === "open" ? never : async () => ({
      stat: async () => ({ isFile: () => true, size: 2, mtimeMs: 1, ctimeMs: 1 }),
      read: never, close: async () => {}
    });
    require("node:module").syncBuiltinESMExports();
    const originalTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 330000 ? 20 : ms, ...args);
    process.argv = ["node", "script", "--readiness", "synthetic-never-read", "0".repeat(64), "synthetic-review"];
    import("./scripts/review-recurring-notifications.ts");
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 3, child.stderr); assert.match(child.stderr, /runtime limit reached/); assert.equal(child.stdout, "");
});
test("readiness safely rejects symlink, directory and oversized files without runtime initialization", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-recurring-cli-"));
  try {
    const small = join(dir, "small.json"), link = join(dir, "link.json"), large = join(dir, "large.json");
    writeFileSync(small, "{}"); symlinkSync(small, link); writeFileSync(large, " ".repeat(32_769));
    for (const path of [link, dir, large]) {
      const script = `
        Object.defineProperty(globalThis, "prisma", { get() { throw new Error("ambient touched"); } });
        process.argv = ["node", "script", "--readiness", ${JSON.stringify(path)}, "0".repeat(64), "synthetic-review"];
        import("./scripts/review-recurring-notifications.ts");
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, 2, child.stderr); assert.equal(child.stdout, ""); assert.doesNotMatch(child.stderr, /ambient touched/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("operator CLI validates pinned scope without runtime import and rejects altered bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-recurring-scope-"));
  try {
    const now = Date.now(), scope = { version:1,accountId:"account",locationId:"location",reviewRef:"synthetic-review",expiresAt:new Date(now+600000).toISOString(),
      identityCoveragePolicy:{accountId:"account",reviewRef:"synthetic-omissions",reviewedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString(),
        quarantine:[{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}] } };
    const path = join(dir, "scope.json"), raw = JSON.stringify(scope), hash = createHash("sha256").update(raw).digest("hex"); writeFileSync(path, raw);
    const script = `Object.defineProperty(globalThis,'prisma',{get(){throw Error('ambient accessed');}});
      process.argv=['node','script','--readiness',${JSON.stringify(path)},${JSON.stringify(hash)},'synthetic-review'];
      import('./scripts/review-recurring-notifications.ts');`;
    const first = spawnSync(process.execPath,["--import","tsx","-e",script],{cwd:process.cwd(),encoding:"utf8",timeout:5000});
    assert.equal(first.status,0,first.stderr); assert.match(first.stdout,/"scopeState":"valid_read_scope_shape"/);
    writeFileSync(path, raw+" ");
    const second = spawnSync(process.execPath,["--import","tsx","-e",script],{cwd:process.cwd(),encoding:"utf8",timeout:5000});
    assert.equal(second.status,2); assert.equal(second.stdout,"");
    const code = readFileSync("scripts/review-recurring-notifications.ts","utf8"); assert.doesNotMatch(code,/one-attempt|createGhlOneAttemptTransport|reserve\(/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("query exhaustion never classifies omitted cached invoices as paid, deleted or eligible", () => clock(async () => {
  const f = fixture(); f.data.invoices = []; // Cached invoice-a remains present and unresolved.
  const result = await f.run();
  assert.equal(result.inventory.coverage, "exhausted-query-result");
  assert.equal(result.inventory.defaultStatusScope, "unverified");
  assert.equal(result.inventory.cacheOnlyInvoiceCount, null);
  assert.equal(result.inventory.cacheOnlyEligibility, "unknown_not_evaluated");
  assert.ok(result.holds.includes("cache_only_source_omissions_not_reconciled"));
  assert.equal(result.invoices.length, 0); assert.equal(f.data.stored.length, 1);
}));
for (const kind of ["insufficient-token", "late-bootstrap"] as const) test(`standalone CLI closes partially acquired runtime after ${kind}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-recurring-cleanup-"));
  try {
    const now = Date.now(), scope = {version:1,accountId:"account",locationId:"location",reviewRef:"synthetic-review",expiresAt:new Date(now+(kind==="late-bootstrap"?150:600000)).toISOString(),
      identityCoveragePolicy:{accountId:"account",reviewRef:"synthetic",reviewedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+600000).toISOString(),
        quarantine:[{jobberClientId:"missing-a",email:null,phone:null},{jobberClientId:"missing-b",email:null,phone:null}]}};
    const path=join(dir,"scope.json"), raw=JSON.stringify(scope), hash=createHash("sha256").update(raw).digest("hex");writeFileSync(path,raw);
    const script=`
      const at=${now};Date.now=()=>at;
      Object.assign(process.env,{RAILWAY_SERVICE_ID:'ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f',RAILWAY_ENVIRONMENT_ID:'bc72bc2d-9a4c-494d-8bee-9ca782db1240',
        RAILWAY_PROJECT_ID:'5d7858db-0443-4891-8a95-1eb1261d3e61',RAILWAY_DEPLOYMENT_ID:'synthetic',DATABASE_URL:'synthetic',GHL_API_KEY:'synthetic',GHL_LOCATION_ID:'location',
        GHL_INVOICE_WRITE_MODE:'review',GHL_PHONE_WRITES_ENABLED:'false',SYNC_ADMISSION_MODE:'cron_only',GHL_NOTIFICATIONS_ENABLED:'false'});
      globalThis.fetch=()=>{throw Error('no provider calls');};
      const tx={$executeRawUnsafe:async()=>{},jobberAuth:{findFirst:async()=>({accessToken:'synthetic',expiresAt:new Date(at+${kind === "insufficient-token" ? 899000 : 910000})})}};
      let closes=0;globalThis.prisma={$disconnect:async()=>{closes++;console.log('SYNTHETIC_CLOSED');},
        $transaction:async fn=>{${kind === "late-bootstrap" ? "await new Promise(r=>setTimeout(r,300));" : ""}return fn(tx);},
        customer:{findMany:async()=>[]},invoiceRecord:{findMany:async()=>[]}};
      process.on('exit',()=>{if(closes!==1)process.exitCode=9;});
      process.argv=['node','script','--read-only',${JSON.stringify(path)},${JSON.stringify(hash)},'synthetic-review'];
      import('./scripts/review-recurring-notifications.ts');
    `;
    const child=spawnSync(process.execPath,["--import","tsx","-e",script],{cwd:process.cwd(),encoding:"utf8",timeout:5000});
    assert.equal(child.status,0,child.stderr+child.stdout);assert.equal(child.stdout.split("SYNTHETIC_CLOSED").length-1,1);
    assert.match(child.stdout,/"state":"held"/);
    if(kind==="late-bootstrap")assert.match(child.stdout,/coordinator_deadline_no_retry/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
