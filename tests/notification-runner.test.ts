import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createNotificationRunner, notificationRunnerReadiness, type NotificationRunnerDependencies } from "../lib/notification-runner";
import { eventKey, type Event } from "../lib/notification-gate";
import { type NotificationLedgerDatabase, type NotificationLedgerTransaction } from "../lib/notification-ledger";
import { type NotificationSourceIO, type NotificationSourceRequest } from "../lib/notification-source";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const START = Date.parse("2026-11-09T16:05:00.000Z"), BODY = "SYNTHETIC TEST ONLY: Invoice balance reminder.";
let sequence = 0;
async function clocked(run: (tick: (ms?: number) => void) => Promise<void>) {
  const real = Date.now; let clock = START; Date.now = () => clock;
  try { await run((ms = 1) => { clock += ms; }); } finally { Date.now = real; }
}
const response = (body: unknown, status = 200) => ({ status, body: new ReadableStream<Uint8Array>({ start(c) {
  c.enqueue(new TextEncoder().encode(JSON.stringify(body))); c.close();
} }) });
type Row = Record<string, any>;
class Database implements NotificationLedgerDatabase {
  rows = new Map<string, Row>();
  operations: string[] = [];
  fault: { operation: string; phase: "before" | "after" } | null = null;
  hook: ((operation: string) => void) | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    const draft = new Map([...this.rows].map(([id, r]) => [id, { ...r }]));
    let operation = "";
    const result = await work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      operation = /notification-(?:ledger|runner):(\w+)/.exec(sql)![1]; this.operations.push(operation);
      if (operation === "history") {
        assert.match(sql, /WHERE "accountId" = \$1 AND "eventKey" = \$2 LIMIT 1001/);
        return [...draft.values()].filter(r => r.accountId === v[0] && r.eventKey === v[1]).map(r => ({ ...r })) as R[];
      }
      if (operation === "reserve") {
        if ([...draft.values()].some(r => r.eventKey === v[2] ||
          (r.accountId === v[3] && r.contactId === v[7] && r.scheduledOn === v[8]))) return [];
        const row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], contactId: v[7], scheduledOn: v[8],
          eventHash: v[13], bodyHash: v[14], destinationHash: v[15], state: "reserved" } as Row;
        draft.set(row.id, row); return [{ id: row.id }] as unknown as R[];
      }
      const row = draft.get(v[0] as string);
      if (!row || row.reservationToken !== v[1] || row.eventHash !== v[2] || row.bodyHash !== v[3] || row.destinationHash !== v[4] ||
        row.state !== (operation === "outcome" ? "pending" : "reserved")) return [];
      if (operation === "pending") row.state = "pending";
      if (operation === "outcome") { row.state = v[5]; row.providerMessageId = v[6]; }
      return [{ id: row.id }] as unknown as R[];
    } });
    const fault = (phase: "before" | "after") => {
      if (this.fault?.operation === operation && this.fault.phase === phase) { this.fault = null; throw new Error("secret must not escape"); }
    };
    fault("before"); this.rows = draft; this.hook?.(operation); fault("after"); return result;
  }
}
function fixture(tick: (ms?: number) => void, channel: "sms" | "email" = "sms") {
  const invoiceId = `synthetic-invoice-${++sequence}`, db = new Database(), log: string[] = [];
  const owner = { jobberClientId: "synthetic-owner", email: "synthetic@example.invalid", phone: "+12025550123" };
  const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }];
  const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
  const data = { invoice: { id: invoiceId, invoiceNumber: "1234", client: { id: owner.jobberClientId }, invoiceStatus: "past_due",
    amounts: { total: 137, invoiceBalance: 137 }, issuedDate: "2026-10-20", dueDate: "2026-10-30" },
    dnd: false, channelDnd: "inactive" as string | undefined, extraInvoice: false, wrongOwner: false,
    stale: false, incompleteHistory: false, externalPrior: false, missingCurrency: false, badReview: false,
    postStatus: 200, postThrow: false, calls: 0, externalCalls: 0, postCalls: 0, event: null as Event | null };
  const sourceRequest: NotificationSourceRequest = { version: 1, reviewRef: "synthetic-review", expiresAt: new Date(START + 300_000).toISOString(),
    scope: { locationId: "synthetic-location", jobberClientId: owner.jobberClientId, contactId: "synthetic-contact", invoiceId },
    originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-20", dueDate: "2026-10-30" }, identityCoveragePolicy: {
      accountId: "synthetic-account", reviewRef: "synthetic-coverage", reviewedAt: new Date(START - 1000).toISOString(),
      expiresAt: new Date(START + 300_000).toISOString(), quarantine: [quarantine[0], quarantine[1]] } };
  const sourceIO: NotificationSourceIO = {
    locationId: () => "synthetic-location", customers: async () => { tick(); return [owner, ...quarantine]; },
    contacts: async () => { tick(); return [{ id: "synthetic-contact", locationId: "synthetic-location", email: owner.email, phone: owner.phone }]; },
    storedInvoices: async () => [{ jobberInvoiceId: invoiceId }],
    quarantineCounts: async () => quarantine.map(q => ({ jobberClientId: q.jobberClientId, jobs: 0, invoices: 0 })),
    query: async <T = any>(q: string): Promise<T> => {
      tick(); let result: unknown;
      if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: "synthetic-account" }, clients: {
        nodes: q.includes("isArchived: false") ? [fresh] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
      else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "synthetic-account" }, client: null };
      else if (q.includes("VerifyDateOwnerInvoices")) {
        data.calls++; log.push(`source:${data.calls}`);
        result = { account: { id: "synthetic-account" }, client: { id: owner.jobberClientId, invoices: {
          nodes: [data.invoice, ...(data.extraInvoice ? [{ ...data.invoice, id: "synthetic-other-invoice" }] : [])],
          pageInfo: { hasNextPage: false, endCursor: null } } } };
      } else result = { account: { id: "synthetic-account" }, client: fresh,
        invoice: { id: invoiceId, client: { id: data.wrongOwner ? "other" : owner.jobberClientId } } };
      return structuredClone(result) as T;
    },
  };
  const sender = { accountId: "synthetic-account", locationId: "synthetic-location", channel,
    sender: channel === "sms" ? "+12025550124" : "billing@example.invalid", scope: "conversations/message.write",
    approved: true, validated: true, evidenceRef: "synthetic-sender" } as const;
  const config = { credential: "synthetic-fake-token", accountId: "synthetic-account", locationId: "synthetic-location" };
  const deps: NotificationRunnerDependencies = { sourceRequest, sourceIO, database: db,
    contact: { ...config, scopes: ["contacts.readonly"], fetch: async (_url, init) => {
      tick(); log.push("contact"); assert.equal(init.method, "GET");
      return response({ contact: { id: "synthetic-contact", locationId: config.locationId, phone: owner.phone, email: owner.email,
        dnd: data.dnd, dndSettings: { [channel === "sms" ? "SMS" : "Email"]: { status: data.channelDnd } } } });
    } },
    transport: { ...config, scopes: ["conversations/message.write"], fetch: async (_url, init) => {
      log.push("post"); data.postCalls++; assert.equal(init.method, "POST"); assert.equal(db.rows.size, 1);
      assert.equal([...db.rows.values()][0].state, "pending"); assert.equal(data.calls, 3);
      assert.equal(db.operations.filter(op => op === "pending").length, 1);
      if (data.postThrow) throw new Error("synthetic-credential must not escape");
      return response({ messageId: "synthetic-message", conversationId: "synthetic-conversation" }, data.postStatus);
    } },
    prepare: async s => {
      log.push("prepare");
      const event: Event = { accountId: s.accountId, invoiceId: s.invoiceId, ownerId: s.ownerId, homeownerContactId: s.homeownerContactId,
        sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision, issuedDate: s.issuedDate, dueDate: s.dueDate,
        balanceMinor: s.balanceMinor, currency: "USD", category: null, dayPastDue: 10, audience: "homeowner", recipientId: s.homeownerContactId,
        contactId: s.homeownerContactId, channel, destination: channel === "sms" ? owner.phone : owner.email,
        templateId: "synthetic-template", templateVersion: "1", bodyDigest: hash(BODY), claimedFacts: [] };
      data.event = event;
      return { event, body: BODY, contentType: "text/plain", ...(channel === "email" ? { subject: "Synthetic reminder" } : {}), sender,
        constructionReview: { mode: "reviewed-construction-only", version: "2021-07-28", proposedStatus: "pending", evidenceRef: "synthetic-assumption",
          accountId: event.accountId, locationId: config.locationId, channel } };
    },
    readExternal: async (s, e) => {
      tick(); data.externalCalls++; log.push(`external:${data.externalCalls}`);
      const p = { observedAt: new Date(Date.now() - (data.stale ? 65_000 : 0)).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(), sourceRef: "synthetic-independent-reader" };
      return { metadata: { ...p, accountId: e.accountId, invoiceId: e.invoiceId, sourceRevision: s.sourceRevision,
        currency: data.missingCurrency ? "" : "USD", category: null, categoryVerified: false },
        recipient: { ...p, accountId: e.accountId, recipientId: e.recipientId, contactId: e.contactId, audience: e.audience, channel,
          destination: e.destination, destinationVerified: true, exactSourceIdentity: true, internalRecipientApproved: false },
        template: { ...p, approved: true, accountId: e.accountId, id: e.templateId, version: e.templateVersion, bodyDigest: e.bodyDigest,
          audience: e.audience, dayPastDue: e.dayPastDue, channel, claimedFacts: [] },
        channelAuthorization: { ...p, approved: true, eventKey: eventKey(e), recipientId: e.recipientId, channel, destination: e.destination },
        facts: [], attempts: { ...p, accountId: e.accountId, historyComplete: !data.incompleteHistory,
          records: data.externalPrior ? [{ eventKey: eventKey(e), state: "reserved" as const }] : [] } };
    },
    review: async (construction, event, binding) => {
      log.push("review"); const requestSha256 = hash(construction.request!.serializedBody);
      return { mode: "reviewed-one-attempt", event, binding, sender, reviewedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        statusSemantics: { verified: true, version: "2021-07-28", status: "pending", evidenceRef: "synthetic-only-semantics" },
        content: { approved: true, requestSha256, evidenceRef: "synthetic-content" },
        authorization: { approved: true, timingApproved: true, requestSha256: data.badReview ? "wrong" : requestSha256,
          evidenceRef: "synthetic-authorization" } };
    },
  };
  const runner = () => createNotificationRunner({ mode: "reviewed-one-event-candidate", dependencies: deps });
  return { deps, db, data, log, runner };
}

test("default disabled path is an exact no-op even with environment enable flags and hostile dependencies", async () => {
  const previous = process.env.GHL_NOTIFICATIONS_ENABLED; process.env.GHL_NOTIFICATIONS_ENABLED = "true";
  try {
    const r = createNotificationRunner({ get dependencies(): NotificationRunnerDependencies { throw new Error("must not inspect"); } });
    assert.deepEqual(await r.runOne(), await createNotificationRunner().runOne());
    assert.equal((await r.runOne()).state, "disabled"); assert.equal(notificationRunnerReadiness().productionCallsite, false);
  } finally { if (previous === undefined) delete process.env.GHL_NOTIFICATIONS_ENABLED; else process.env.GHL_NOTIFICATIONS_ENABLED = previous; }
});
for (const channel of ["sms", "email"] as const) test(`${channel}: real adapters join three source reads and one acknowledged pending/send`, () => clocked(async tick => {
  const f = fixture(tick, channel), r = f.runner(), out = await r.runOne();
  assert.equal(out.state, "accepted", JSON.stringify(out)); assert.equal(out.reservationCreated, true); assert.equal(out.attempted, true);
  assert.equal(out.productionSendCapability, false); assert.equal(out.retryAllowed, false); assert.equal(out.transport!.deliveryConfirmed, false);
  assert.deepEqual(f.db.operations, ["history", "history", "reserve", "assert", "history", "assert", "pending", "outcome"]);
  assert.deepEqual(f.log, ["source:1", "prepare", "external:1", "contact", "source:2", "external:2", "contact", "review",
    "source:3", "external:3", "contact", "post"]);
  assert.equal(f.data.externalCalls, 3); assert.equal((await r.runOne()).state, "held"); assert.equal(f.data.postCalls, 1);
}));
for (const kind of ["paid", "unknown category", "missing currency", "stale", "history incomplete", "prior external", "dnd", "missing channel", "bad approval", "extra invoice", "wrong owner"])
  test(`preflight ${kind} makes no database writes and no POST`, () => clocked(async tick => {
    const f = fixture(tick);
    if (kind === "paid") { f.data.invoice.invoiceStatus = "paid"; f.data.invoice.amounts.invoiceBalance = 0; }
    if (kind === "missing currency") f.data.missingCurrency = true;
    if (kind === "stale") f.data.stale = true;
    if (kind === "history incomplete") f.data.incompleteHistory = true;
    if (kind === "prior external") f.data.externalPrior = true;
    if (kind === "dnd") f.data.dnd = true;
    if (kind === "missing channel") f.data.channelDnd = undefined;
    if (kind === "bad approval") f.data.badReview = true;
    if (kind === "extra invoice") f.data.extraInvoice = true;
    if (kind === "wrong owner") f.data.wrongOwner = true;
    if (kind === "unknown category") { const p = f.deps.prepare; (f.deps as any).prepare = async (s: any, handle: any) => {
      const value = await p(s, handle); return { ...value, event: { ...value.event, dayPastDue: 20, claimedFacts: ["recurring_late_fee_policy"] } };
    }; }
    const out = await f.runner().runOne(); assert.equal(out.state, "held", JSON.stringify(out));
    assert.equal(f.db.rows.size, 0); assert.ok(f.db.operations.every(op => op === "history")); assert.equal(f.data.postCalls, 0);
  }));
for (const kind of ["paid", "partial payment", "owner", "extra invoice", "dnd", "missing channel", "external prior", "expired", "token", "eventHash", "bodyHash", "destinationHash", "pending", "missing reservation"])
  test(`final ${kind} burns reservation and cannot send`, () => clocked(async tick => {
    const f = fixture(tick); f.db.hook = operation => {
      if (operation !== "reserve") return;
      if (kind === "paid") { f.data.invoice.invoiceStatus = "paid"; f.data.invoice.amounts.invoiceBalance = 0; }
      if (kind === "partial payment") f.data.invoice.amounts.invoiceBalance = 100;
      if (kind === "owner") f.data.wrongOwner = true;
      if (kind === "extra invoice") f.data.extraInvoice = true;
      if (kind === "dnd") f.data.dnd = true;
      if (kind === "missing channel") f.data.channelDnd = undefined;
      if (kind === "external prior") f.data.externalPrior = true;
      if (kind === "expired") tick(61_000);
      const row = [...f.db.rows.values()][0];
      if (kind === "token") row.reservationToken = "foreign";
      if (["eventHash", "bodyHash", "destinationHash"].includes(kind)) row[kind] = "foreign";
      if (kind === "pending") row.state = "pending";
      if (kind === "missing reservation") f.db.rows.clear();
    };
    const r = f.runner(), out = await r.runOne(); assert.notEqual(out.state, "accepted", JSON.stringify(out));
    assert.equal(out.reservationCreated, true); assert.equal(f.data.postCalls, 0);
    assert.equal(f.db.operations.filter(op => op === "pending").length, 0);
    assert.equal((await r.runOne()).state, "held"); assert.equal(f.db.operations.filter(op => op === "reserve").length, 1);
  }));
for (const operation of ["reserve", "pending", "outcome"]) for (const phase of ["before", "after"] as const)
  test(`${operation} ${phase} commit failure has no automatic retry`, () => clocked(async tick => {
    const f = fixture(tick); f.db.fault = { operation, phase }; const r = f.runner(), out = await r.runOne();
    assert.equal(out.state, "unknown", JSON.stringify(out)); assert.equal(f.data.postCalls, operation === "outcome" ? 1 : 0);
    assert.equal(f.db.operations.filter(op => op === operation).length, 1); await r.runOne();
    assert.equal(f.db.operations.filter(op => op === operation).length, 1); assert.doesNotMatch(JSON.stringify(out), /secret|synthetic-fake-token/);
  }));
for (const status of [429, 500]) test(`provider ${status} consumes one attempt`, () => clocked(async tick => {
  const f = fixture(tick); f.data.postStatus = status; const out = await f.runner().runOne();
  assert.equal(out.state, "unknown"); assert.equal(f.data.postCalls, 1); assert.equal([...f.db.rows.values()][0].state, "unknown");
}));
test("concurrent calls on one runner consume the operation before any IO", () => clocked(async tick => {
  const f = fixture(tick), r = f.runner(), results = await Promise.all([r.runOne(), r.runOne()]);
  assert.deepEqual(results.map(r => r.state).sort(), ["accepted", "held"]); assert.equal(f.data.postCalls, 1);
}));
test("second runner cannot repeat the durable logical event", () => clocked(async tick => {
  const f = fixture(tick); assert.equal((await f.runner().runOne()).state, "accepted");
  assert.equal((await f.runner().runOne()).state, "held"); assert.equal(f.data.postCalls, 1);
  assert.equal(f.db.operations.filter(op => op === "reserve").length, 1);
}));
test("constant time is not rewritten or relaxed to manufacture newer evidence", () => clocked(async () => {
  const f = fixture(() => {}); const out = await f.runner().runOne(); assert.equal(out.state, "held");
  assert.ok(out.reasons.includes("final:source_not_newer_than_preflight")); assert.equal(f.db.rows.size, 0); assert.equal(f.data.postCalls, 0);
}));
test("expiry while reviewing holds before reserve; expiry in pending holds before POST", () => clocked(async tick => {
  const first = fixture(tick), review = first.deps.review;
  (first.deps as any).review = async (...args: Parameters<typeof review>) => { tick(61_000); return review(...args); };
  assert.equal((await first.runner().runOne()).state, "held"); assert.equal(first.db.rows.size, 0);
  const second = fixture(tick); second.db.hook = op => { if (op === "pending") tick(31_000); };
  const out = await second.runner().runOne(); assert.equal(out.state, "held", JSON.stringify(out));
  assert.equal(second.data.postCalls, 0); assert.equal([...second.db.rows.values()][0].state, "unknown");
}));
test("readiness CLI is inert even with a send flag; runner imports no production credentials/client", () => {
  const cli = spawnSync(process.execPath, ["--import", "tsx", "scripts/notification-runner-readiness.ts", "--send", "true"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GHL_NOTIFICATIONS_ENABLED: "true", DATABASE_URL: "invalid://never-connect" } });
  assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), notificationRunnerReadiness());
  const source = readFileSync("lib/notification-runner.ts", "utf8");
  assert.doesNotMatch(source, /from ["']\.\/prisma|from ["']\.\/jobber|from ["']\.\/ghl["']|process\.env|ledger\.markPending|ledger\.markOutcome/);
});

for (const name of ["recipient", "attempts"] as const) for (const kind of ["future", "missing source", "invalid timestamp"])
  test(`${name} ${kind} cannot be laundered by combining proof`, () => clocked(async tick => {
    const f = fixture(tick), read = f.deps.readExternal;
    (f.deps as any).readExternal = async (...args: Parameters<typeof read>) => {
      const x = structuredClone(await read(...args)) as any;
      if (kind === "future") x[name].observedAt = new Date(Date.now() + 10_000).toISOString();
      if (kind === "missing source") x[name].sourceRef = "";
      if (kind === "invalid timestamp") x[name].observedAt = "2026-11-09 16:05:00";
      return x;
    };
    assert.equal((await f.runner().runOne()).state, "held"); assert.equal(f.db.rows.size, 0); assert.equal(f.data.postCalls, 0);
  }));
test("new runner cannot retry an unacknowledged reservation even when no row committed", () => clocked(async tick => {
  const f = fixture(tick); f.db.fault = { operation: "reserve", phase: "before" };
  assert.equal((await f.runner().runOne()).state, "unknown"); assert.equal(f.db.rows.size, 0);
  const result = await f.runner().runOne(); assert.equal(result.state, "held");
  assert.ok(result.reasons.includes("logical_event_admission_already_attempted_no_retry"));
  assert.equal(f.db.operations.filter(op => op === "reserve").length, 1); assert.equal(f.data.postCalls, 0);
}));

test("disabled import/run/readiness never initializes the transitive ambient Prisma singleton", () => {
  const script = `
    let touched = false;
    Object.defineProperty(globalThis, "prisma", { get() { touched = true; throw new Error("ambient-client-touched"); } });
    import("./lib/notification-runner.ts").then(async module => {
      const runner = module.createNotificationRunner ? module : module.default;
      const result = await runner.createNotificationRunner().runOne();
      console.log(JSON.stringify({ touched, state: result.state, ready: runner.notificationRunnerReadiness().productionCallsite }));
    }).catch(() => { console.log(JSON.stringify({ touched, failed: true })); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, GHL_NOTIFICATIONS_ENABLED: "true", DATABASE_URL: "invalid://never-connect" } });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), { touched: false, state: "disabled", ready: false });
});
