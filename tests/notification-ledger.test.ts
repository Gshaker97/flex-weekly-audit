import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import {
  createNotificationLedger, createPrismaNotificationLedger, notificationBodyDigest,
  notificationEventHash, notificationDestinationHash, NOTIFICATION_LEDGER_TIMEOUTS,
  type NotificationLedgerDatabase, type NotificationLedgerTransaction, type NotificationReservationInput,
  type NotificationReservation, type NotificationLedger,
} from "../lib/notification-ledger";
import { eventKey, type Event, type Request } from "../lib/notification-gate";
import { exerciseSyntheticNotificationBatch, type NotificationExerciseDependencies } from "../lib/notification-dispatch";
import { BODY, NOW, fixture } from "./fixtures/notification-fixture.mjs";

// Compile-only structural compatibility check: never construct or connect Prisma.
const acceptsExistingPrismaClient = (client: PrismaClient) => createPrismaNotificationLedger(client);
void acceptsExistingPrismaClient;

const body = "Synthetic invoice reminder. This fixture never sends.";
function input(patch: Partial<Event> = {}): NotificationReservationInput {
  const event: Event = { accountId: "synthetic-account", invoiceId: "synthetic-invoice", dayPastDue: 10,
    audience: "homeowner", sourceRevision: "source-1", ownerRevision: "owner-1", ownerId: "synthetic-owner",
    homeownerContactId: "synthetic-contact", issuedDate: "2026-10-01", dueDate: "2026-10-30",
    balanceMinor: 10000, currency: "USD", category: "maintenance", recipientId: "synthetic-recipient",
    contactId: "synthetic-contact", channel: "sms", destination: "+16025550111", templateId: "synthetic-template",
    templateVersion: "1", bodyDigest: notificationBodyDigest(body), claimedFacts: [], ...patch };
  return { event, body, destination: event.destination, channel: event.channel,
    contactId: event.contactId, scheduledOn: "2026-11-09" };
}

type Row = { id: string; token: string; eventKey: string; accountId: string; invoiceId: string;
  dayPastDue: number; audience: string; contactId: string; scheduledOn: string; channel: string;
  eventPayload: string; body: string; destination: string; eventHash: string; bodyHash: string;
  destinationHash: string; state: string; providerMessageId: string | null };
type Operation = "reserve" | "assert" | "pending" | "outcome";

/** Deliberately a fake, NOT a PostgreSQL engine. It models transactions and constraints
 * for unit tests. It cannot prove actual SQL, locking, durability, crash or driver behavior.
 */
class FakeDatabase implements NotificationLedgerDatabase {
  rows = new Map<string, Row>();
  queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  transactions = 0;
  fault: { operation: Operation; phase: "query" | "before_commit" | "after_commit" } | null = null;
  private tail = Promise.resolve();

  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.transactions++;
    let operation: Operation | undefined;
    const draft = new Map([...this.rows].map(([key, row]) => [key, { ...row }]));
    const trip = (phase: "query" | "before_commit" | "after_commit") => {
      if (this.fault && this.fault.operation === operation && this.fault.phase === phase) {
        this.fault = null;
        throw new Error("synthetic_timeout_or_lost_ack");
      }
    };
    try {
      const result = await work({ query: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
        this.queries.push({ sql, values });
        operation = /notification-ledger:(reserve|assert|pending|outcome)/.exec(sql)?.[1] as Operation;
        if (!operation) throw new Error("unrecognized_fake_statement");
        trip("query");
        if (operation === "reserve") {
          const [id, token, eventKey, accountId, invoiceId, dayPastDue, audience, contactId, scheduledOn,
            channel, eventPayload, exactBody, destination, eventHash, bodyHash, destinationHash] = values;
          const conflict = [...draft.values()].some(row => row.eventKey === eventKey ||
            row.accountId === accountId && row.invoiceId === invoiceId && row.dayPastDue === dayPastDue && row.audience === audience ||
            row.accountId === accountId && row.contactId === contactId && row.scheduledOn === scheduledOn);
          if (conflict) return [];
          const row = { id, token, eventKey, accountId, invoiceId, dayPastDue, audience, contactId, scheduledOn,
            channel, eventPayload, body: exactBody, destination, eventHash, bodyHash, destinationHash,
            state: "reserved", providerMessageId: null } as Row;
          draft.set(row.id, row);
          return [{ id }] as unknown as R[];
        }
        const [id, token, eventHash, bodyHash, destinationHash] = values;
        const row = draft.get(id as string);
        if (!row || row.token !== token || row.eventHash !== eventHash || row.bodyHash !== bodyHash ||
            row.destinationHash !== destinationHash || row.state !== (operation === "outcome" ? "pending" : "reserved"))
          return [];
        if (operation === "pending") row.state = "pending";
        if (operation === "outcome") { row.state = values[5] as string; row.providerMessageId = values[6] as string | null; }
        return [{ id }] as unknown as R[];
      } });
      trip("before_commit");
      this.rows = draft;
      trip("after_commit");
      return result;
    } finally { release(); }
  }
}

async function reserve(ledger: NotificationLedger, request = input()): Promise<NotificationReservation> {
  const result = await ledger.reserve(request);
  assert.equal(result.state, "reserved");
  if (result.state !== "reserved") throw new Error("not_reserved");
  return result.reservation;
}

async function verified(ledger: NotificationLedger): Promise<NotificationReservation> {
  const handle = await reserve(ledger);
  assert.equal(await ledger.assertReserved(handle), true);
  return handle;
}

test("reservation snapshots and hashes the exact event, body and destination", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), request = input();
  const promise = ledger.reserve(request);
  (request.event as { balanceMinor: number }).balanceMinor = 999;
  const result = await promise;
  assert.equal(result.state, "reserved");
  if (result.state !== "reserved") return;
  const row = db.rows.get(result.reservation.id)!;
  assert.equal(JSON.parse(row.eventPayload).balanceMinor, 10000);
  assert.equal(row.body, body);
  assert.equal(row.bodyHash, notificationBodyDigest(body));
  assert.equal(row.eventHash, notificationEventHash(input().event));
  assert.equal(row.destinationHash, notificationDestinationHash(input().event));
  assert.equal(row.eventKey, JSON.stringify(["notification-v1", "synthetic-account", "synthetic-invoice", 10, "homeowner"]));
  assert.equal(Object.isFrozen(result.reservation), true);
  assert.equal(Object.isFrozen(ledger), true);
  assert.equal(await ledger.assertReserved(result.reservation), true);
});

test("canonical event hashing is stable across property order but includes mutable details", () => {
  const event = input().event;
  assert.equal(notificationEventHash(event), notificationEventHash(Object.fromEntries(Object.entries(event).reverse()) as Event));
  for (const patch of [{ balanceMinor: 999 }, { dueDate: "2026-10-29" }, { channel: "email" as const },
    { sourceRevision: "source-2" }, { ownerRevision: "owner-2" }, { templateVersion: "2" }])
    assert.notEqual(notificationEventHash(event), notificationEventHash({ ...event, ...patch }));
});

test("invalid body, date, destination, contact and channel bindings never enter a transaction", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), base = input();
  const invalid: NotificationReservationInput[] = [
    { ...base, body: body + "!" }, { ...base, body: "" }, { ...base, body: "x".repeat(65_537) },
    { ...base, destination: "+16025550112" }, { ...base, contactId: "different-contact" },
    { ...base, channel: "email" }, { ...base, scheduledOn: "2026-11-10" },
    { ...base, scheduledOn: "2026-11-09T00:00:00Z" }, { ...base, scheduledOn: "2026-02-30" },
    input({ dueDate: "2026-10-30T00:00:00" }), input({ dayPastDue: 0 }), input({ dayPastDue: NaN }),
    input({ bodyDigest: "0".repeat(64) }), input({ invoiceId: " invoice " }),
  ];
  for (const request of invalid) assert.deepEqual(await ledger.reserve(request), { state: "held", reason: "invalid_reservation_input" });
  assert.equal(db.transactions, 0);
});

test("source due-date timestamps use Phoenix dates, not timestamp + 240 hours", async () => {
  for (const dueDate of ["2026-10-30", "2026-10-30T07:00:00Z", "2026-10-31T06:59:59Z", "2026-10-30T23:59:59-07:00"]) {
    const db = new FakeDatabase();
    await reserve(createNotificationLedger(db), input({ dueDate }));
    assert.equal([...db.rows.values()][0].scheduledOn, "2026-11-09");
  }
});

test("non-JSON, cyclic, accessor and sparse event data fail closed", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db);
  const cycle: Record<string, unknown> = { ...input().event }; cycle.self = cycle;
  const getter = { ...input().event }; Object.defineProperty(getter, "balanceMinor", { enumerable: true, get: () => 1 });
  let arrayReads = 0;
  const arrayGetter = ["first"];
  Object.defineProperty(arrayGetter, "0", { enumerable: true, get: () => { arrayReads++; return "must_not_execute"; } });
  const symbolArray = ["first"]; Object.defineProperty(symbolArray, Symbol("hidden"), { value: "extra" });
  const extraArray = ["first"]; Object.defineProperty(extraArray, "hidden", { value: "extra" });
  const malformed = [{ ...input().event, extra: undefined }, { ...input().event, extra: Infinity }, cycle, getter,
    { ...input().event, extra: new Date() }, { ...input().event, extra: [1, , 2] },
    { ...input().event, extra: arrayGetter }, { ...input().event, extra: symbolArray },
    { ...input().event, extra: extraArray }, { ...input().event, extra: () => 1 }];
  for (const event of malformed)
    assert.equal((await ledger.reserve({ ...input(), event: event as Event })).state, "held");
  assert.equal(db.transactions, 0);
  assert.equal(arrayReads, 0);
});

test("independent ledgers racing the same event yield only one durable claim in the fake", async () => {
  const db = new FakeDatabase();
  const results = await Promise.all(Array.from({ length: 25 }, () => createNotificationLedger(db).reserve(input())));
  assert.equal(results.filter(result => result.state === "reserved").length, 1);
  assert.equal(db.rows.size, 1);
});

test("event uniqueness excludes channel, destination, contact, body, owner and due-date changes", async () => {
  const db = new FakeDatabase();
  await reserve(createNotificationLedger(db));
  for (const patch of [{ channel: "email" as const, destination: "synthetic@example.invalid" },
    { contactId: "different-contact" }, { ownerId: "different-owner" }, { templateVersion: "2" }])
    assert.equal((await createNotificationLedger(db).reserve(input(patch))).state, "held");
  const changedDate = { ...input({ dueDate: "2026-10-31" }), scheduledOn: "2026-11-10" };
  assert.equal((await createNotificationLedger(db).reserve(changedDate)).state, "held");
  assert.equal(db.rows.size, 1);
});

test("same-contact/day blocks competing invoices across channels and audiences", async () => {
  const db = new FakeDatabase();
  const homeowner = input();
  const internal = input({ invoiceId: "another-invoice", audience: "internal", dayPastDue: 21,
    dueDate: "2026-10-19", channel: "email", destination: "synthetic@example.invalid" });
  const results = await Promise.all([createNotificationLedger(db).reserve(homeowner), createNotificationLedger(db).reserve(internal)]);
  assert.equal(results.filter(result => result.state === "reserved").length, 1);
  assert.equal(db.rows.size, 1);
});

test("internal shared recipient collisions are held, not automatically batched", async () => {
  const db = new FakeDatabase();
  const first = input({ audience: "internal", dayPastDue: 21, dueDate: "2026-10-19", contactId: "synthetic-angie" });
  await reserve(createNotificationLedger(db), first);
  assert.equal((await createNotificationLedger(db).reserve({ ...first, event: { ...first.event, invoiceId: "another-invoice" } })).state, "held");
});

test("different accounts or contact/dates do not accidentally share a uniqueness domain", async () => {
  const db = new FakeDatabase();
  for (const request of [input(), input({ accountId: "another-account" }),
    input({ invoiceId: "invoice-2", contactId: "contact-2" }),
    { ...input({ invoiceId: "invoice-3", dueDate: "2026-10-31" }), scheduledOn: "2026-11-10" }])
    await reserve(createNotificationLedger(db), request);
  assert.equal(db.rows.size, 4);
});

test("one original capability admits only one competing pending call", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
  const results = await Promise.all([ledger.markPending(handle), ledger.markPending(handle), ledger.markPending(handle)]);
  assert.deepEqual(results.sort(), [false, false, true]);
  assert.equal(db.rows.get(handle.id)?.state, "pending");
  assert.equal(db.queries.filter(query => query.sql.includes("notification-ledger:pending")).length, 1);
  assert.equal(await ledger.assertReserved(handle), false);
});

test("pending requires a successful assertion first", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await reserve(ledger);
  assert.equal(await ledger.markPending(handle), false);
  assert.equal(db.rows.get(handle.id)?.state, "reserved");
  assert.equal(await ledger.assertReserved(handle), true);
  assert.equal(await ledger.markPending(handle), true);
});

test("cloned, forged, hash-mutated or restored handles cannot advance or inspect a claim", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
  for (const forged of [{ ...handle }, { ...handle, token: "0".repeat(64) },
    { ...handle, bodyHash: "0".repeat(64) }, { ...handle, eventHash: "0".repeat(64) },
    { ...handle, destinationHash: "0".repeat(64) }]) {
    assert.equal(await ledger.assertReserved(forged), false);
    assert.equal(await ledger.markPending(forged), false);
  }
  assert.equal(await createNotificationLedger(db).markPending(handle), false);
  assert.equal(await ledger.markPending(handle), true);
});

test("SQL predicates bind every handle digest and token, independently of local identity", async () => {
  for (const property of ["token", "eventHash", "bodyHash", "destinationHash"] as const) {
    const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
    db.rows.get(handle.id)![property] = "0".repeat(64);
    assert.equal(await ledger.markPending(handle), false);
    const query = db.queries[2];
    for (const column of ["id", "reservationToken", "eventHash", "bodyHash", "destinationHash"])
      assert.ok(query.sql.includes(`"${column}" = $`));
    assert.ok(query.sql.includes('"state" = \'reserved\''));
  }
});

for (const phase of ["query", "before_commit", "after_commit"] as const) {
  test(`reserve ${phase} fault returns no handle, never retries, possible committed claim remains held`, async () => {
    const db = new FakeDatabase(), ledger = createNotificationLedger(db);
    db.fault = { operation: "reserve", phase };
    assert.deepEqual(await ledger.reserve(input()), { state: "held", reason: "ledger_uncertain" });
    assert.equal((await ledger.reserve(input())).state, "held");
    assert.equal(db.transactions, 1);
    assert.equal(db.rows.size, phase === "after_commit" ? 1 : 0);
    if (phase === "after_commit") assert.equal((await createNotificationLedger(db).reserve(input())).state, "held");
  });

  test(`pending ${phase} fault burns the handle and never permits a provider attempt`, async () => {
    const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
    db.fault = { operation: "pending", phase };
    let providerCalls = 0;
    if (await ledger.markPending(handle)) providerCalls++;
    if (await ledger.markPending(handle)) providerCalls++;
    assert.equal(providerCalls, 0);
    assert.equal(db.rows.get(handle.id)?.state, phase === "after_commit" ? "pending" : "reserved");
    assert.equal(db.queries.filter(query => query.sql.includes("notification-ledger:pending")).length, 1);
    assert.equal((await createNotificationLedger(db).reserve(input())).state, "held");
  });
}

test("false or uncertain assertReserved permanently burns a handle", async () => {
  for (const fail of ["false", "error"] as const) {
    const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await reserve(ledger);
    if (fail === "false") db.rows.get(handle.id)!.state = "pending";
    else db.fault = { operation: "assert", phase: "query" };
    assert.equal(await ledger.assertReserved(handle), false);
    db.rows.get(handle.id)!.state = "reserved";
    assert.equal(await ledger.assertReserved(handle), false);
    assert.equal(await ledger.markPending(handle), false);
  }
});

test("a concurrent false assertion cannot be resurrected by an earlier in-flight assertion", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await reserve(ledger);
  assert.deepEqual(await Promise.all([ledger.assertReserved(handle), ledger.assertReserved(handle)]), [false, false]);
  assert.equal(await ledger.assertReserved(handle), false);
  assert.equal(await ledger.markPending(handle), false);
  assert.equal(db.rows.get(handle.id)?.state, "reserved");
});

test("accepted remains accepted, not delivered; rejected and unknown also block every replay", async () => {
  for (const outcome of [{ state: "accepted", providerMessageId: "synthetic-provider-id" },
    { state: "rejected" }, { state: "unknown" }] as const) {
    const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
    assert.equal(await ledger.markOutcome(handle, outcome), false);
    assert.equal(await ledger.markPending(handle), true);
    assert.equal(await ledger.markOutcome(handle, outcome), true);
    assert.equal(db.rows.get(handle.id)?.state, outcome.state);
    assert.equal(await ledger.markOutcome(handle, outcome), false);
    assert.equal(await ledger.markPending(handle), false);
    assert.equal((await createNotificationLedger(db).reserve(input())).state, "held");
  }
});

test("outcome persistence failure after a provider call leaves pending unresolved without retries", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
  assert.equal(await ledger.markPending(handle), true);
  const providerCalls = 1; // simulated accepted response, not a network invocation
  db.fault = { operation: "outcome", phase: "before_commit" };
  assert.equal(await ledger.markOutcome(handle, { state: "accepted", providerMessageId: "synthetic-provider-id" }), false);
  assert.equal(db.rows.get(handle.id)?.state, "pending");
  assert.equal(await ledger.markOutcome(handle, { state: "accepted", providerMessageId: "synthetic-provider-id" }), false);
  assert.equal(await ledger.markPending(handle), false);
  assert.equal(providerCalls, 1);
});

test("lost outcome acknowledgment never claims known persistence and does not send or write again", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
  assert.equal(await ledger.markPending(handle), true);
  db.fault = { operation: "outcome", phase: "after_commit" };
  assert.equal(await ledger.markOutcome(handle, { state: "unknown" }), false);
  assert.equal(db.rows.get(handle.id)?.state, "unknown");
  assert.equal(await ledger.markOutcome(handle, { state: "unknown" }), false);
  assert.equal((await createNotificationLedger(db).reserve(input())).state, "held");
});

test("invalid outcome burns the only outcome attempt while preserving pending state", async () => {
  const db = new FakeDatabase(), ledger = createNotificationLedger(db), handle = await verified(ledger);
  assert.equal(await ledger.markPending(handle), true);
  assert.equal(await ledger.markOutcome(handle, { state: "accepted", providerMessageId: "" }), false);
  assert.equal(await ledger.markOutcome(handle, { state: "unknown" }), false);
  assert.equal(db.rows.get(handle.id)?.state, "pending");
});

test("Prisma factory is inert, bounds transactions and uses fixed timeout SQL plus bound parameters", async () => {
  const db = new FakeDatabase(), setup: string[] = [], options: unknown[] = [];
  const ledger = createPrismaNotificationLedger({
    $transaction: async (work, option) => {
      options.push(option);
      return db.transaction(tx => work({
        $executeRawUnsafe: async sql => { setup.push(sql); return 0; },
        $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => tx.query(sql, values) as Promise<T>,
      }));
    },
  });
  assert.equal(db.transactions, 0);
  const request = input({ invoiceId: "synthetic'); DROP TABLE x; --" });
  await reserve(ledger, request);
  assert.deepEqual(options, [{ maxWait: NOTIFICATION_LEDGER_TIMEOUTS.maxWaitMs, timeout: NOTIFICATION_LEDGER_TIMEOUTS.transactionMs }]);
  assert.deepEqual(setup, ["SET LOCAL lock_timeout = '1000ms'", "SET LOCAL statement_timeout = '2500ms'"]);
  assert.ok(!db.queries[0].sql.includes(request.event.invoiceId));
  assert.ok(db.queries[0].values.includes(request.event.invoiceId));
});

test("migration source declares both unique constraints, immutable transitions, and no delivered state", () => {
  // Source inspection only: does not execute or validate SQL against PostgreSQL.
  const migration = readFileSync(new URL("../prisma/migrations/20261109140000_notification_ledger_candidate/migration.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "NotificationLedger_eventKey_key"/);
  assert.match(migration, /ON "NotificationLedger"\("accountId", "invoiceId", "dayPastDue", "audience"\)/);
  assert.match(migration, /ON "NotificationLedger"\("accountId", "contactId", "scheduledOn"\)/);
  assert.match(migration, /claim data is immutable/);
  assert.match(migration, /OLD\."state" = 'reserved' AND NEW\."state" = 'pending'/);
  assert.match(migration, /OLD\."state" = 'pending' AND NEW\."state" IN \('accepted', 'rejected', 'unknown'\)/);
  assert.doesNotMatch(migration, /'delivered'/);
  const ledger = createNotificationLedger(new FakeDatabase());
  assert.deepEqual(Object.keys(ledger).sort(), ["assertReserved", "markOutcome", "markPending", "reserve"]);
});

function integratedSetup(db = new FakeDatabase(), request = fixture() as Request) {
  let sends = 0;
  const ledger = createNotificationLedger(db);
  const deps: NotificationExerciseDependencies = { ledger, now: () => new Date(NOW),
    transport: { kind: "synthetic-no-network", send: async ({ body: sentBody, event, reservation }) => {
      sends++;
      assert.equal(sentBody, BODY);
      assert.equal(db.rows.get(reservation.id)?.state, "pending");
      assert.equal(reservation.eventHash, notificationEventHash(event));
      assert.equal(reservation.bodyHash, notificationBodyDigest(sentBody));
      return { state: "accepted", providerMessageId: "synthetic-integrated-message" };
    } },
    readFinal: async () => {
      const evidence = structuredClone(request.final);
      for (const key of ["source", "owner", "recipient", "dnd", "template", "channelAuthorization", "attempts"] as const)
        (evidence[key] as { observedAt: string }).observedAt = new Date(NOW.getTime() - 500).toISOString();
      for (const fact of evidence.facts)
        (fact as { observedAt: string }).observedAt = new Date(NOW.getTime() - 500).toISOString();
      return evidence;
    },
  };
  return { db, ledger, request, deps, sends: () => sends,
    run: () => exerciseSyntheticNotificationBatch([{ request, body: BODY }], deps) };
}

test("integration: actual ledger admits one fake send only after pending commit and records acceptance", async () => {
  const setup = integratedSetup();
  const [result] = await setup.run();
  assert.equal(result.state, "simulation_accepted");
  assert.equal(result.productionSendCapability, false);
  assert.ok(result.reasons.includes("acceptance_not_delivery"));
  assert.equal(setup.sends(), 1);
  assert.equal([...setup.db.rows.values()][0].state, "accepted");
  assert.equal((await setup.run())[0].state, "held");
  assert.equal(setup.sends(), 1);
  // A fresh ledger instance still encounters the durable claim in the fake DB.
  const restart = integratedSetup(setup.db);
  assert.equal((await restart.run())[0].state, "held");
  assert.equal(restart.sends(), 0);
});

test("integration: competing valid invoice for the same contact/day is held by the actual ledger", async () => {
  const first = integratedSetup();
  assert.equal((await first.run())[0].state, "simulation_accepted");
  const other = structuredClone(fixture()) as Request;
  (other.event as { invoiceId: string }).invoiceId = "synthetic-competing-invoice";
  for (const evidence of [other.preflight, other.final]) {
    (evidence.source as { invoiceId: string }).invoiceId = other.event.invoiceId;
    (evidence.owner as { invoiceId: string }).invoiceId = other.event.invoiceId;
    (evidence.channelAuthorization as { eventKey: string }).eventKey = eventKey(other.event);
  }
  const second = integratedSetup(first.db, other);
  const [result] = await second.run();
  assert.equal(result.state, "held");
  assert.ok(result.reasons.includes("already_claimed"));
  assert.equal(second.sends(), 0);
  assert.equal(first.db.rows.size, 1);
});

test("integration: pending commit acknowledgment loss produces no fake send and no retry", async () => {
  const setup = integratedSetup();
  setup.db.fault = { operation: "pending", phase: "after_commit" };
  const [result] = await setup.run();
  assert.equal(result.state, "unknown");
  assert.ok(result.reasons.includes("pending_acknowledgment_unavailable"));
  assert.equal([...setup.db.rows.values()][0].state, "pending");
  assert.equal(setup.sends(), 0);
  assert.equal((await integratedSetup(setup.db).run())[0].state, "held");
  assert.equal(setup.sends(), 0);
});

for (const phase of ["before_commit", "after_commit"] as const) {
  test(`integration: accepted fake transport then outcome ${phase} fault is unknown and never retried`, async () => {
    const setup = integratedSetup();
    setup.db.fault = { operation: "outcome", phase };
    const [result] = await setup.run();
    assert.equal(result.state, "unknown");
    assert.ok(result.reasons.includes("accepted_receipt_not_durably_confirmed"));
    assert.equal(setup.sends(), 1);
    assert.equal([...setup.db.rows.values()][0].state, phase === "after_commit" ? "accepted" : "pending");
    const restart = integratedSetup(setup.db);
    assert.equal((await restart.run())[0].state, "held");
    assert.equal(restart.sends(), 0);
    assert.equal((await setup.run())[0].state, "held");
    assert.equal(setup.sends(), 1);
  });
}
