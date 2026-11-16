/**
 * Day 15 validator + the Day 10 safeguards it reuses.
 *
 * Everything here runs against a DISPOSABLE IN-MEMORY DATABASE and a FAKE
 * SENDER. No Postgres, no Railway, no production ledger row, no GoHighLevel,
 * no Jobber, no network of any kind. The fake is a model of the constraints,
 * not a PostgreSQL engine: it cannot prove real SQL, locking, durability or
 * driver behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createNotificationLedger, notificationBodyDigest,
  type NotificationLedgerDatabase, type NotificationLedgerTransaction,
  type NotificationReservationInput,
} from "../lib/notification-ledger";
import { planNotification, type Event, type Request } from "../lib/notification-gate";
import {
  inspectDay15PilotReadiness, reviewDay15PilotConfiguration, feeEvidenceProvesThreePercent,
  renderDay15Body, day15ClaimedFacts, DAY15_FEE_FACT,
  type Day15PilotConfig, type Day15PilotReview,
} from "../lib/notification-day15-pilot";

// ---------------------------------------------------------------------------
// Disposable in-memory database. Models the two unique indexes that matter.
// ---------------------------------------------------------------------------
type Row = Record<string, unknown> & { id: string; eventKey: string; state: string };

class DisposableDatabase implements NotificationLedgerDatabase {
  rows = new Map<string, Row>();
  byEventKey = new Map<string, string>();
  byContactDay = new Map<string, string>();
  statements: string[] = [];
  /** Serialises transactions, so an "overlap" is two interleaved reserve calls. */
  private tail: Promise<unknown> = Promise.resolve();

  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await work({ query: ((sql: string, values?: readonly unknown[]) => this.run(sql, values ?? [])) as NotificationLedgerTransaction["query"] }); }
    finally { release(); }
  }

  private async run(sql: string, values: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
    this.statements.push(sql);
    if (sql.includes("notification-ledger:reserve")) {
      const [id, token, eventKey, accountId, invoiceId, dayPastDue, audience, contactId, scheduledOn] = values as any[];
      const contactDay = JSON.stringify([accountId, contactId, scheduledOn]);
      // ON CONFLICT DO NOTHING on either unique index.
      if (this.byEventKey.has(eventKey) || this.byContactDay.has(contactDay)) return [];
      const row: Row = { id, token, eventKey, accountId, invoiceId, dayPastDue, audience, contactId,
        scheduledOn, state: "reserved" } as Row;
      this.rows.set(id, row);
      this.byEventKey.set(eventKey, id);
      this.byContactDay.set(contactDay, id);
      return [{ id }];
    }
    const id = values[0] as string;
    const row = this.rows.get(id);
    if (!row) return [];
    if (sql.includes("SELECT")) return row.state === "reserved" ? [{ id }] : [];
    if (sql.includes("UPDATE") && sql.includes("pending")) {
      if (row.state !== "reserved") return [];
      row.state = "pending";
      return [{ id }];
    }
    if (sql.includes("UPDATE")) {
      if (row.state !== "pending") return [];
      row.state = "closed";
      return [{ id }];
    }
    return [];
  }
}

const BODY = "Day 15 synthetic fixture. This test never sends.";
function reservationInput(patch: Partial<Event> = {}): NotificationReservationInput {
  const event: Event = {
    accountId: "disposable-account", invoiceId: "disposable-invoice-A", dayPastDue: 15,
    audience: "homeowner", sourceRevision: "src-1", ownerRevision: "own-1", ownerId: "owner-1",
    homeownerContactId: "contact-1", issuedDate: "2026-10-01", dueDate: "2026-10-30",
    balanceMinor: 13700, currency: "USD", category: "maintenance", recipientId: "contact-1",
    contactId: "contact-1", channel: "sms", destination: "+16025550111", templateId: "tpl-day15",
    templateVersion: "1", bodyDigest: notificationBodyDigest(BODY), claimedFacts: [DAY15_FEE_FACT], ...patch,
  };
  return { event, body: BODY, destination: event.destination, channel: event.channel,
    contactId: event.contactId, scheduledOn: "2026-11-14" };
}

// ---------------------------------------------------------------------------
// 1. Overlapping runs
// ---------------------------------------------------------------------------
test("two overlapping runs for the same invoice and milestone: exactly one reservation", async () => {
  const database = new DisposableDatabase();
  // Two independent ledgers = two processes. A shared in-process claim set would
  // mask the thing under test, which is the unique index.
  const runA = createNotificationLedger(database);
  const runB = createNotificationLedger(database);

  const [a, b] = await Promise.all([runA.reserve(reservationInput()), runB.reserve(reservationInput())]);
  const reserved = [a, b].filter(r => r.state === "reserved");
  const held = [a, b].filter(r => r.state === "held");

  assert.equal(reserved.length, 1, "exactly one run may hold the reservation");
  assert.equal(held.length, 1, "the other run must be held, not queued");
  assert.equal(database.rows.size, 1, "only one durable row exists");
});

test("a different invoice for the same customer on the same day is still blocked by the per-day index", async () => {
  const database = new DisposableDatabase();
  const ledger = createNotificationLedger(database);
  const first = await ledger.reserve(reservationInput({ invoiceId: "disposable-invoice-A" }));
  const second = await ledger.reserve(reservationInput({ invoiceId: "disposable-invoice-B" }));
  assert.equal(first.state, "reserved");
  assert.equal(second.state, "held", "one contact cannot be texted twice on one day");
});

// ---------------------------------------------------------------------------
// 2. Payment landing after the reservation
// ---------------------------------------------------------------------------
/** A complete, fresh evidence bundle. Every field the gate demands, nothing defaulted. */
const GATE_NOW = new Date("2026-11-14T16:05:00.000Z");
function evidenceBundle(event: Event, patch: { balanceMinor?: number; status?: "open" | "paid";
  dnd?: "allowed" | "blocked" | "unknown" } = {}) {
  const proof = { observedAt: "2026-11-14T16:04:00.000Z", expiresAt: "2026-11-14T16:14:00.000Z", sourceRef: "disposable-fixture" };
  return {
    source: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.sourceRevision,
      available: true, complete: true, status: patch.status ?? "open", balanceMinor: patch.balanceMinor ?? event.balanceMinor,
      currency: event.currency, ownerId: event.ownerId, issuedDate: event.issuedDate, dueDate: event.dueDate,
      category: event.category, categoryVerified: true },
    owner: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, revision: event.ownerRevision,
      ownerId: event.ownerId, homeownerContactId: event.homeownerContactId, exactSourceIdentity: true, complete: true },
    recipient: { ...proof, accountId: event.accountId, recipientId: event.recipientId, contactId: event.contactId,
      audience: event.audience, channel: event.channel, destination: event.destination,
      exactSourceIdentity: true, destinationVerified: true, internalRecipientApproved: false },
    dnd: { ...proof, accountId: event.accountId, contactId: event.contactId, channel: event.channel,
      destination: event.destination, state: patch.dnd ?? "allowed" },
    template: { ...proof, approved: true, accountId: event.accountId, id: event.templateId,
      version: event.templateVersion, bodyDigest: event.bodyDigest, audience: event.audience,
      dayPastDue: event.dayPastDue, channel: event.channel, claimedFacts: event.claimedFacts },
    channelAuthorization: { ...proof, approved: true, eventKey: "", recipientId: event.recipientId,
      channel: event.channel, destination: event.destination },
    facts: event.claimedFacts.map(fact => ({ ...proof, fact, accountId: event.accountId,
      invoiceId: event.invoiceId, sourceRevision: event.sourceRevision, value: true })),
    attempts: { ...proof, accountId: event.accountId, historyComplete: true, records: [] },
  } as unknown as Request["preflight"];
}

test("payment after the reservation holds at the final gate and never sends", async () => {
  const database = new DisposableDatabase();
  const ledger = createNotificationLedger(database);
  const reserved = await ledger.reserve(reservationInput());
  assert.equal(reserved.state, "reserved");

  const event = reservationInput().event;
  // Preflight saw an open balance. The final re-read sees it paid.
  const request = {
    event,
    preflight: evidenceBundle(event),
    final: evidenceBundle(event, { balanceMinor: 0, status: "paid" }),
  } as unknown as Request;

  const plan = planNotification(request, GATE_NOW);
  assert.equal(plan.designStatus, "hold", "a paid invoice must never be eligible");
  assert.ok(plan.reasons.some(r => r.startsWith("final:") && r.includes("not_open_positive_balance")),
    `expected the final-phase balance hold, got ${JSON.stringify(plan.reasons)}`);
  assert.equal(plan.sendCapability, false);

  // The reservation stays exactly where it is. Nothing advances it.
  assert.equal([...database.rows.values()][0].state, "reserved");
});

test("an opted-out recipient holds, even with everything else correct", () => {
  const event = reservationInput().event;
  const plan = planNotification({ event, preflight: evidenceBundle(event),
    final: evidenceBundle(event, { dnd: "blocked" }) } as unknown as Request, GATE_NOW);
  assert.equal(plan.designStatus, "hold");
  assert.ok(plan.reasons.some(r => r.includes("dnd") || r.includes("suppress")),
    `expected an opt-out hold, got ${JSON.stringify(plan.reasons)}`);
});

test("an unknown opt-out state holds too: silence is not consent", () => {
  const event = reservationInput().event;
  const plan = planNotification({ event, preflight: evidenceBundle(event),
    final: evidenceBundle(event, { dnd: "unknown" }) } as unknown as Request, GATE_NOW);
  assert.equal(plan.designStatus, "hold");
});

// ---------------------------------------------------------------------------
// 3. A timeout must never retry
// ---------------------------------------------------------------------------
test("a timed-out attempt stays pending, is never retried, and cannot be re-reserved", async () => {
  const database = new DisposableDatabase();
  const ledger = createNotificationLedger(database);
  const reservation = await ledger.reserve(reservationInput());
  assert.equal(reservation.state, "reserved");
  const handle = (reservation as { reservation: Parameters<typeof ledger.assertReserved>[0] }).reservation;

  assert.equal(await ledger.assertReserved(handle), true);
  assert.equal(await ledger.markPending(handle), true);

  // The fake sender times out. One call, no response.
  let sends = 0;
  const fakeSender = {
    fake: true as const, name: "fake-timeout-sender",
    async send() { sends += 1; throw new Error("ETIMEDOUT"); },
  };
  let outcome: "unknown" | "accepted" = "accepted";
  try { await fakeSender.send(); } catch { outcome = "unknown"; }

  assert.equal(sends, 1, "exactly one attempt was made");
  assert.equal(outcome, "unknown");

  // Nothing retries. The row sits at pending for a person to reconcile.
  const row = [...database.rows.values()][0];
  assert.equal(row.state, "pending");

  // And the allowance is spent: a fresh process cannot reserve it again.
  const anotherProcess = createNotificationLedger(database);
  const again = await anotherProcess.reserve(reservationInput());
  assert.equal(again.state, "held", "a timed-out attempt must not free the milestone");
  assert.equal(sends, 1, "still exactly one attempt");
});

// ---------------------------------------------------------------------------
// 4. The test entry point cannot reach the real send transport
// ---------------------------------------------------------------------------
test("the day 15 module imports no transport, no runtime, no client and no network", () => {
  const source = readFileSync(new URL("../lib/notification-day15-pilot.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)].map(m => m[1]);
  assert.deepEqual(imports.sort(), ["./invoice-reminder-clock", "./notification-source", "node:crypto"].sort(),
    `unexpected imports: ${JSON.stringify(imports)}`);

  for (const forbidden of ["notification-ghl-transport", "notification-runner", "notification-dispatch",
    "./prisma", "fetch(", "process.env", "readFile", "node:fs", "node:http"]) {
    assert.ok(!source.includes(forbidden), `day 15 validator must not reference ${forbidden}`);
  }
});

test("the validator exposes no send action at all", () => {
  // Day 10 accepts "read-only" | "one-attempt". Day 15 accepts only "read-only".
  const config = validConfig({ templatePolicy: "day15-no-fee-claim" });
  const raw = JSON.stringify(config);
  const asOneAttempt = { configSha256: sha256(raw), reviewRef: config.reviewRef, action: "one-attempt" } as unknown as Day15PilotReview;
  const result = inspectDay15PilotReadiness(raw, asOneAttempt);
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("explicit_read_only_runtime_action"));
  assert.equal(result.productionSendCapability, false);
  assert.equal(result.rolloutReady, false);
});

// ---------------------------------------------------------------------------
// 5. The 3% fee may not be claimed unless Jobber proves it
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
const sha256 = (v: string) => createHash("sha256").update(v, "utf8").digest("hex");

function validConfig(options: { templatePolicy: Day15PilotConfig["template"]["policy"];
  fee?: unknown; body?: string }): Day15PilotConfig {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    version: 1, kind: "day15-homeowner-sms-pilot", reviewRef: "review-day15-synthetic",
    reviewedAt: iso(now - 60_000), expiresAt: iso(now + 3_600_000),
    source: {
      version: 1, reviewRef: "source-day15-synthetic", expiresAt: iso(now + 7_200_000),
      scope: { locationId: "loc-1", jobberClientId: "client-1", contactId: "contact-1", invoiceId: "invoice-1" },
      originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-01", dueDate: "2026-10-30" },
      identityCoveragePolicy: { accountId: "account-1" },
    },
    destination: "+16025550111",
    scope: { scheduledOn: "2026-11-14", dayPastDue: 15, audience: "homeowner", channel: "sms",
      maximumAttempts: 1, history: "accessible-ghl-plus-local-ledger", timeZone: "America/Phoenix",
      window: "[09:00:00,09:15:00)", authorizationRef: "auth-1", timingRef: "timing-1", credentialBindingRef: "cred-1" },
    currencyPolicy: { accountId: "account-1", invoiceId: "invoice-1", currency: "USD", minorUnitExponent: 2, evidenceRef: "cur-1" },
    sender: { number: "+16023297865", approvalRef: "sender-1", writeScopeEvidenceRef: "scope-1" },
    template: { id: "tpl-day15", version: "1", policy: options.templatePolicy, approvalRef: "tpl-approval-1",
      body: options.body ?? (options.templatePolicy === "day15-fee-applied"
        ? "Your invoice is 15 days past due and a 3% late fee has been applied. Balance now {{balance}}."
        : "Your invoice is 15 days past due. Balance {{balance}}. Please call our office at 602-329-7865.") },
    feeEvidence: (options.fee ?? null) as Day15PilotConfig["feeEvidence"],
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", semanticsRef: "sem-1",
      footer: { mode: "exact-native-suffix", suffix: "\n\nReply STOP to opt out.", evidenceRef: "foot-1" } },
  } as unknown as Day15PilotConfig;
}
const review = (c: Day15PilotConfig, raw: string): Day15PilotReview =>
  ({ configSha256: sha256(raw), reviewRef: c.reviewRef, action: "read-only" });

test("arithmetic is what proves the fee, not a line item name", () => {
  const base = 13300;
  const exact = Math.round((base * 300) / 10_000); // 399
  const good = { source: "jobber-invoice-line-item" as const, invoiceId: "invoice-1",
    lineItemName: "Late Fee", feeMinor: exact, baseMinor: base,
    observedAt: "2026-11-14T16:00:00.000Z", evidenceRef: "jobber-line-1" };
  assert.equal(feeEvidenceProvesThreePercent(good, "invoice-1"), true);

  assert.equal(feeEvidenceProvesThreePercent({ ...good, feeMinor: exact + 1 }, "invoice-1"), false, "wrong amount");
  assert.equal(feeEvidenceProvesThreePercent(good, "invoice-2"), false, "evidence from another invoice");
  assert.equal(feeEvidenceProvesThreePercent({ ...good, lineItemName: "Mulch" }, "invoice-1"), false, "not named a fee");
  assert.equal(feeEvidenceProvesThreePercent(null, "invoice-1"), false, "absent evidence is not proof");
});

test("fee-applied copy is HELD when Jobber does not prove the fee", () => {
  const config = validConfig({ templatePolicy: "day15-fee-applied", fee: null });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("jobber_proven_three_percent_fee_for_this_invoice"));
  assert.deepEqual([...result.claimedFacts], [], "an unproven fact is never claimed");
});

test("fee-applied copy is accepted when Jobber proves the fee, and only then claims the fact", () => {
  const base = 13300;
  const config = validConfig({ templatePolicy: "day15-fee-applied", fee: {
    source: "jobber-invoice-line-item", invoiceId: "invoice-1", lineItemName: "Late Fee (3%)",
    feeMinor: Math.round((base * 300) / 10_000), baseMinor: base,
    observedAt: "2026-11-14T16:00:00.000Z", evidenceRef: "jobber-line-1" } });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "reviewed_configuration", `missing: ${JSON.stringify(result.missing)}`);
  assert.equal(result.feeClaim, "proven_by_jobber");
  assert.deepEqual([...result.claimedFacts], [DAY15_FEE_FACT]);

  const handle = reviewDay15PilotConfiguration(raw, review(config, raw)).handle;
  assert.ok(handle);
  assert.deepEqual([...day15ClaimedFacts(config)], [DAY15_FEE_FACT]);
});

test("no-fee-claim copy may not smuggle fee wording back in", () => {
  const config = validConfig({ templatePolicy: "day15-no-fee-claim",
    body: "Your invoice is 15 days past due and a late fee has been applied. Balance {{balance}}." });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("no_fee_claim_copy_must_not_mention_a_fee"));
  assert.ok(result.missing.includes("asserted_fee_requires_fee_applied_policy"));
});

// --- The copy that is actually live in Fixed Automation, read 2026-11-16 ---
const LIVE_DAY15_SMS =
  "Hello {{balance}}, This is your reminder that your invoice is past due. " +
  "A late fee of 3% may apply under your invoice terms, and we kindly ask this invoice " +
  "be paid to avoid potential late fees. If you have any questions or concerns please " +
  "reach out to our office at 602-329-7865.";

test("the live approved Day 15 copy warns about the fee and does NOT assert it", () => {
  const config = validConfig({ templatePolicy: "day15-fee-may-apply", body: LIVE_DAY15_SMS });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "reviewed_configuration", `missing: ${JSON.stringify(result.missing)}`);
  assert.equal(result.feeClaim, "not_claimed_gate_will_hold");
  assert.deepEqual([...result.claimedFacts], [], "a warning claims nothing, so no Jobber proof is needed");
});

test("the live copy is rejected if filed as an assertion, because nothing proves the fee", () => {
  const config = validConfig({ templatePolicy: "day15-fee-applied", body: LIVE_DAY15_SMS, fee: null });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("jobber_proven_three_percent_fee_for_this_invoice"));
});

test("'may apply' is not accepted as a fee-free template", () => {
  const config = validConfig({ templatePolicy: "day15-no-fee-claim", body: LIVE_DAY15_SMS });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("no_fee_claim_copy_must_not_mention_a_fee"));
});

test("an assertion dressed up as a warning is still an assertion", () => {
  const config = validConfig({ templatePolicy: "day15-fee-may-apply",
    body: "Your invoice is past due. A 3% late fee has been applied to avoid further charges. Balance {{balance}}." });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "held");
  assert.ok(result.missing.includes("may_apply_copy_must_not_assert_a_fee_was_applied"));
});

test("no-fee-claim copy is valid, claims nothing, and the gate will hold it", () => {
  const config = validConfig({ templatePolicy: "day15-no-fee-claim" });
  const raw = JSON.stringify(config);
  const result = inspectDay15PilotReadiness(raw, review(config, raw));
  assert.equal(result.state, "reviewed_configuration", `missing: ${JSON.stringify(result.missing)}`);
  assert.equal(result.feeClaim, "not_claimed_gate_will_hold");
  assert.deepEqual([...result.claimedFacts], []);

  // And that is exactly what the gate does: day 15 requires the fact.
  const event = reservationInput({ claimedFacts: [] }).event;
  const plan = planNotification({ event, preflight: evidenceBundle(event), final: evidenceBundle(event) } as unknown as Request,
    GATE_NOW);
  assert.equal(plan.designStatus, "hold");
  assert.ok(plan.reasons.includes("required_template_fact_missing"),
    `day 15 without the fee fact must hold, not send softened copy; got ${JSON.stringify(plan.reasons)}`);
});

// ---------------------------------------------------------------------------
// 6. Rendering
// ---------------------------------------------------------------------------
test("rendering refuses a zero balance and an absent invoice number", () => {
  const config = validConfig({ templatePolicy: "day15-no-fee-claim" });
  assert.throws(() => renderDay15Body(config, { balanceMinor: 0, dueOn: "2026-10-30" }), /positive_balance/);

  const withNumber = validConfig({ templatePolicy: "day15-no-fee-claim",
    body: "Invoice {{invoiceNumber}} is 15 days past due. Balance {{balance}}." });
  assert.throws(() => renderDay15Body(withNumber, { balanceMinor: 13700, invoiceNumber: null, dueOn: "2026-10-30" }),
    /invoice_display_number_required/);
  assert.equal(renderDay15Body(withNumber, { balanceMinor: 13700, invoiceNumber: "7203", dueOn: "2026-10-30" }),
    "Invoice 7203 is 15 days past due. Balance USD 137.00.");
});
