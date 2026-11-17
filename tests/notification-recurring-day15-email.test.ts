import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRecurringDay15EmailService, installRecurringDay15EmailPolicy,
  type RecurringDay15EmailRuntime, type RecurringDay15EmailPolicy } from "../lib/notification-recurring-day15-email";
import { readNotificationInventory, type NotificationInventoryIO } from "../lib/notification-inventory";
import { readNotificationSourceBatch, type NotificationRecurringSourceIO } from "../lib/notification-source";
import type { ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import type { NotificationLedgerDatabase, NotificationLedgerTransaction } from "../lib/notification-ledger";
import { PROPOSED_DAY15_EMAIL_BODY, PROPOSED_DAY15_EMAIL_SUBJECT,
  DAY15_EMAIL_TEMPLATE_POLICY } from "../lib/notification-day15-email-copy";

let sequence = 0;
// 2026-11-10T16:00:00Z == 09:00 America/Phoenix, inside [09:00:00,09:15:00).
const NOW = Date.parse("2026-11-10T16:00:00.000Z");
// Day 15 from this due date lands exactly on 2026-11-10.
const DUE = "2026-10-26";
const ISSUED = "2026-10-12";
const HUB = (id: string) => `https://clienthub.getjobber.com/client_hubs/11111111-2222-3333-4444-555555555555/invoices/${id}`;

async function clock(run: (tick: (ms?: number) => void) => Promise<void>) {
  const real = Date.now; let at = NOW; Date.now = () => at;
  try { await run((ms = 1) => { at += ms; }); } finally { Date.now = real; }
}

class Database implements NotificationLedgerDatabase {
  rows: Record<string, any>[] = []; operations: string[] = [];
  external: Record<string, any>[] = [];
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    return work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      const operation = /notification-(ledger|runner|history):([\w-]+)/.exec(sql)!.slice(1).join(":");
      this.operations.push(operation);
      if (operation === "history:read-only")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.contactId === v[1])) as R[];
      if (operation === "runner:history")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.eventKey === v[1])) as R[];
      if (operation === "ledger:reserve") {
        if (this.rows.some(r => r.eventKey === v[2])) return [];
        const row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], invoiceId: v[4],
          dayPastDue: v[5], audience: v[6], contactId: v[7], scheduledOn: v[8], channel: v[9],
          eventPayload: JSON.parse(v[10] as string), eventHash: v[13], bodyHash: v[14], destinationHash: v[15],
          state: "reserved", providerMessageId: null };
        this.rows.push(row); return [{ id: row.id }] as unknown as R[];
      }
      const row = this.rows.find(r => r.id === v[0]);
      if (!row) return [];
      if (operation === "ledger:pending") { row.state = "pending"; return [{ id: row.id }] as unknown as R[]; }
      if (operation === "ledger:outcome") {
        row.state = v[5] ?? "accepted"; row.providerMessageId = v[6] ?? "fake-message";
        return [{ id: row.id }] as unknown as R[];
      }
      return [{ id: row.id }] as unknown as R[];
    } });
  }
}

function fixture(tick: (ms?: number) => void) {
  const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
  const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null },
    { jobberClientId: "missing-b", email: null, phone: null }];
  const invoice = (id: string, status = "past_due", balance = 240.5) => ({ id, invoiceNumber: id, invoiceStatus: status,
    amounts: { total: 240.5, invoiceBalance: balance }, issuedDate: ISSUED, dueDate: DUE,
    client: { id: "owner" }, clientHubUri: HUB(id) });
  const data: any = {
    customers: [owner, ...quarantine],
    active: [{ id: "owner", emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] }],
    archived: [],
    contacts: [{ id: "contact", locationId: "location", email: owner.email, phone: owner.phone, tags: ["irrigation"],
      dndSettings: { SMS: { status: "inactive" }, Email: { status: "inactive" } } }],
    invoices: [invoice(`d15-${++sequence}`)], stored: [],
    counts: quarantine.map(row => ({ jobberClientId: row.jobberClientId, jobs: 0, invoices: 0 })),
    tokenRemaining: 900000, account: "account", location: "location",
    // Flips the live balance after the first owner-invoice read, to model a payment
    // landing between the initial read and the pre-send recheck.
    payAfterFirstRead: false, ownerReads: 0, linkReads: 0,
  };
  const query: any = async (q: string, vars: any = {}, options: any) => {
    tick(); assert.match(q, /^query\b/); assert.match(q, /account \{ id \}/);
    const page = (rows: any[]) => {
      const start = vars.after === null || vars.after === undefined ? 0 : Number(vars.after);
      const nodes = rows.slice(start, start + 25), end = start + nodes.length;
      return { nodes, pageInfo: { hasNextPage: end < rows.length, endCursor: nodes.length ? String(end) : null } };
    };
    let result: any;
    if (q.includes("ReadDay15EmailInvoiceClientHubLink")) {
      data.linkReads++;
      result = { invoice: data.invoices.find((row: any) => row.id === vars.invoiceId) ?? null };
    } else if (q.includes("NotificationInventoryInvoices")) result = { invoices: page(data.invoices) };
    else if (q.includes("VerifyExplicitIdentityCoverage"))
      result = { clients: page(q.includes("isArchived: false") ? data.active : data.archived) };
    else if (q.includes("VerifyQuarantinedIdentity")) result = { client: data.reappears ? { id: vars.id } : null };
    else if (q.includes("VerifyDateOwnerInvoices")) {
      data.ownerReads++;
      if (data.payAfterFirstRead && data.ownerReads > 1)
        for (const row of data.invoices) { row.amounts.invoiceBalance = 0; row.invoiceStatus = "paid"; }
      result = { client: { id: vars.id, invoices: page(data.invoices.filter((row: any) => row.client.id === vars.id)) } };
    } else result = { client: data.active.concat(data.archived).find((row: any) => row.id === vars.ownerId),
      invoice: data.invoices.find((row: any) => row.id === vars.invoiceId) ?? null };
    return structuredClone({ account: { id: data.account }, ...result });
  };
  const policy: ReviewedOmissionPolicy = { accountId: "account", reviewRef: "synthetic-standing-quarantine-policy",
    reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(),
    quarantine: [quarantine[0], quarantine[1]] };
  const sourceIO: NotificationRecurringSourceIO = { locationId: () => data.location, query,
    customers: async () => { tick(); return data.customers; },
    contacts: async () => { tick(); return data.contacts; },
    customer: async id => { tick(); return data.customers.find((row: any) => row.jobberClientId === id) ?? null; },
    contact: async id => { tick(); return data.contacts.find((row: any) => row.id === id); },
    quarantineCounts: async () => data.counts,
    storedInvoices: async id => data.stored.filter((s: any) =>
      data.invoices.find((i: any) => i.id === s.jobberInvoiceId)?.client.id === id) };
  const inventoryIO: NotificationInventoryIO = { locationId: sourceIO.locationId,
    tokenExpiresAt: () => new Date(Date.now() + data.tokenRemaining), query };
  const request = { version: 1 as const, accountId: "account", locationId: "location",
    reviewRef: "synthetic-standing-scope", expiresAt: new Date(Date.now() + 900000).toISOString() };

  const db = new Database();
  const p: RecurringDay15EmailPolicy = { accountId: "account", locationId: "location",
    validFrom: new Date(NOW - 1000).toISOString(), validUntil: new Date(NOW + 86400000 * 30).toISOString(),
    cohort: "source-verified-open-homeowner-invoices", quarantine: policy.quarantine,
    template: { id: "day15-email", version: "1", subject: PROPOSED_DAY15_EMAIL_SUBJECT,
      body: PROPOSED_DAY15_EMAIL_BODY, policy: DAY15_EMAIL_TEMPLATE_POLICY },
    sender: "billing@flexxlandscaping.test", currency: "USD", channel: "email", dayPastDue: 15,
    timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)", missed: "no-catch-up",
    maximumAdmissionsPerRun: 10, action: "attempt" };

  const http: { url: string; method: string; body?: string }[] = [];
  const state = { posts: 0, holds: true, postThrow: false, postStatus: 200, historyOutbound: false,
    historyChannel: "TYPE_EMAIL", bootstrap: 0, wire: null as any };
  const runtime: RecurringDay15EmailRuntime = { accountId: "account", locationId: "location",
    credential: "synthetic-fake-token", inventoryIO, sourceIO, database: db,
    verifyActiveHolds: () => { if (!state.holds) throw Error("holds changed"); },
    fetch: (async (input, init) => {
      tick(); const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
      http.push({ url, method, body: init?.body as string | undefined });
      let body: unknown, status = 200;
      if (url.includes("/contacts/")) {
        assert.equal(headers.get("Version"), "2021-07-28");
        body = { contact: data.contacts.find((c: any) => url.endsWith(`/${c.id}`)) };
      } else if (url.includes("/conversations/search")) {
        body = state.historyOutbound
          ? { total: 1, conversations: [{ id: "conversation", contactId: "contact", locationId: "location" }] }
          : { total: 0, conversations: [] };
      } else if (url.includes("/conversation/messages")) {
        body = { messages: { nextPage: false, lastMessageId: "old", messages: [{ id: "old", type: 3,
          messageType: state.historyChannel, direction: "outbound", status: "delivered", contactId: "contact",
          locationId: "location", conversationId: "conversation", emailMessageId: "old-email",
          dateAdded: "2026-11-09T16:00:00.000Z" }] } };
      } else if (url.endsWith("/conversations/messages")) {
        assert.equal(method, "POST");
        state.wire = JSON.parse(init!.body as string);
        state.posts++; if (state.postThrow) throw Error("uncertain fake send");
        status = state.postStatus;
        body = { messageId: `fake-message-${state.posts}`, emailMessageId: `fake-email-${state.posts}`,
          conversationId: "conversation" };
      } else throw Error(`Unexpected fake URL ${url}`);
      const response = new Response(JSON.stringify(body), { status });
      Object.defineProperty(response, "url", { value: url }); return response;
    }) as typeof fetch };

  const run = (mode: "read-only" | "attempt" = "attempt", installed = installRecurringDay15EmailPolicy(p)) =>
    createRecurringDay15EmailService({ mode, policy: installed,
      runtime: async () => { state.bootstrap++; return runtime; } });

  const addOwner = (sameContact = false) => {
    const n = ++sequence;
    if (sameContact) {
      // A SECOND genuine invoice for the SAME customer, same milestone date.
      const extra = invoice(`d15-same-${n}`); data.invoices.push(extra); return;
    }
    const other = { jobberClientId: `owner-${n}`, email: `owner-${n}@example.test`, phone: "+16025550105" };
    data.customers.push(other);
    data.active.push({ id: other.jobberClientId, emails: [{ address: other.email, primary: true }],
      phones: [{ number: other.phone, primary: true }] });
    data.contacts.push({ id: `contact-${n}`, locationId: "location", email: other.email, phone: other.phone,
      tags: ["irrigation"], dndSettings: { SMS: { status: "inactive" }, Email: { status: "inactive" } } });
    const extra = invoice(`d15-other-${n}`); extra.client.id = other.jobberClientId; data.invoices.push(extra);
  };

  return { data, p, db, http, state, run, addOwner, invoice,
    scan: () => readNotificationInventory(request, inventoryIO), batch: () => readNotificationSourceBatch(policy, sourceIO) };
}

// --- default-off ----------------------------------------------------------

test("default Day15 email service is an exact no-op, even with throwing getters", async () => {
  const service = createRecurringDay15EmailService({
    get policy(): never { throw Error("accessed"); }, get runtime(): never { throw Error("accessed"); } });
  const r = await service.run();
  assert.equal(r.state, "disabled");
  assert.deepEqual([...r.reasons], ["recurring_day15_email_disabled"]);
});

test("import and the default path never initialize ambient Prisma or fetch", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    Object.defineProperty(globalThis, 'prisma', { get() { throw Error('ambient Prisma'); } });
    globalThis.fetch = () => { throw Error('ambient fetch'); };
    const m = await import('./lib/notification-recurring-day15-email.ts');
    await (m.default ?? m).createRecurringDay15EmailService().run();
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
});

test("a read-only policy cannot authorize an attempt, and clones are refused", () => clock(async tick => {
  const f = fixture(tick);
  const readOnly = installRecurringDay15EmailPolicy({ ...f.p, action: "read-only" });
  for (const policy of [readOnly, structuredClone(readOnly), { ...f.p, approved: true } as any]) {
    const r = await f.run("attempt", policy).run();
    assert.equal(r.state, "held");
    assert.equal(f.state.bootstrap, 0);
  }
  assert.throws(() => installRecurringDay15EmailPolicy({ ...f.p, approved: true } as any));
}));

test("unreviewed wording cannot be installed", () => clock(async tick => {
  const f = fixture(tick);
  assert.throws(() => installRecurringDay15EmailPolicy({ ...f.p,
    template: { ...f.p.template, body: "Pay now or a 3% late fee will be added. {{balance}} {{invoiceLink}}" } as any }));
  assert.throws(() => installRecurringDay15EmailPolicy({ ...f.p,
    template: { ...f.p.template, subject: "Late fee applied" } as any }));
  assert.throws(() => installRecurringDay15EmailPolicy({ ...f.p, sender: "+16025550101" }));
  assert.throws(() => installRecurringDay15EmailPolicy({ ...f.p, currency: "dollars" }));
}));

// --- the verified no-send path --------------------------------------------

test("read-only does the real reads but never reserves and never posts", () => clock(async tick => {
  const f = fixture(tick);
  const r = await f.run("read-only").run();
  assert.equal(r.invoices[0].result?.phase, "read_only", JSON.stringify(r));
  assert.equal(r.admissionAttempts, 0);
  assert.equal(r.messageAttempts, 0);
  assert.equal(f.db.rows.length, 0);
  assert.equal(f.state.posts, 0);
  assert.ok(f.db.operations.every(op => ["history:read-only", "runner:history"].includes(op)),
    `unexpected ledger write in read-only: ${f.db.operations.join(",")}`);
  // Live reads really happened: the link was read and the balance came from Jobber.
  assert.ok(f.data.linkReads >= 1);
  assert.ok(f.data.ownerReads >= 2);
}));

// --- the send path --------------------------------------------------------

test("one fee-free email per invoice, live balance and live link rendered", () => clock(async tick => {
  const f = fixture(tick);
  const r = await f.run().run();
  assert.equal(r.invoices[0].result?.state, "accepted", JSON.stringify(r));
  assert.equal(r.admissionAttempts, 1);
  assert.equal(r.messageAttempts, 1);
  const wire = f.state.wire;
  assert.equal(wire.type, "Email");
  assert.equal(wire.emailFrom, f.p.sender);
  assert.equal(wire.emailTo, "owner@example.test");
  assert.equal(wire.subject, PROPOSED_DAY15_EMAIL_SUBJECT);
  assert.equal(wire.status, "pending");
  // Live balance: Jobber's $240.50 rendered as 24050 minor units, plus the live link.
  assert.match(wire.message, /USD 240\.50/);
  assert.match(wire.message, /clienthub\.getjobber\.com/);
  // No fee claim of any kind.
  assert.doesNotMatch(wire.message, /fee|3%|charge/i);
  assert.equal(f.db.rows[0].state, "accepted");
  assert.equal(f.db.rows[0].dayPastDue, 15);
  assert.equal(f.db.rows[0].channel, "email");
}));

test("a payment landing immediately before the send holds it, with no post", () => clock(async tick => {
  const f = fixture(tick);
  f.data.payAfterFirstRead = true;
  const r = await f.run().run();
  assert.equal(f.state.posts, 0, "a paid invoice must not be emailed");
  assert.notEqual(r.invoices[0].result?.state, "accepted");
  assert.ok(f.db.rows.every(row => row.state !== "accepted"));
}));

test("a zero balance is never emailed", () => clock(async tick => {
  const f = fixture(tick);
  f.data.invoices = [f.invoice("d15-zero", "past_due", 0)];
  const r = await f.run().run();
  assert.equal(f.state.posts, 0);
  assert.notEqual(r.invoices[0]?.result?.state, "accepted");
}));

// --- consent / opt-out ----------------------------------------------------

test("a contact with no Email DND entry holds: unknown is not consent", () => clock(async tick => {
  const f = fixture(tick);
  f.data.contacts[0].dndSettings = { SMS: { status: "inactive" } };
  const r = await f.run().run();
  assert.equal(f.state.posts, 0);
  assert.notEqual(r.invoices[0].result?.state, "accepted");
}));

test("an explicit Email opt-out holds", () => clock(async tick => {
  const f = fixture(tick);
  f.data.contacts[0].dndSettings = { SMS: { status: "inactive" }, Email: { status: "active" } };
  const r = await f.run().run();
  assert.equal(f.state.posts, 0);
  assert.notEqual(r.invoices[0].result?.state, "accepted");
}));

test("a global DND holds even when the Email entry looks fine", () => clock(async tick => {
  const f = fixture(tick);
  f.data.contacts[0].dnd = true;
  const r = await f.run().run();
  assert.equal(f.state.posts, 0);
}));

// --- the old GHL workflow -------------------------------------------------

test("an existing outbound GHL message for this contact holds the invoice", () => clock(async tick => {
  const f = fixture(tick);
  f.state.historyOutbound = true;
  const r = await f.run().run();
  assert.equal(f.state.posts, 0, "the old workflow may already have covered this invoice");
  assert.notEqual(r.invoices[0].result?.state, "accepted");
}));

// --- overlapping runs -----------------------------------------------------

test("a second overlapping run cannot double-send the same invoice", () => clock(async tick => {
  const f = fixture(tick);
  const first = await f.run().run();
  assert.equal(first.invoices[0].result?.state, "accepted");
  assert.equal(f.state.posts, 1);
  // Same ledger, same event key, a fresh service instance: the reservation is refused.
  const second = await f.run().run();
  assert.notEqual(second.invoices[0].result?.state, "accepted");
  assert.equal(f.state.posts, 1, "the same invoice must not be emailed twice");
  assert.equal(f.db.rows.length, 1);
}));

test("a consumed service refuses a second run", () => clock(async tick => {
  const f = fixture(tick);
  const service = f.run();
  await service.run();
  const again = await service.run();
  assert.equal(again.state, "held");
  assert.deepEqual([...again.reasons], ["service_consumed_no_retry"]);
}));

// --- two invoices ---------------------------------------------------------

test("two invoices for DIFFERENT customers are both handled, keyed by invoice", () => clock(async tick => {
  const f = fixture(tick);
  f.addOwner();
  const r = await f.run().run();
  const accepted = r.invoices.filter(row => row.result?.state === "accepted");
  assert.equal(accepted.length, 2, JSON.stringify(r.invoices));
  assert.equal(f.state.posts, 2);
  // Two distinct ledger events, distinguished by invoice, not by contact.
  assert.equal(f.db.rows.length, 2);
  assert.equal(new Set(f.db.rows.map(row => row.invoiceId)).size, 2);
  assert.equal(new Set(f.db.rows.map(row => row.eventKey)).size, 2);
}));

test("two invoices for the SAME customer on one day hold with an explicit reason", () => clock(async tick => {
  const f = fixture(tick);
  f.addOwner(true);
  const r = await f.run().run();
  assert.equal(f.state.posts, 0, "combined customer copy is not approved, so neither is sent");
  const holds = r.invoices.flatMap(row => [...row.holds]);
  assert.ok(holds.includes("same_contact_two_invoices_same_day_copy_not_approved"),
    `expected the explicit conflict reason, got ${JSON.stringify(holds)}`);
  // Neither invoice was silently chosen and neither was silently dropped.
  assert.equal(f.db.rows.length, 0);
}));

// --- uncertainty ----------------------------------------------------------

test("an uncertain send is never retried and stops the batch", () => clock(async tick => {
  const f = fixture(tick);
  f.state.postThrow = true;
  const r = await f.run().run();
  assert.equal(f.state.posts, 1);
  assert.equal(r.state, "unknown");
  assert.deepEqual([...r.reasons], ["uncertain_event_stops_batch_no_retry"]);
  assert.equal(r.messageAttempts, 1, "the attempt is burned, not repeated");
}));

test("outside the Arizona window nothing is attempted and there is no catch-up", () => clock(async tick => {
  const f = fixture(tick);
  const real = Date.now;
  Date.now = () => Date.parse("2026-11-10T18:00:00.000Z"); // 11:00 Phoenix
  try {
    const r = await f.run().run();
    assert.equal(r.state, "held");
    assert.deepEqual([...r.reasons], ["outside_arizona_window_no_catch_up"]);
    assert.equal(f.state.bootstrap, 0);
    assert.equal(f.state.posts, 0);
  } finally { Date.now = real; }
}));

test("the admission limit is burned before IO, so it cannot be exceeded", () => clock(async tick => {
  const f = fixture(tick);
  f.addOwner();
  const limited = installRecurringDay15EmailPolicy({ ...f.p, maximumAdmissionsPerRun: 1 });
  const r = await f.run("attempt", limited).run();
  assert.equal(r.state, "held");
  assert.deepEqual([...r.reasons], ["current_cohort_exceeds_action_limit_no_subset_selected"]);
  assert.equal(f.state.posts, 0);
}));
