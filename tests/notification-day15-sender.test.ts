/**
 * Day 15 fee-free sender. Everything here is synthetic: a disposable in-memory
 * database, a fake Jobber source, a fake GHL and a fake sender. No real credential,
 * no real contact, no network. The POST boundary is a function in this file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectDay15SenderReadiness, reviewDay15SenderConfiguration, createDay15Sender,
  summarizeDay15SenderExecution, renderDay15SenderBody,
  type Day15SenderConfig, type Day15SenderRuntime } from "../lib/notification-day15-sender";
import { bodyMakesNoFeeClaim } from "../lib/notification-day15-pilot";
import { planNotification, type Event, type Evidence } from "../lib/notification-gate";
import type { NotificationLedgerDatabase, NotificationLedgerTransaction } from "../lib/notification-ledger";

const START = Date.parse("2026-11-09T16:05:00.000Z"); // 09:05 America/Phoenix, inside the window
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const HUB = "https://clienthub.getjobber.com/client_hubs/460ccf18-5d0b-4fee-b2f9-59998b09cdc1/invoices/synthetic-hub-id";
const BODY = "SYNTHETIC ONLY: your invoice is unpaid. Balance {{balance}}. View and pay: {{invoiceLink}}";
let sequence = 0;

async function clocked(run: (tick: (ms?: number) => void) => Promise<void>) {
  const old = Date.now; let ms = START; Date.now = () => ms;
  try { await run((delta = 1) => { ms += delta; }); } finally { Date.now = old; }
}

function config(): Day15SenderConfig {
  const invoiceId = `synthetic-day15-${++sequence}`;
  return {
    version: 1, kind: "day15-homeowner-sms-fee-free-pilot", reviewRef: "synthetic-operator-review",
    reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 120_000).toISOString(),
    source: { version: 1, reviewRef: "synthetic-source", expiresAt: new Date(START + 300_000).toISOString(),
      scope: { locationId: "synthetic-location", jobberClientId: "synthetic-owner", contactId: "synthetic-contact", invoiceId },
      // due 2026-10-25 + 15 days = 2026-11-09, the clocked "today"
      originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-20", dueDate: "2026-10-25" },
      identityCoveragePolicy: { accountId: "synthetic-account", reviewRef: "synthetic-coverage",
        reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 300_000).toISOString(),
        quarantine: [{ jobberClientId: "missing-a", email: null, phone: null },
          { jobberClientId: "missing-b", email: null, phone: null }] } },
    destination: "+12025550123",
    scope: { scheduledOn: "2026-11-09", dayPastDue: 15, audience: "homeowner", channel: "sms", maximumAttempts: 1,
      history: "accessible-ghl-plus-local-ledger", timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)",
      authorizationRef: "synthetic-finite-attempt", timingRef: "synthetic-timing", credentialBindingRef: "synthetic-scope-review" },
    currencyPolicy: { accountId: "synthetic-account", invoiceId, currency: "USD", minorUnitExponent: 2,
      evidenceRef: "synthetic-currency-policy" },
    consent: { source: "signed-agreement", contactId: "synthetic-contact", scope: "billing-sms",
      recordedAt: new Date(START - 86_400_000).toISOString(), evidenceRef: "synthetic-consent-record" },
    invoiceLink: { source: "jobber-invoice-client-hub-uri", invoiceId, url: HUB, evidenceRef: "synthetic-link-evidence" },
    sender: { number: "+12025550124", approvalRef: "synthetic-sender-approval", writeScopeEvidenceRef: "synthetic-write-scope" },
    template: { id: "synthetic-day15", version: "1", body: BODY, policy: "day15-no-fee-claim",
      approvalRef: "synthetic-render-policy" },
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", semanticsRef: "synthetic-native-observation",
      footer: { mode: "exact-native-suffix", suffix: "\nReply STOP to unsubscribe.\nThanks, Synthetic Company",
        evidenceRef: "synthetic-exact-footer" } },
  };
}

class Database implements NotificationLedgerDatabase {
  rows: Record<string, any>[] = []; operations: string[] = [];
  hook: ((operation: string) => void) | null = null;
  fail: string | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    let operation = "";
    const value = await work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      operation = /notification-(ledger|runner|history):([\w-]+)/.exec(sql)!.slice(1).join(":");
      this.operations.push(operation);
      if (this.fail === operation) throw new Error("secret database failure");
      if (operation === "history:read-only")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.contactId === v[1])) as R[];
      if (operation === "runner:history")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.eventKey === v[1])) as R[];
      if (operation === "ledger:reserve") {
        // Both production unique indexes: one per logical event, one per contact per day.
        if (this.rows.some(r => r.eventKey === v[2] ||
          (r.accountId === v[3] && r.contactId === v[7] && r.scheduledOn === v[8]))) return [];
        const row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], invoiceId: v[4],
          dayPastDue: v[5], audience: v[6], contactId: v[7], scheduledOn: v[8], channel: v[9],
          eventPayload: JSON.parse(v[10] as string), body: v[11], eventHash: v[13], bodyHash: v[14],
          destinationHash: v[15], state: "reserved", providerMessageId: null };
        this.rows.push(row); return [{ id: row.id }] as unknown as R[];
      }
      const row = this.rows.find(r => r.id === v[0]);
      if (!row || row.reservationToken !== v[1] || row.eventHash !== v[2] || row.bodyHash !== v[3] ||
          row.destinationHash !== v[4] || row.state !== (operation === "ledger:outcome" ? "pending" : "reserved")) return [];
      if (operation === "ledger:pending") row.state = "pending";
      if (operation === "ledger:outcome") { row.state = v[5]; row.providerMessageId = v[6]; }
      return [{ id: row.id }] as unknown as R[];
    } });
    this.hook?.(operation); return value;
  }
}

function fixture(tick: (ms?: number) => void, c = config()) {
  const db = new Database(), calls: { url: string; method: string; body?: string }[] = [];
  const data = {
    dnd: "inactive" as string | undefined, globalDnd: false, senderSms: true,
    historyOutbound: false, historyTotal: 0, historyFail: false,
    paid: false, amount: 137, link: HUB, linkThrow: false,
    sourceReads: 0, bootstrap: 0, holds: true, postStatus: 201, postThrow: false,
    senderCalls: 0, posts: 0, linkReads: 0, destination: c.destination,
  };
  const owner = { jobberClientId: "synthetic-owner", email: "synthetic@example.invalid", phone: c.destination };
  const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }],
    phones: [{ number: owner.phone, primary: true }] };
  const runtime: Day15SenderRuntime = {
    accountId: "synthetic-account", locationId: "synthetic-location", credential: "synthetic-fake-token",
    database: db, verifyActiveHolds: () => { if (!data.holds) throw new Error("holds changed"); },
    readInvoiceLink: async invoiceId => {
      data.linkReads++; assert.equal(invoiceId, c.source.scope.invoiceId);
      if (data.linkThrow) throw new Error("secret jobber failure");
      return data.link;
    },
    sourceIO: {
      locationId: () => "synthetic-location",
      customers: async () => { tick(); return [owner, ...c.source.identityCoveragePolicy.quarantine]; },
      contacts: async () => { tick(); return [{ id: "synthetic-contact", locationId: "synthetic-location",
        phone: data.destination, email: owner.email }]; },
      storedInvoices: async () => [{ jobberInvoiceId: c.source.scope.invoiceId }],
      quarantineCounts: async () => c.source.identityCoveragePolicy.quarantine.map(q =>
        ({ jobberClientId: q.jobberClientId, jobs: 0, invoices: 0 })),
      query: async <T = any>(q: string): Promise<T> => {
        tick(); let result: unknown;
        if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: "synthetic-account" },
          clients: { nodes: q.includes("isArchived: false") ? [fresh] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
        else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "synthetic-account" }, client: null };
        else if (q.includes("VerifyDateOwnerInvoices")) {
          data.sourceReads++;
          result = { account: { id: "synthetic-account" }, client: { id: owner.jobberClientId, invoices: {
            nodes: [{ id: c.source.scope.invoiceId, invoiceNumber: "7246", client: { id: owner.jobberClientId },
              invoiceStatus: data.paid ? "paid" : "past_due",
              amounts: { total: 137, invoiceBalance: data.paid ? 0 : data.amount },
              issuedDate: "2026-10-20", dueDate: "2026-10-25" }],
            pageInfo: { hasNextPage: false, endCursor: null } } } };
        } else result = { account: { id: "synthetic-account" }, client: fresh,
          invoice: { id: c.source.scope.invoiceId, client: { id: owner.jobberClientId } } };
        return structuredClone(result) as T;
      },
    },
    fetch: (async (input, init) => {
      tick(); const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
      calls.push({ url, method, body: init?.body as string | undefined });
      let body: unknown, status = 200;
      if (url.includes("/phone-system/")) {
        data.senderCalls++;
        body = { status: "success", statusCode: 200, message: "ok", data: { page: 0, pageSize: 100,
          accountStatus: "active", numbers: [{ phoneNumber: c.sender.number, capabilities: { sms: data.senderSms } }] } };
      } else if (url.includes("/contacts/")) {
        body = { contact: { id: "synthetic-contact", locationId: "synthetic-location", phone: data.destination,
          dnd: data.globalDnd, dndSettings: { SMS: { status: data.dnd } } } };
      } else if (url.includes("/conversations/search")) {
        if (data.historyFail) throw new Error("secret HTTP failure");
        body = data.historyOutbound
          ? { total: 1, conversations: [{ id: "synthetic-conversation", contactId: "synthetic-contact",
              locationId: "synthetic-location" }] }
          : { total: data.historyTotal, conversations: [] };
      } else if (url.includes("/synthetic-conversation/messages")) {
        body = { messages: { nextPage: false, lastMessageId: "synthetic-old", messages: [{ id: "synthetic-old",
          type: 2, messageType: "TYPE_SMS", direction: "outbound", status: "delivered", contactId: "synthetic-contact",
          locationId: "synthetic-location", conversationId: "synthetic-conversation",
          dateAdded: "2026-11-08T16:00:00.000Z" }] } };
      } else if (url.endsWith("/conversations/messages")) {
        // The fake sender. Reached only after exactly one reservation is pending.
        assert.equal(method, "POST");
        assert.equal(data.sourceReads, 3);
        assert.equal(db.rows.length, 1);
        assert.equal(db.rows[0].state, "pending");
        assert.equal(db.operations.filter(op => op === "ledger:pending").length, 1);
        data.posts++;
        if (data.postThrow) throw new Error("synthetic-fake-token must not escape");
        status = data.postStatus; body = { messageId: "synthetic-message", conversationId: "synthetic-conversation" };
      } else throw new Error(`unexpected URL ${url}`);
      const response = new Response(JSON.stringify(body), { status });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }) as typeof fetch,
  };
  function reviewed(action: "read-only" | "one-attempt" = "one-attempt") {
    const raw = JSON.stringify(c);
    return reviewDay15SenderConfiguration(raw, { configSha256: hash(raw), reviewRef: c.reviewRef, action });
  }
  const run = (mode: "read-only" | "reviewed-one-attempt" = "reviewed-one-attempt") => {
    const result = reviewed(mode === "read-only" ? "read-only" : "one-attempt");
    assert.ok(result.handle, JSON.stringify(result.readiness));
    return createDay15Sender({ mode, config: result.handle,
      runtime: async () => { data.bootstrap++; return runtime; } });
  };
  return { c, data, db, calls, runtime, reviewed, run };
}

// ---------------------------------------------------------------- inert by default

test("default sender is an exact no-op and never inspects config or runtime getters", async () => {
  const s = createDay15Sender({ get config(): never { throw new Error("config getter"); },
    get runtime(): never { throw new Error("runtime getter"); } });
  assert.equal((await s.run()).state, "disabled");
  assert.equal((await s.run()).state, "disabled");
});

test("the module imports no production client, credential or environment switch", () => {
  const source = readFileSync("lib/notification-day15-sender.ts", "utf8");
  assert.doesNotMatch(source, /from ["']\.\/prisma|from ["']\.\/jobber|from ["']\.\/ghl["']|process\.env/);
});

// ---------------------------------------------------------------- the fee-free copy

test("the fee-free template states no fee, before and after rendering", () => clocked(async tick => {
  const f = fixture(tick);
  assert.equal(bodyMakesNoFeeClaim(f.c.template.body), true);
  const rendered = renderDay15SenderBody(f.c, { balanceMinor: 13700 }, HUB);
  assert.equal(rendered, "SYNTHETIC ONLY: your invoice is unpaid. Balance USD 137.00. View and pay: " + HUB);
  assert.equal(bodyMakesNoFeeClaim(rendered), true);
  // Word-bounded: the synthetic client-hub UUID happens to contain the letters "4fee".
  assert.equal(/\b(late fee|late fees|3\s?%|three percent|service charge)\b/i.test(rendered), false);
}));

for (const wording of [
  "Your invoice is unpaid. A late fee of 3% may apply. Balance {{balance}}. {{invoiceLink}}",
  "Your invoice is unpaid and a 3% fee has been applied. Balance {{balance}}. {{invoiceLink}}",
  "Your invoice is unpaid. Pay now to avoid charges. Balance {{balance}}. {{invoiceLink}}",
])
  test(`fee wording is refused by configuration: ${wording.slice(30, 60)}`, () => clocked(async tick => {
    const f = fixture(tick);
    (f.c.template as any).body = wording;
    const raw = JSON.stringify(f.c);
    const r = inspectDay15SenderReadiness(raw, { configSha256: hash(raw), reviewRef: f.c.reviewRef, action: "one-attempt" });
    assert.equal(r.state, "held");
    assert.ok(r.missing.includes("template_states_no_late_fee"), JSON.stringify(r.missing));
    assert.equal(f.data.bootstrap, 0);
    assert.equal(f.calls.length, 0);
  }));

// ---------------------------------------------------------------- consent

test("missing consent holds at configuration, with no bootstrap and no IO at all", () => clocked(async tick => {
  const f = fixture(tick);
  (f.c as any).consent = null;
  const raw = JSON.stringify(f.c);
  const r = inspectDay15SenderReadiness(raw, { configSha256: hash(raw), reviewRef: f.c.reviewRef, action: "one-attempt" });
  assert.equal(r.state, "held");
  assert.ok(r.missing.includes("recorded_homeowner_consent_to_billing_sms"));
  assert.equal(reviewDay15SenderConfiguration(raw, { configSha256: hash(raw), reviewRef: f.c.reviewRef,
    action: "one-attempt" }).handle, null);
  assert.equal(f.data.bootstrap, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.operations.length, 0);
}));

for (const [name, mutate] of [
  ["wrong contact", (c: any) => { c.consent.contactId = "someone-else"; }],
  ["wrong scope", (c: any) => { c.consent.scope = "marketing-sms"; }],
  ["no-DND-record masquerading as consent", (c: any) => { c.consent.source = "no_dnd_record"; }],
  ["future consent", (c: any) => { c.consent.recordedAt = new Date(START + 86_400_000).toISOString(); }],
  ["no evidence reference", (c: any) => { c.consent.evidenceRef = ""; }],
] as const)
  test(`consent rejected: ${name}`, () => clocked(async tick => {
    const f = fixture(tick); mutate(f.c as any);
    const raw = JSON.stringify(f.c);
    const r = inspectDay15SenderReadiness(raw, { configSha256: hash(raw), reviewRef: f.c.reviewRef, action: "one-attempt" });
    assert.equal(r.state, "held");
    assert.ok(r.missing.includes("recorded_homeowner_consent_to_billing_sms"));
  }));

// ---------------------------------------------------------------- the happy path

test("one unpaid invoice produces exactly one fee-free text with the live balance and link", () => clocked(async tick => {
  const f = fixture(tick), sender = f.run(), out = await sender.run();
  assert.equal(out.state, "accepted", JSON.stringify(out));
  assert.equal(f.data.posts, 1);
  assert.equal(f.data.sourceReads, 3);          // Jobber read three times, not once
  assert.ok(f.data.linkReads >= 3);             // link re-read alongside every source read
  assert.equal(f.db.operations.filter(op => op === "ledger:pending").length, 1);
  const wire = JSON.parse(f.calls.find(c => c.method === "POST")!.body!);
  assert.equal(wire.message, "SYNTHETIC ONLY: your invoice is unpaid. Balance USD 137.00. View and pay: " + HUB);
  assert.equal(wire.toNumber, f.c.destination);
  assert.equal(wire.fromNumber, f.c.sender.number);
  assert.equal(wire.status, "pending");
  assert.equal(f.db.rows[0].eventPayload.dayPastDue, 15);
  assert.deepEqual(f.db.rows[0].eventPayload.claimedFacts, []);  // no fee fact claimed
  assert.equal(f.db.rows[0].scheduledOn, "2026-11-09");
  const summary = summarizeDay15SenderExecution(out);
  assert.equal(summary.rolloutReady, false);
  assert.equal(summary.retryAllowed, false);
  assert.doesNotMatch(JSON.stringify(out), /synthetic-fake-token/);
}));

test("read-only mode does every live check, reserves nothing and sends nothing", () => clocked(async tick => {
  const f = fixture(tick), out = await f.run("read-only").run();
  assert.equal(out.phase, "read_only", JSON.stringify(out));
  assert.equal(out.reservationCreated, false);
  assert.equal(out.attempted, false);
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows.length, 0);
  assert.ok(f.data.sourceReads >= 2);
  assert.ok(f.data.linkReads >= 2);
}));

// ---------------------------------------------------------------- no text when it must not send

test("a paid invoice sends nothing and reserves nothing", () => clocked(async tick => {
  const f = fixture(tick); f.data.paid = true;
  const out = await f.run().run();
  assert.equal(out.state, "held", JSON.stringify(out));
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows.length, 0);
  assert.ok(f.db.operations.every(op => op.endsWith("history") || op === "history:read-only"));
}));

test("payment landing AFTER the reservation still cannot send", () => clocked(async tick => {
  const f = fixture(tick);
  f.db.hook = op => { if (op === "ledger:reserve") f.data.paid = true; };
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(out.reservationCreated, true);   // the reservation is burned, not released
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.operations.filter(op => op === "ledger:pending").length, 0);
  assert.equal(f.db.rows[0].state, "reserved");
}));

test("a partial payment between reservation and send cannot send the stale amount", () => clocked(async tick => {
  const f = fixture(tick);
  f.db.hook = op => { if (op === "ledger:reserve") f.data.amount = 100; };
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(f.data.posts, 0);
}));

for (const [name, apply] of [
  ["global DND", (d: any) => { d.globalDnd = true; }],
  ["SMS DND active", (d: any) => { d.dnd = "active"; }],
  ["SMS DND permanent after STOP", (d: any) => { d.dnd = "permanent"; }],
] as const)
  test(`opt-out blocks the text: ${name}`, () => clocked(async tick => {
    const f = fixture(tick); apply(f.data);
    const out = await f.run().run();
    assert.equal(out.state, "held", JSON.stringify(out));
    assert.equal(f.data.posts, 0);
    assert.equal(f.db.rows.length, 0);
  }));

for (const [name, apply] of [
  ["global DND", (d: any) => { d.globalDnd = true; }],
  ["SMS DND active", (d: any) => { d.dnd = "active"; }],
] as const)
  test(`opt-out arriving AFTER the reservation still blocks the text: ${name}`, () => clocked(async tick => {
    const f = fixture(tick);
    f.db.hook = op => { if (op === "ledger:reserve") apply(f.data); };
    const out = await f.run().run();
    assert.notEqual(out.state, "accepted");
    assert.equal(f.data.posts, 0);
    assert.equal(f.db.operations.filter(op => op === "ledger:pending").length, 0);
  }));

test("an unresolved prior send in GHL history blocks the text", () => clocked(async tick => {
  const f = fixture(tick); f.data.historyOutbound = true;
  const out = await f.run().run();
  assert.equal(out.state, "held", JSON.stringify(out));
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows.length, 0);
}));

test("history that cannot be read at all is ambiguous and blocks the text", () => clocked(async tick => {
  const f = fixture(tick); f.data.historyFail = true;
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows.length, 0);
  assert.doesNotMatch(JSON.stringify(out), /secret|synthetic-fake-token/);
}));

test("a prior local ledger row for the same event blocks a second text", () => clocked(async tick => {
  const f = fixture(tick);
  assert.equal((await f.run().run()).state, "accepted");
  assert.equal(f.data.posts, 1);
  // A brand new sender, same reviewed invoice and day.
  const again = await f.run().run();
  assert.equal(again.state, "held", JSON.stringify(again));
  assert.equal(f.data.posts, 1);
  assert.equal(f.db.operations.filter(op => op === "ledger:reserve").length, 1);
}));

test("an invoice link that no longer matches Jobber blocks the text", () => clocked(async tick => {
  const f = fixture(tick);
  f.data.link = HUB.replace("synthetic-hub-id", "a-different-invoice");
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows.length, 0);
}));

test("an invoice link that drifts AFTER the reservation blocks the text", () => clocked(async tick => {
  const f = fixture(tick);
  f.db.hook = op => { if (op === "ledger:reserve") f.data.link = HUB.replace("synthetic-hub-id", "moved"); };
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(f.data.posts, 0);
}));

test("a Jobber link read that throws blocks the text and leaks nothing", () => clocked(async tick => {
  const f = fixture(tick); f.data.linkThrow = true;
  const out = await f.run().run();
  assert.notEqual(out.state, "accepted");
  assert.equal(f.data.posts, 0);
  assert.doesNotMatch(JSON.stringify(out), /secret|synthetic-fake-token/);
}));

// ---------------------------------------------------------------- overlap and timeout

test("two overlapping runs of one sender send exactly once", () => clocked(async tick => {
  const f = fixture(tick), sender = f.run();
  const results = await Promise.all([sender.run(), sender.run()]);
  assert.deepEqual(results.map(r => r.state).sort(), ["accepted", "held"]);
  assert.equal(f.data.posts, 1);
  assert.equal(f.db.operations.filter(op => op === "ledger:reserve").length, 1);
}));

test("two separate senders racing the same invoice send exactly once", () => clocked(async tick => {
  const c = config(), first = fixture(tick, c), second = fixture(tick, c);
  // One database, as production has one.
  (second.runtime as any).database = first.db;
  const results = await Promise.all([first.run().run(), second.run().run()]);
  assert.equal(results.filter(r => r.state === "accepted").length, 1, JSON.stringify(results));
  assert.equal(first.data.posts + second.data.posts, 1);
  assert.equal(first.db.rows.length, 1);
}));

test("a send that times out is never retried, by this sender or a new one", () => clocked(async tick => {
  const f = fixture(tick); f.data.postThrow = true;
  const sender = f.run(), out = await sender.run();
  assert.equal(out.state, "unknown", JSON.stringify(out));   // uncertain, not failed
  assert.equal(out.retryAllowed, false);
  assert.equal(f.data.posts, 1);
  // The attempt is closed as uncertain, not left open and not rewritten as failed.
  assert.equal(f.db.rows[0].state, "unknown");
  assert.equal(f.db.rows[0].providerMessageId, null);
  // Same sender.
  assert.equal((await sender.run()).state, "held");
  // A brand new sender on the same event.
  assert.equal((await f.run().run()).state, "held");
  assert.equal(f.data.posts, 1);
  assert.equal(f.db.operations.filter(op => op === "ledger:reserve").length, 1);
  assert.doesNotMatch(JSON.stringify(out), /synthetic-fake-token|must not escape/);
}));

for (const status of [429, 500]) test(`a provider ${status} consumes the one attempt and is not retried`, () => clocked(async tick => {
  const f = fixture(tick); f.data.postStatus = status;
  const out = await f.run().run();
  assert.equal(out.state, "unknown");
  assert.equal(f.data.posts, 1);
  assert.equal(f.db.rows[0].state, "unknown");
  assert.equal((await f.run().run()).state, "held");
  assert.equal(f.data.posts, 1);
}));

for (const operation of ["ledger:reserve", "ledger:pending", "ledger:outcome"])
  test(`an uncertain ${operation} commit is never retried`, () => clocked(async tick => {
    const f = fixture(tick); f.db.fail = operation;
    const out = await f.run().run();
    assert.notEqual(out.state, "accepted");
    assert.equal(f.data.posts, operation === "ledger:outcome" ? 1 : 0);
    assert.equal(f.db.operations.filter(op => op === operation).length, 1);
    await f.run().run();
    assert.equal(f.db.operations.filter(op => op === operation).length, 1);
    assert.doesNotMatch(JSON.stringify(out), /secret|synthetic-fake-token/);
  }));

// ------------------------------------------------- the gate exemption stays narrow

function evidenceFor(event: Event, feeClaimFree: boolean | undefined): Evidence {
  const p = { observedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 30_000).toISOString(),
    sourceRef: "synthetic-proof" };
  return { source: { ...p, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.sourceRevision,
      available: true, complete: true, status: "open", balanceMinor: event.balanceMinor, currency: event.currency,
      ownerId: event.ownerId, issuedDate: event.issuedDate, dueDate: event.dueDate, category: event.category,
      categoryVerified: true },
    owner: { ...p, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.ownerRevision,
      ownerId: event.ownerId, homeownerContactId: event.homeownerContactId, exactSourceIdentity: true, complete: true },
    recipient: { ...p, accountId: event.accountId, recipientId: event.recipientId, contactId: event.contactId,
      audience: event.audience, channel: event.channel, destination: event.destination, exactSourceIdentity: true,
      destinationVerified: true, internalRecipientApproved: false },
    dnd: { ...p, accountId: event.accountId, contactId: event.contactId, channel: event.channel,
      destination: event.destination, state: "allowed" },
    template: { ...p, approved: true, accountId: event.accountId, id: event.templateId, version: event.templateVersion,
      bodyDigest: event.bodyDigest, audience: event.audience, dayPastDue: event.dayPastDue, channel: event.channel,
      claimedFacts: event.claimedFacts, ...(feeClaimFree === undefined ? {} : { feeClaimFree }) },
    channelAuthorization: { ...p, approved: true, eventKey: JSON.stringify(["notification-v1", event.accountId,
      event.invoiceId, event.dayPastDue, event.audience]), recipientId: event.recipientId, channel: event.channel,
      destination: event.destination },
    facts: [], attempts: { ...p, accountId: event.accountId, historyComplete: true, records: [] } };
}
function gateEvent(over: Partial<Event> = {}): Event {
  return { accountId: "a", invoiceId: "i", dayPastDue: 15, audience: "homeowner", sourceRevision: "r",
    ownerRevision: "o", ownerId: "own", homeownerContactId: "c", issuedDate: "2026-10-20", dueDate: "2026-10-25",
    balanceMinor: 13700, currency: "USD", category: "maintenance", recipientId: "c", contactId: "c", channel: "sms",
    destination: "+12025550123", templateId: "t", templateVersion: "1", bodyDigest: hash("x"), claimedFacts: [],
    ...over } as Event;
}
const reasonsFor = (event: Event, feeClaimFree: boolean | undefined) => {
  // Two evidence reads, the final one strictly newer, as the gate requires.
  const preflight = evidenceFor(event, feeClaimFree);
  const now = Date.now();
  Date.now = () => now + 10;
  const final = evidenceFor(event, feeClaimFree);
  Date.now = () => now;
  return planNotification({ event, preflight, final }, new Date(now)).reasons;
};

test("day 15 without the fee fact and without the exemption still holds", () => clocked(async () => {
  assert.ok(reasonsFor(gateEvent(), undefined).includes("required_template_fact_missing"));
  assert.ok(reasonsFor(gateEvent(), false).includes("required_template_fact_missing"));
}));

test("day 15 with a verified fee-claim-free template no longer needs the fee fact", () => clocked(async () => {
  assert.equal(reasonsFor(gateEvent(), true).includes("required_template_fact_missing"), false);
}));

test("the exemption cannot launder a fee claim: claiming the fact still needs proof", () => clocked(async () => {
  const reasons = reasonsFor(gateEvent({ claimedFacts: ["three_percent_fee_applied"] }), true);
  assert.ok(reasons.some(r => r.includes("fact_not_proven:three_percent_fee_applied")), JSON.stringify(reasons));
}));

test("the exemption does not reach day 20, day 25 or day 30 facts", () => clocked(async () => {
  for (const dayPastDue of [20, 25]) {
    const reasons = reasonsFor(gateEvent({ dayPastDue }), true);
    assert.ok(reasons.includes("required_template_fact_missing"), `day ${dayPastDue}: ${JSON.stringify(reasons)}`);
  }
  const day30 = reasonsFor(gateEvent({ dayPastDue: 30 }), true);
  assert.ok(day30.includes("required_template_fact_missing"), JSON.stringify(day30));
}));

test("the exemption does not reach day 10, which never required the fact", () => clocked(async () => {
  assert.equal(reasonsFor(gateEvent({ dayPastDue: 10 }), undefined).includes("required_template_fact_missing"), false);
}));

test("one side asserting fee-claim-free is not enough", () => clocked(async () => {
  const event = gateEvent();
  const now = Date.now();
  const preflight = evidenceFor(event, true);
  Date.now = () => now + 10;
  const final = evidenceFor(event, undefined);
  Date.now = () => now;
  const plan = planNotification({ event, preflight, final }, new Date(now));
  assert.ok(plan.reasons.includes("required_template_fact_missing"), JSON.stringify(plan.reasons));
}));
