import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRecurringDay10Service, installRecurringDay10Policy, deployedRecurringDay10Runtime,
  type RecurringDay10Runtime, type RecurringDay10Policy } from "../lib/notification-recurring-day10";
import { readNotificationInventory, type NotificationInventoryIO } from "../lib/notification-inventory";
import { readNotificationSourceBatch, inspectRecurringNotificationSource, refreshNotificationSource, inspectNotificationSource,
  type NotificationRecurringSourceIO } from "../lib/notification-source";
import { readDiscoveredNotificationSource } from "../lib/notification-inventory";
import type { ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import type { NotificationLedgerDatabase, NotificationLedgerTransaction } from "../lib/notification-ledger";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";
let sequence = 0;
const NOW = Date.parse("2026-11-10T16:00:00.000Z");
async function clock(run: (tick: (ms?: number) => void) => Promise<void>) {
  const real = Date.now; let at = NOW; Date.now = () => at;
  try { await run((ms = 1) => { at += ms; }); } finally { Date.now = real; }
}
function sourceFixture(tick: (ms?: number) => void) {
  const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
  const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }];
  const fresh = { id: "owner", emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
  const invoice = (id: string, status = "past_due", balance = 137) => ({ id, invoiceNumber: id, invoiceStatus: status,
    amounts: { total: 137, invoiceBalance: balance }, issuedDate: "2026-10-20", dueDate: "2026-10-31", client: { id: "owner" } });
  const data: any = { customers: [owner, ...quarantine], active: [fresh], archived: [],
    contacts: [{ id: "contact", locationId: "location", email: owner.email, phone: owner.phone, tags: ["irrigation"] }],
    invoices: [invoice("old-paid", "paid", 0), invoice(`invoice-${++sequence}`), invoice("invoice-b")],
    stored: [{ jobberInvoiceId: "old-paid" }, { jobberInvoiceId: `invoice-${++sequence}` }],
    counts: quarantine.map(row => ({ jobberClientId: row.jobberClientId, jobs: 0, invoices: 0 })), tokenRemaining: 900000 };
  const calls: { q: string; vars: any; options: any }[] = []; const counts = { customers: 0, contacts: 0, customer: 0, contact: 0 };
  const query: any = async (q: string, vars: any = {}, options: any) => {
    tick(); calls.push({ q, vars: structuredClone(vars), options }); assert.match(q, /^query\b/); assert.match(q, /account \{ id \}/);
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
    customers: async () => { tick(); counts.customers++; return data.customers; },
    contacts: async () => { tick(); counts.contacts++; return data.contacts; },
    customer: async id => { tick(); counts.customer++; return data.customers.find((row: any) => row.jobberClientId === id) ?? null; },
    contact: async id => { tick(); counts.contact++; return data.contacts.find((row: any) => row.id === id); },
    quarantineCounts: async () => data.counts, storedInvoices: async id => data.stored.filter((s: any) => data.invoices.find((i: any) => i.id === s.jobberInvoiceId)?.client.id === id) };
  const inventoryIO: NotificationInventoryIO = { locationId: sourceIO.locationId, tokenExpiresAt: () => new Date(Date.now() + data.tokenRemaining), query };
  const request = { version: 1 as const, accountId: "account", locationId: "location", reviewRef: "synthetic-standing-scope",
    expiresAt: new Date(Date.now() + 900000).toISOString() };
  return { data, owner, quarantine, fresh, invoice, calls, counts, policy, sourceIO, inventoryIO, request,
    scan: () => readNotificationInventory(request, inventoryIO), batch: () => readNotificationSourceBatch(policy, sourceIO) };
}
class Database implements NotificationLedgerDatabase {
  rows: Record<string, any>[] = []; operations: string[] = [];
  hook: ((operation: string) => void) | null = null;
  fail: string | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    let operation = "";
    const value = await work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      operation = /notification-(ledger|runner|history):([\w-]+)/.exec(sql)!.slice(1).join(":"); this.operations.push(operation);
      if (this.fail === operation) throw new Error("secret database failure");
      if (operation === "history:read-only") return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.contactId === v[1])) as R[];
      if (operation === "runner:history") return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.eventKey === v[1])) as R[];
      if (operation === "ledger:reserve") {
        if (this.rows.some(r => r.eventKey === v[2])) return [];
        const e = JSON.parse(v[10] as string), row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], invoiceId: v[4],
          dayPastDue: v[5], audience: v[6], contactId: v[7], scheduledOn: v[8], channel: v[9], eventPayload: e,
          eventHash: v[13], bodyHash: v[14], destinationHash: v[15], state: "reserved", providerMessageId: null };
        this.rows.push(row); return [{ id: row.id }] as unknown as R[];
      }
      const row = this.rows.find(r => r.id === v[0]);
      if (!row || row.reservationToken !== v[1] || row.eventHash !== v[2] || row.bodyHash !== v[3] || row.destinationHash !== v[4] ||
          row.state !== (operation === "ledger:outcome" ? "pending" : "reserved")) return [];
      if (operation === "ledger:pending") row.state = "pending";
      if (operation === "ledger:outcome") { row.state = v[5]; row.providerMessageId = v[6]; }
      return [{ id: row.id }] as unknown as R[];
    } });
    this.hook?.(operation); return value;
  }
}
function fixture(tick: (ms?: number) => void) {
  const f = sourceFixture(tick), db = new Database();
  f.data.invoices = [f.invoice(`day10-${++sequence}`)]; f.data.stored = [];
  f.data.contacts[0].dndSettings = { SMS: { status: "inactive" }, Email: { status: "inactive" } };
  const p: RecurringDay10Policy = { accountId: "account", locationId: "location", validFrom: new Date(NOW-1000).toISOString(),
    validUntil: new Date(NOW+86400000*30).toISOString(), cohort: "source-verified-open-homeowner-invoices", quarantine: f.policy.quarantine,
    template: { id: "original-day10", version: "1", body: ORIGINAL_DAY10_SMS_BODY }, sender: "+16025550101",
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", suffix: "\nReply STOP to unsubscribe.\nThanks, Synthetic Company" },
    channel: "sms", dayPastDue: 10, timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)", missed: "no-catch-up",
    maximumAdmissionsPerRun: 10, action: "attempt" };
  const calls: { url: string; method: string; body?: string }[] = [], data = { posts: 0, senderSms: true, holds: true,
    postThrow: false, postStatus: 201, historyOutbound: false, bootstrap: 0, sourceReads: 0 };
  const query = f.sourceIO.query;
  (f.sourceIO as any).query = async (q: string, v: any) => { if (q.includes("VerifyDateOwnerInvoices")) data.sourceReads++; return query(q, v); };
  const runtime: RecurringDay10Runtime = { accountId: "account", locationId: "location", credential: "synthetic-fake-token",
    inventoryIO: f.inventoryIO, sourceIO: f.sourceIO, database: db,
    verifyActiveHolds: () => { if (!data.holds) throw Error("holds changed"); },
    fetch: (async (input, init) => {
      tick(); const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
      calls.push({ url, method, body: init?.body as string | undefined });
      let body: unknown, status = 200;
      if (url.includes("/phone-system/")) {
        assert.equal(headers.get("Version"), "v3");
        body = { status: "success", statusCode: 200, message: "ok", data: { page: 0, pageSize: 100, accountStatus: "active",
          numbers: [{ phoneNumber: p.sender, capabilities: { sms: data.senderSms } }] } };
      } else if (url.includes("/contacts/")) {
        assert.equal(headers.get("Version"), "2021-07-28"); body = { contact: f.data.contacts.find((c: any) => url.endsWith(`/${c.id}`)) };
      } else if (url.includes("/conversations/search")) {
        assert.equal(headers.get("Version"), "2021-04-15");
        body = data.historyOutbound ? { total: 1, conversations: [{ id: "conversation", contactId: "contact", locationId: "location" }] }
          : { total: 0, conversations: [] };
      } else if (url.includes("/conversation/messages")) {
        body = { messages: { nextPage: false, lastMessageId: "old", messages: [{ id: "old", type: 2,
          messageType: "TYPE_SMS", direction: "outbound", status: "delivered", contactId: "contact", locationId: "location",
          conversationId: "conversation", dateAdded: "2026-11-09T16:00:00.000Z" }] } };
      } else if (url.endsWith("/conversations/messages")) {
        assert.equal(method, "POST"); const wire = JSON.parse(init!.body as string);
        const row = db.rows.find(row => row.contactId === wire.contactId);
        assert.ok(row); assert.equal(row.state, "pending"); assert.equal(wire.message, ORIGINAL_DAY10_SMS_BODY);
        assert.equal(wire.fromNumber, p.sender); assert.equal(wire.status, "pending");
        data.posts++; if (data.postThrow) throw Error("uncertain fake send");
        status = data.postStatus; body = { messageId: `fake-message-${data.posts}`, conversationId: "conversation" };
      } else throw Error(`Unexpected fake URL ${url}`);
      const response = new Response(JSON.stringify(body), { status }); Object.defineProperty(response, "url", { value: url }); return response;
    }) as typeof fetch };
  const scopes: any[] = [];
  const run = (mode: "read-only" | "attempt" = "attempt", policy = installRecurringDay10Policy(p)) => createRecurringDay10Service({ mode, policy,
    runtime: async scope => { data.bootstrap++; scopes.push(scope); return runtime; } });
  const addOwner = () => {
    const owner = { jobberClientId: `owner-${++sequence}`, email: `owner-${sequence}@example.test`, phone: "+16025550105" };
    f.data.customers.push(owner); f.data.active.push({ id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] });
    f.data.contacts.push({ id: `contact-${sequence}`, locationId: "location", email: owner.email, phone: owner.phone, tags: [], dndSettings: { SMS: { status: "inactive" } } });
    const invoice = f.invoice(`invoice-${sequence}`); invoice.client.id = owner.jobberClientId; f.data.invoices.push(invoice);
  };
  return { ...f, p, db, http: calls, state: data, runtime, run, scopes, addOwner };
}

test("default service is exact no-op including throwing policy/runtime getters", async () => {
  const service = createRecurringDay10Service({ get policy(): never { throw Error("accessed"); }, get runtime(): never { throw Error("accessed"); } });
  assert.equal((await service.run()).state, "disabled");
});
test("module import/default execution never initializes ambient Prisma or fetch", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    Object.defineProperty(globalThis, 'prisma', { get() { throw Error('ambient Prisma'); } });
    globalThis.fetch = () => { throw Error('ambient fetch'); };
    const m = await import('./lib/notification-recurring-day10.ts');
    await (m.default ?? m).createRecurringDay10Service().run();
    await import('./lib/notification-recurring-runtime.ts');
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 }); assert.equal(r.status, 0, r.stderr);
});
test("original/clone/JSON boolean policy and read-only action cannot authorize attempts", () => clock(async tick => {
  const f = fixture(tick), h = installRecurringDay10Policy({ ...f.p, action: "read-only" });
  for (const policy of [h, structuredClone(h), { ...f.p, approved: true } as any]) {
    const r = await f.run("attempt", policy).run(); assert.equal(r.state, "held"); assert.equal(f.state.bootstrap, 0);
  }
  assert.throws(() => installRecurringDay10Policy({ ...f.p, approved: true } as any));
}));
test("read-only genuine v2 flow performs original and admission rereads without reservation or POST", () => clock(async tick => {
  const f = fixture(tick), r = await f.run("read-only").run();
  assert.equal(r.invoices[0].result?.phase, "read_only", JSON.stringify(r));
  assert.equal(f.state.sourceReads, 2); assert.equal(r.admissionAttempts, 0); assert.equal(r.messageAttempts, 0);
  assert.equal(f.db.rows.length, 0); assert.ok(f.db.operations.every(op => ["history:read-only", "runner:history"].includes(op)));
  assert.equal(f.counts.contacts, 1); assert.equal(f.counts.customers, 1);
}));
test("automatic cohort source -> existing runner -> ledger -> fake single attempt, exact original copy no currency", () => clock(async tick => {
  const f = fixture(tick), service = f.run(), r = await service.run();
  assert.equal(r.invoices[0].result?.state, "accepted", JSON.stringify(r)); assert.equal(r.messageAttempts, 1); assert.equal(r.admissionAttempts, 1);
  assert.equal(f.state.sourceReads, 3); assert.equal(f.db.rows[0].eventPayload.currency, null);
  assert.equal(f.db.rows[0].eventPayload.category, null); assert.deepEqual(f.db.rows[0].eventPayload.claimedFacts, []);
  assert.equal(f.counts.contacts, 1); assert.equal(f.counts.customers, 1); assert.equal(f.counts.contact, 3);
  assert.equal((await service.run()).state, "held"); assert.equal(f.state.posts, 1);
}));
test("multiple owners execute distinct events without per-invoice approvals or repeated all-contact scans", () => clock(async tick => {
  const f = fixture(tick); f.addOwner(); const r = await f.run().run();
  assert.equal(r.messageAttempts, 2, JSON.stringify(r)); assert.equal(r.admissionAttempts, 2); assert.equal(f.db.rows.length, 2);
  assert.equal(f.counts.contacts, 1); assert.equal(f.counts.customers, 1); assert.equal(f.state.sourceReads, 6);
}));
test("multiple invoices per owner remain visible; same contact/day conflict holds all instead of selecting one", () => clock(async tick => {
  const f = fixture(tick); f.data.invoices.push(f.invoice(`second-${++sequence}`));
  const r = await f.run().run(); assert.equal(r.messageAttempts, 0); assert.equal(r.invoices.length, 2);
  assert.ok(r.invoices.every(row => row.holds.includes("homeowner_contact_day_conflict"))); assert.equal(f.state.sourceReads, 0);
}));
test("only current Day10 invoices get exact source/sender/DND/history reads", () => clock(async tick => {
  const f = fixture(tick);
  for (let i = 0; i < 30; i++) f.data.invoices.push({ ...f.invoice(`not-due-${i}`), dueDate: "2026-11-05" });
  const r = await f.run().run(); assert.equal(r.invoices.length, 31); assert.equal(r.messageAttempts, 1, JSON.stringify(r));
  assert.equal(f.state.sourceReads, 6); assert.equal(f.counts.contact, 3); // Complete owner invoice pagination on each of three reads.
}));
for (const absent of ["settings", "SMS"] as const) for (const phase of ["initial", "final"] as const)
  test(`${phase} genuine ${absent} omission preserves one synthetic SMS attempt and ledger fencing`, () => clock(async tick => {
    const f = fixture(tick);
    const omit = () => { if (absent === "settings") delete f.data.contacts[0].dndSettings; else delete f.data.contacts[0].dndSettings.SMS; };
    if (phase === "initial") omit();
    else f.db.hook = op => { if (op === "ledger:reserve") omit(); };
    const service = f.run(), result = await service.run();
    assert.equal(result.invoices[0].result?.state, "accepted", JSON.stringify(result));
    assert.equal(f.state.posts, 1); assert.equal(f.state.sourceReads, 3);
    assert.equal(f.db.rows[0].state, "accepted");
    assert.equal(f.http.filter(call => call.method === "POST").length, 1);
    const wire = JSON.parse(f.http.find(call => call.method === "POST")!.body!);
    assert.equal(wire.type, "SMS"); assert.equal(wire.message, ORIGINAL_DAY10_SMS_BODY);
    await service.run(); await f.run().run(); assert.equal(f.state.posts, 1);
  }));
for (const [label, mutate] of [
  ["global active", (c: any) => { c.dnd = true; }],
  ["SMS active", (c: any) => { c.dndSettings = { SMS: { status: "active" } }; }],
  ["SMS permanent", (c: any) => { c.dndSettings = { SMS: { status: "permanent" } }; }],
  ["present malformed settings", (c: any) => { c.dndSettings = null; }],
  ["present malformed SMS", (c: any) => { c.dndSettings = { SMS: null }; }],
  ["present SMS missing status", (c: any) => { c.dndSettings = { SMS: {} }; }],
  ["wrong-case SMS alias", (c: any) => { c.dndSettings = { Sms: { status: "active" } }; }],
  ["wrong-case settings alias", (c: any) => { c.dndsettings = { SMS: { status: "active" } }; }],
  ["wrong-case global alias", (c: any) => { c.Dnd = true; }],
] as const) test(`sparse SMS final reread catches ${label} and retains the reservation without POST/retry`, () => clock(async tick => {
  const f = fixture(tick); delete f.data.contacts[0].dndSettings;
  f.db.hook = op => { if (op === "ledger:reserve") mutate(f.data.contacts[0]); };
  const result = await f.run().run();
  assert.equal(result.state, "unknown", JSON.stringify(result)); assert.equal(result.admissionAttempts, 1);
  assert.equal(f.db.rows[0].state, "reserved"); assert.equal(f.state.posts, 0);
  assert.equal(f.db.operations.includes("ledger:pending"), false);
  await f.run().run(); assert.equal(f.state.posts, 0);
}));
for (const kind of ["email-only", "sms-mismatch", "missing-sms-status", "sms-active", "sender", "unattributed-history", "quarantine", "paid", "runtime-location"])
  test(`held ${kind} never creates attempt or falls back to Email`, () => clock(async tick => {
    const f = fixture(tick);
    if (kind === "email-only") { f.owner.phone = null as any; f.fresh.phones = []; f.data.contacts[0].phone = null; }
    if (kind === "sms-mismatch") f.data.contacts[0].phone = "+16025550109";
    if (kind === "missing-sms-status") f.data.contacts[0].dndSettings.SMS = {};
    if (kind === "sms-active") f.data.contacts[0].dndSettings.SMS.status = "active";
    if (kind === "sender") f.state.senderSms = false;
    if (kind === "unattributed-history") f.state.historyOutbound = true;
    if (kind === "quarantine") f.data.counts[0].jobs = 1;
    if (kind === "paid") { f.data.invoices[0].invoiceStatus = "paid"; f.data.invoices[0].amounts.invoiceBalance = 0; }
    if (kind === "runtime-location") (f.runtime as any).locationId = "other";
    const r = await f.run().run(); assert.equal(r.messageAttempts, 0); assert.equal(f.db.rows.length, 0);
  }));
for (const kind of ["balance", "due-date", "identity", "missing-dnd-status", "sender", "history", "expiry"])
  test(`final ${kind} change preserves reservation and forbids POST/retry`, () => clock(async tick => {
    const f = fixture(tick); f.db.hook = op => {
      if (op !== "ledger:reserve") return;
      if (kind === "balance") f.data.invoices[0].amounts.invoiceBalance = 100;
      if (kind === "due-date") f.data.invoices[0].dueDate = "2026-10-30";
      if (kind === "identity") f.data.contacts[0].phone = "+16025550109";
      if (kind === "missing-dnd-status") f.data.contacts[0].dndSettings.SMS = {};
      if (kind === "sender") f.state.senderSms = false;
      if (kind === "history") f.state.historyOutbound = true;
      if (kind === "expiry") tick(300000);
    };
    const r = await f.run().run(); assert.equal(r.state, "unknown", JSON.stringify(r));
    assert.equal(r.admissionAttempts, 1); assert.equal(f.db.rows[0].state, "reserved"); assert.equal(f.state.posts, 0);
    await f.run().run(); assert.equal(f.state.posts, 0);
  }));
for (const kind of ["timeout", "500", "pending-failure", "outcome-failure"])
  test(`${kind} uncertain fake outcome stops cohort and never retries`, () => clock(async tick => {
    const f = fixture(tick); f.addOwner();
    if (kind === "timeout") f.state.postThrow = true;
    if (kind === "500") f.state.postStatus = 500;
    if (kind === "pending-failure") f.db.fail = "ledger:pending";
    if (kind === "outcome-failure") f.db.fail = "ledger:outcome";
    const r = await f.run().run(); assert.equal(r.state, "unknown", JSON.stringify(r));
    assert.equal(f.db.rows.length, 1); assert.ok(f.state.posts <= 1); const before = f.state.posts;
    // A new invocation may inspect other invoices, but cannot retry the first logical event.
    f.data.invoices = [f.data.invoices[0]]; await f.run().run(); assert.equal(f.state.posts, before);
  }));
test("prior durable unknown attempt holds after new service instantiation", () => clock(async tick => {
  const f = fixture(tick); f.state.postThrow = true; await f.run().run(); const r = await f.run().run();
  assert.equal(r.admissionAttempts, 0); assert.equal(r.messageAttempts, 0); assert.equal(f.state.posts, 1);
  assert.equal(r.invoices[0].result?.state, "held"); assert.equal(f.db.rows[0].state, "unknown");
}));
test("bounded action authority holds entire over-limit cohort without silently selecting first invoice", () => clock(async tick => {
  const f = fixture(tick); f.addOwner(); (f.p as any).maximumAdmissionsPerRun = 1;
  const r = await f.run().run(); assert.deepEqual(r.reasons, ["current_cohort_exceeds_action_limit_no_subset_selected"]);
  assert.equal(r.admissionAttempts, 0); assert.equal(f.state.posts, 0);
}));
test("09:15 missed window never catches up", () => clock(async tick => {
  const f = fixture(tick); tick(900000); const r = await f.run().run(); assert.equal(r.messageAttempts, 0); assert.equal(f.state.sourceReads, 0); assert.equal(f.state.bootstrap, 0);
}));
test("missing category tags do not block approved common Day10", () => clock(async tick => {
  const f = fixture(tick); delete f.data.contacts[0].tags; const r = await f.run().run(); assert.equal(r.messageAttempts, 1, JSON.stringify(r));
}));
test("standing policy derives fresh next-day scope without daily approval, while old source cannot renew", () => clock(async tick => {
  const f = fixture(tick), policy = installRecurringDay10Policy(f.p); await f.run("read-only", policy).run();
  const oldScope = f.scopes[0]; tick(86400000);
  f.data.invoices = [{ ...f.invoice(`next-day-${++sequence}`), dueDate: "2026-11-01" }];
  const r = await f.run("read-only", policy).run(); assert.equal(r.invoices[0].result?.phase, "read_only", JSON.stringify(r));
  assert.notEqual(f.scopes[1].identityCoveragePolicy.reviewedAt, oldScope.identityCoveragePolicy.reviewedAt);
  assert.equal(f.counts.contacts, 2); assert.equal(f.counts.customers, 2);
  const inv = await readNotificationInventory(f.scopes[1], f.inventoryIO), batch = await readNotificationSourceBatch(f.scopes[1].identityCoveragePolicy, f.sourceIO);
  const handle = await readDiscoveredNotificationSource(inv, batch, f.data.invoices[0].id);
  const before = inspectNotificationSource(handle); tick(1000); const fresh = inspectNotificationSource(await refreshNotificationSource(handle));
  assert.equal(fresh.identityExpiresAt, before.identityExpiresAt); assert.equal(fresh.identitySourceRef, before.identitySourceRef);
  assert.ok(Date.parse(fresh.observedAt) > Date.parse(before.observedAt));
  assert.throws(() => inspectRecurringNotificationSource(structuredClone(handle)));
  tick(300000); await assert.rejects(refreshNotificationSource(handle));
}));
test("unimplemented Day20 for same contact does not block an independent approved Day10 event", () => clock(async tick => {
  const f = fixture(tick); f.data.contacts[0].tags = [];
  f.data.invoices.push({ ...f.invoice(`later-${++sequence}`), issuedDate: "2026-10-01", dueDate: "2026-10-21" });
  const r = await f.run().run(); assert.equal(r.messageAttempts, 1, JSON.stringify(r)); assert.equal(f.db.rows[0].dayPastDue, 10);
}));
test("deferred source work drains after deadline instead of releasing an admitted caller", () => clock(async tick => {
  const f = fixture(tick); (f.p as any).validUntil = new Date(NOW+100).toISOString();
  let release!: () => void, settled = false;
  const original = f.runtime.sourceIO.customers;
  (f.runtime.sourceIO as any).customers = async () => { await new Promise<void>(resolve => { release = resolve; }); return original(); };
  const running = f.run().run().then(r => { settled = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(settled, false);
  tick(100); release(); const r = await running; assert.equal(r.state, "held"); assert.equal(r.admissionAttempts, 0); assert.equal(f.state.posts, 0);
}));
test("actual one-attempt transport timeout aborts, persists unknown, stops remaining candidates, no retry", () => clock(async tick => {
  const f = fixture(tick); f.addOwner(); const original = f.runtime.fetch, timer = globalThis.setTimeout; let aborted = false;
  (f.runtime as any).fetch = (url: any, init: any) => {
    if (init?.method !== "POST") return original(url, init);
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(Error("synthetic timeout")); }, { once: true }));
  };
  globalThis.setTimeout = ((callback: any, ms: any, ...args: any[]) => timer(callback, ms === 5000 ? 5 : ms, ...args)) as typeof setTimeout;
  try {
    const r = await f.run().run(); assert.equal(r.state, "unknown", JSON.stringify(r)); assert.equal(aborted, true);
    assert.equal(r.messageAttempts, 1); assert.equal(f.db.rows[0].state, "unknown"); assert.equal(f.db.rows.length, 1);
    assert.equal(r.invoices.filter(row => row.holds.includes("day10_not_evaluated_before_batch_stopped_no_retry")).length, 1);
  } finally { globalThis.setTimeout = timer; }
}));
test("concrete cron deployment runtime pins service/holds, uses no-refresh auth and exact ledger/HTTP allowlist", () => {
  const script = `
    const { default: assert } = await import('node:assert/strict');
    Object.assign(process.env, { RAILWAY_SERVICE_ID:'ee3a4c67-8b0c-48d2-871d-e20bed336c4a', RAILWAY_ENVIRONMENT_ID:'bc72bc2d-9a4c-494d-8bee-9ca782db1240',
      RAILWAY_PROJECT_ID:'5d7858db-0443-4891-8a95-1eb1261d3e61', RAILWAY_DEPLOYMENT_ID:'synthetic', DATABASE_URL:'synthetic', GHL_API_KEY:'synthetic',
      GHL_LOCATION_ID:'location', GHL_INVOICE_WRITE_MODE:'review', GHL_PHONE_WRITES_ENABLED:'false', SYNC_ADMISSION_MODE:'cron_only', GHL_NOTIFICATIONS_ENABLED:'false' });
    let authReads = 0, expiry = new Date(Date.now()+910000); const sql = [], calls = [], limits = [];
    const tx = { $executeRawUnsafe:async s=>sql.push(s), $queryRawUnsafe:async s=>{sql.push(s);return [];},
      jobberAuth:{findFirst:async()=>{authReads++; return {accessToken:'synthetic',expiresAt:expiry};}} };
    globalThis.prisma = { $transaction:async (fn,options)=>{limits.push(options);return fn(tx);}, customer:{findMany:async()=>[]},invoiceRecord:{findMany:async()=>[]} };
    Object.assign(tx,{customer:globalThis.prisma.customer,invoiceRecord:globalThis.prisma.invoiceRecord});
    globalThis.fetch = async (url, init) => {calls.push([String(url),init.method]);return new Response('{}');};
    const m=await import('./lib/notification-recurring-runtime.ts'), mod=m.default??m;
    const scope={version:1,accountId:'account',locationId:'location',reviewRef:'synthetic',expiresAt:new Date(Date.now()+600000).toISOString(),identityCoveragePolicy:{accountId:'account'}};
    const read=await mod.bootstrapRecurringDay10Runtime(scope,'read-only');
    assert.equal(authReads,1); assert.equal(calls.length,0);
    await read.sourceIO.customers(); await read.sourceIO.customer('owner');
    await read.sourceIO.storedInvoices('owner'); await read.sourceIO.quarantineCounts(['a','b']);
    assert.ok(limits.slice(-4).every(x=>x.maxWait===1000 && x.timeout===5000));
    assert.equal(sql.filter(s=>s==="SET LOCAL statement_timeout = '2500ms'").length,4);
    await assert.rejects(read.database.transaction(tx=>tx.query('/* notification-ledger:reserve */ INSERT INTO fake VALUES (1)',[])));
    await assert.rejects(Promise.resolve().then(()=>read.fetch('https://services.leadconnectorhq.com/conversations/messages',{method:'POST',redirect:'error'})));
    const attempt=await mod.bootstrapRecurringDay10Runtime(scope,'attempt');
    await attempt.database.transaction(tx=>tx.query('/* notification-ledger:reserve */ INSERT INTO fake VALUES (1)',[]));
    await assert.rejects(attempt.database.transaction(tx=>tx.query('DELETE FROM fake',[])));
    await attempt.fetch('https://services.leadconnectorhq.com/conversations/messages',{method:'POST',redirect:'error'});
    assert.deepEqual(calls,[['https://services.leadconnectorhq.com/conversations/messages','POST']]);
    await assert.rejects(Promise.resolve().then(()=>attempt.fetch('https://other.example.test/messages',{method:'POST',redirect:'error'})));
    process.env.RAILWAY_SERVICE_ID='ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f';
    await assert.rejects(mod.bootstrapRecurringDay10Runtime(scope,'attempt'));
    process.env.RAILWAY_SERVICE_ID='ee3a4c67-8b0c-48d2-871d-e20bed336c4a';
    expiry=new Date(Date.now()+899000); await assert.rejects(mod.bootstrapRecurringDay10Runtime(scope,'attempt'),/INSUFFICIENT/);
    process.env.GHL_NOTIFICATIONS_ENABLED='true'; await assert.rejects(mod.bootstrapRecurringDay10Runtime(scope,'attempt'));
  `;
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
  assert.equal(r.status, 0, r.stderr);
});
