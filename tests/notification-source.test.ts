import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readNotificationSource, refreshNotificationSource, inspectNotificationSource, composeNotificationEvidence,
  deployedNotificationSourceReadBindings, type NotificationSourceRequest, type NotificationSourceIO,
  type NotificationSourceSnapshot, type NotificationExternalEvidence } from "../lib/notification-source";
import { eventKey, planNotification, type Event, type Fact } from "../lib/notification-gate";
import { createNotificationLedger } from "../lib/notification-ledger";

const NOW = Date.parse("2026-11-09T16:05:00Z");
async function withClock(run: (clock: { advance(ms: number): void; now(): number }) => Promise<void>) {
  const real = Date.now; let ms = NOW; Date.now = () => ms;
  try { await run({ advance: n => { ms += n; }, now: () => ms }); } finally { Date.now = real; }
}
function fixture() {
  const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
  const quarantine = [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }];
  const fresh = { id: "owner", emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
  const data: any = { customers: [owner, ...quarantine], identities: [fresh], archived: [], contacts: [{ id: "contact", locationId: "location", email: owner.email, phone: owner.phone }],
    invoices: [{ id: "invoice", invoiceNumber: "1234", client: { id: "owner" }, invoiceStatus: "past_due", amounts: { total: 137, invoiceBalance: 137 }, issuedDate: "2026-10-20", dueDate: "2026-10-30", createdAt: "2025-01-01" }],
    stored: [{ jobberInvoiceId: "invoice" }], counts: quarantine.map(c => ({ jobberClientId: c.jobberClientId, jobs: 0, invoices: 0 })) };
  const request: NotificationSourceRequest = { version: 1, reviewRef: "synthetic-review", expiresAt: new Date(Date.now() + 600000).toISOString(),
    scope: { locationId: "location", jobberClientId: "owner", contactId: "contact", invoiceId: "invoice" },
    originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-20", dueDate: "2026-10-30" },
    identityCoveragePolicy: { accountId: "account", reviewRef: "synthetic-quarantine", reviewedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), quarantine: [quarantine[0], quarantine[1]] } };
  const calls: string[] = [];
  const io: NotificationSourceIO = { locationId: () => "location", customers: async () => data.customers,
    contacts: async () => data.contacts, storedInvoices: async () => data.stored, quarantineCounts: async () => data.counts,
    query: async <T = any>(q: string, v?: Record<string, any>): Promise<T> => {
      calls.push(q); assert.match(q, /^\s*query\b/); assert.match(q, /account \{ id \}/);
      let result: any;
      if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: data.account ?? "account" }, clients: { nodes: q.includes("isArchived: false") ? data.identities : data.archived, pageInfo: { hasNextPage: false, endCursor: null } } };
      else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "account" }, client: data.quarantineReappears ? { id: v!.id } : null };
      else if (q.includes("VerifyDateOwnerInvoices")) result = { account: { id: data.invoiceAccount ?? "account" }, client: { id: "owner", invoices: { nodes: data.invoices, pageInfo: { hasNextPage: false, endCursor: null } } } };
      else result = { account: { id: data.exactAccount ?? "account" }, client: data.exactOwner ?? data.identities[0], invoice: { id: data.exactInvoice ?? "invoice", client: { id: data.exactInvoiceOwner ?? "owner" } } };
      return structuredClone(result) as T;
    } };
  return { owner, quarantine, fresh, data, request, io, calls, read: () => readNotificationSource(request, io) };
}
function eventFor(s: NotificationSourceSnapshot, day = 10, category: Event["category"] = null): Event {
  const claimedFacts: Fact[] = day === 15 ? ["three_percent_fee_applied"] : [20, 25].includes(day) ? ["recurring_late_fee_policy"]
    : day === 30 ? ["service_suspended", "collections_after_day_35_policy"] : [];
  return { accountId: s.accountId, invoiceId: s.invoiceId, dayPastDue: day, audience: day === 21 ? "internal" : "homeowner",
    sourceRevision: s.sourceRevision, ownerRevision: s.ownerRevision, ownerId: s.ownerId, homeownerContactId: s.homeownerContactId,
    issuedDate: s.issuedDate, dueDate: s.dueDate, balanceMinor: s.balanceMinor, currency: "USD", category,
    recipientId: day === 21 ? "internal" : "contact", contactId: day === 21 ? "internal" : "contact", channel: "sms", destination: "+16025550100",
    templateId: "template", templateVersion: "1", bodyDigest: createHash("sha256").update("SYNTHETIC").digest("hex"), claimedFacts };
}
function externalFor(event: Event): NotificationExternalEvidence {
  const proof = { observedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), sourceRef: "synthetic-external-trusted-reader" };
  return { metadata: { ...proof, accountId: event.accountId, invoiceId: event.invoiceId, sourceRevision: event.sourceRevision, currency: event.currency, category: event.category, categoryVerified: event.category !== null },
    recipient: { ...proof, accountId: event.accountId, recipientId: event.recipientId, contactId: event.contactId, audience: event.audience,
      channel: event.channel, destination: event.destination, exactSourceIdentity: true, destinationVerified: true, internalRecipientApproved: event.audience === "internal" },
    dnd: { ...proof, accountId: event.accountId, contactId: event.contactId, channel: event.channel, destination: event.destination, state: "allowed" },
    template: { ...proof, approved: true, accountId: event.accountId, id: event.templateId, version: event.templateVersion, bodyDigest: event.bodyDigest,
      audience: event.audience, dayPastDue: event.dayPastDue, channel: event.channel, claimedFacts: [...event.claimedFacts] },
    channelAuthorization: { ...proof, approved: true, eventKey: eventKey(event), recipientId: event.recipientId, channel: event.channel, destination: event.destination },
    facts: event.claimedFacts.map(fact => ({ ...proof, fact, accountId: event.accountId, invoiceId: event.invoiceId, sourceRevision: event.sourceRevision, value: true })),
    attempts: { ...proof, accountId: event.accountId, historyComplete: true, records: [] } };
}

test("real issuer/account/owner reader composition has no fabricated source metadata or production permission", () => withClock(async () => {
  const f = fixture(), h = await f.read(), s = inspectNotificationSource(h);
  assert.equal(s.status, "open"); assert.equal(s.balanceMinor, 13700); assert.equal(s.invoiceNumber, "1234");
  assert.equal(s.currency, null); assert.equal(s.category, null); assert.equal(s.categoryVerified, false);
  assert.equal(s.sentOn, "2026-10-20"); assert.equal(s.dueOn, "2026-10-30"); assert.equal(s.daysPastDue, 10);
  assert.equal(s.productionSendCapability, false); assert.equal(s.timingApproved, false); assert.equal(s.coverageReused, false);
  assert.ok(s.unsupportedInputs.includes("complete_existing_attempt_history"));
  assert.equal(f.calls.length, 6); assert.equal(f.calls.filter(q => q.includes("isArchived:")).length, 2);
  assert.match(f.calls[5], /id invoiceNumber invoiceStatus/);
  assert.ok(Object.isFrozen(s)); assert.ok(Object.isFrozen(s.unsupportedInputs));
}));

for (const [status, balance, expected] of [["paid", 0, "paid"], ["paid", 137, "unknown"], ["void", 137, "void"],
  ["refunded", 0, "unknown"], ["refunded", 137, "unknown"], ["past_due", 0, "unknown"], ["awaiting_payment", 0, "unknown"], ["unrecognized", 137, "unknown"]] as const)
  test(`source ${status}/${balance} never becomes open/eligible`, () => withClock(async () => {
    const f = fixture(); f.data.invoices[0].invoiceStatus = status; f.data.invoices[0].amounts.invoiceBalance = balance;
    const h = await f.read(), s = inspectNotificationSource(h), e = eventFor(s);
    assert.equal(s.status, expected); assert.throws(() => composeNotificationEvidence(h, e, externalFor(e)), /not open/);
  }));

for (const kind of ["negative", "zero total", "subcent", "NaN", "balance above total", "missing total", "missing balance", "missing status",
  "missing invoice", "second unpaid invoice", "second paid invoice", "duplicate invoice", "wrong invoice owner", "missing cached invoice", "extra cached invoice",
  "changed total", "changed issued", "changed due", "invalid date", "wrong invoice account", "wrong coverage account", "wrong exact account",
  "wrong exact invoice", "wrong exact owner", "wrong location", "cached owner missing", "cached owner duplicate", "source identity drift",
  "GHL phone conflict", "secondary email collision", "secondary phone collision", "cached quarantined collision", "unreviewed omission",
  "quarantined reappearance", "quarantined linked job", "quarantined linked invoice", "malformed GHL identity", "duplicate contact", "wrong contact location",
  "expired request", "expired policy", "policy over 24h", "future policy"]) test(`source holds ${kind}`, () => withClock(async () => {
    const f = fixture(), d = f.data, i = d.invoices[0];
    if (kind === "negative") i.amounts.invoiceBalance = -1;
    if (kind === "zero total") i.amounts = { total: 0, invoiceBalance: 0 };
    if (kind === "subcent") i.amounts.invoiceBalance = 0.001;
    if (kind === "NaN") i.amounts.invoiceBalance = NaN;
    if (kind === "balance above total") i.amounts.invoiceBalance = 138;
    if (kind === "missing total") delete i.amounts.total;
    if (kind === "missing balance") delete i.amounts.invoiceBalance;
    if (kind === "missing status") delete i.invoiceStatus;
    if (kind === "missing invoice") d.invoices = [];
    if (kind === "second unpaid invoice" || kind === "second paid invoice") d.invoices.push({ ...i, id: "other", invoiceStatus: kind.includes("unpaid") ? "past_due" : "paid" });
    if (kind === "duplicate invoice") d.invoices.push(i);
    if (kind === "wrong invoice owner") i.client.id = "other";
    if (kind === "missing cached invoice") d.stored = [];
    if (kind === "extra cached invoice") d.stored.push({ jobberInvoiceId: "extra" });
    if (kind === "changed total") i.amounts.total = 138;
    if (kind === "changed issued") i.issuedDate = "2026-10-21";
    if (kind === "changed due") i.dueDate = "2026-10-31";
    if (kind === "invalid date") i.dueDate = "2026-02-30";
    if (kind === "wrong invoice account") d.invoiceAccount = "other";
    if (kind === "wrong coverage account") d.account = "other";
    if (kind === "wrong exact account") d.exactAccount = "other";
    if (kind === "wrong exact invoice") d.exactInvoice = "other";
    if (kind === "wrong exact owner") d.exactInvoiceOwner = "other";
    if (kind === "wrong location") (f.request.scope as any).locationId = "other";
    if (kind === "cached owner missing") d.customers.shift();
    if (kind === "cached owner duplicate") d.customers.push(d.customers[0]);
    if (kind === "source identity drift") f.fresh.phones[0].number = "+16025550101";
    if (kind === "GHL phone conflict") d.contacts[0].phone = "+16025550101";
    if (kind === "secondary email collision") d.contacts.push({ id: "other", additionalEmails: [{ email: f.owner.email }] });
    if (kind === "secondary phone collision") d.contacts.push({ id: "other", additionalPhones: [{ phone: f.owner.phone }] });
    if (kind === "cached quarantined collision") { d.customers[1].phone = f.owner.phone; (f.request.identityCoveragePolicy.quarantine[0] as any).phone = f.owner.phone; }
    if (kind === "unreviewed omission") d.customers.push({ jobberClientId: "new" });
    if (kind === "quarantined reappearance") d.quarantineReappears = true;
    if (kind === "quarantined linked job") d.counts[0].jobs = 1;
    if (kind === "quarantined linked invoice") d.counts[0].invoices = 1;
    if (kind === "malformed GHL identity") d.contacts[0].additionalEmails = [null];
    if (kind === "duplicate contact") d.contacts.push(d.contacts[0]);
    if (kind === "wrong contact location") d.contacts[0].locationId = "other";
    if (kind === "expired request") (f.request as any).expiresAt = new Date(Date.now()).toISOString();
    if (kind === "expired policy") f.request.identityCoveragePolicy.expiresAt = new Date(Date.now()).toISOString();
    if (kind === "policy over 24h") f.request.identityCoveragePolicy.expiresAt = new Date(Date.now() + 86400001).toISOString();
    if (kind === "future policy") f.request.identityCoveragePolicy.reviewedAt = new Date(Date.now() + 1).toISOString();
    await assert.rejects(f.read());
  }));

test("original ledger reservation, clones, JSON and snapshots cannot masquerade as source capability", () => withClock(async () => {
  const f = fixture(), handle = await f.read(), s = inspectNotificationSource(handle), e = eventFor(s);
  const ledger = createNotificationLedger({ transaction: async work => work({ query: async (_q, values) => [{ id: values[0] }] as any }) });
  const claim = await ledger.reserve({ event: e, body: "SYNTHETIC", destination: e.destination, channel: e.channel, contactId: e.contactId, scheduledOn: "2026-11-09" });
  assert.equal(claim.state, "reserved");
  for (const forged of [{}, structuredClone(handle), s, JSON.parse(JSON.stringify(s)), claim.state === "reserved" && claim.reservation]) {
    assert.throws(() => inspectNotificationSource(forged as any), /Unissued/);
    assert.throws(() => composeNotificationEvidence(forged as any, e, externalFor(e)), /Unissued/);
    await assert.rejects(refreshNotificationSource(forged as any), /Unissued/);
  }
}));

test("39-second reads keep original identity time and distinct honest source/contact/exact-read times", () => withClock(async clock => {
  const f = fixture(), q = f.io.query; let delayed = false;
  (f.io as any).query = async (s: string, v: any) => { if (!delayed) { delayed = true; clock.advance(39000); } return q(s, v); };
  const first = await f.read(), a = inspectNotificationSource(first);
  assert.equal(a.identityObservedAt, new Date(NOW).toISOString()); assert.equal(a.identityExpiresAt, new Date(NOW + 300000).toISOString());
  assert.equal(a.observedAt, new Date(NOW + 39000).toISOString()); assert.equal(a.exactOwnerObservedAt, a.observedAt);
  clock.advance(10000); const second = await refreshNotificationSource(first), b = inspectNotificationSource(second);
  assert.equal(b.identityObservedAt, a.identityObservedAt); assert.equal(b.identityExpiresAt, a.identityExpiresAt);
  assert.equal(b.identitySourceRef, a.identitySourceRef); assert.equal(b.ownerRevision, a.ownerRevision); assert.equal(b.coverageReused, true);
  assert.ok(b.observedAt > a.observedAt); assert.equal(f.calls.filter(q => q.includes("VerifyExplicitIdentityCoverage")).length, 2);
}));

test("final reread may replace stale source within original coverage but never renew at five minutes", () => withClock(async clock => {
  const f = fixture(), first = await f.read(), a = inspectNotificationSource(first);
  clock.advance(61000); assert.throws(() => inspectNotificationSource(first), /expired/);
  const second = await refreshNotificationSource(first), b = inspectNotificationSource(second);
  assert.equal(b.identityExpiresAt, a.identityExpiresAt); assert.equal(b.identityObservedAt, a.identityObservedAt);
  clock.advance(239000); await assert.rejects(refreshNotificationSource(second), /expired/);
}));

for (const phase of ["coverage", "source", "contact", "exact owner", "policy during read", "policy during refresh"]) test(`slow/expired ${phase} cannot launder old evidence`, () => withClock(async clock => {
  const f = fixture(), q = f.io.query;
  if (phase === "coverage") (f.io as any).query = async (s: string, v: any) => { clock.advance(300000); return q(s, v); };
  if (phase === "source") (f.io as any).query = async (s: string, v: any) => { if (s.includes("VerifyDateOwnerInvoices")) clock.advance(60000); return q(s, v); };
  if (phase === "contact") (f.io as any).contacts = async () => { clock.advance(60000); return f.data.contacts; };
  if (phase === "policy during read") (f.io as any).storedInvoices = async () => { clock.advance(600000); return f.data.stored; };
  if (phase === "policy during refresh") {
    (f.request as any).expiresAt = new Date(NOW + 45000).toISOString(); f.request.identityCoveragePolicy.expiresAt = new Date(NOW + 45000).toISOString();
    const h = await f.read(); clock.advance(45000); await assert.rejects(refreshNotificationSource(h), /expired/); return;
  }
  if (phase === "exact owner") {
    (f.io as any).query = async (s: string, v: any) => { if (s.includes("VerifyNotificationExactOwner")) clock.advance(60000); return q(s, v); };
    const h = await f.read(); clock.advance(1); await assert.rejects(refreshNotificationSource(h), /expired/); return;
  }
  await assert.rejects(f.read(), /expired/);
}));

for (const kind of ["owner", "invoice owner", "invoice id", "account", "contacts", "paid", "new invoice", "due"]) test(`final ${kind} drift holds before composition`, () => withClock(async clock => {
  const f = fixture(), h = await f.read(), e = eventFor(inspectNotificationSource(h)); clock.advance(1);
  if (kind === "owner") f.fresh.phones[0].number = "+16025550101";
  if (kind === "invoice owner") f.data.exactInvoiceOwner = "other";
  if (kind === "invoice id") f.data.exactInvoice = "other";
  if (kind === "account") f.data.exactAccount = "other";
  if (kind === "contacts") f.data.contacts[0].phone = "+16025550101";
  if (kind === "paid") { f.data.invoices[0].invoiceStatus = "paid"; f.data.invoices[0].amounts.invoiceBalance = 0; }
  if (kind === "new invoice") f.data.invoices.push({ ...f.data.invoices[0], id: "other" });
  if (kind === "due") f.data.invoices[0].dueDate = "2026-10-31";
  if (kind === "paid") { const after = await refreshNotificationSource(h); assert.throws(() => composeNotificationEvidence(after, e, externalFor(e)), /not open/); }
  else await assert.rejects(refreshNotificationSource(h));
}));

test("complete synthetic independent evidence plus exact reread reaches proposal only, with owner proof unchanged", () => withClock(async clock => {
  const f = fixture(), h = await f.read(), e = eventFor(inspectNotificationSource(h));
  const before = composeNotificationEvidence(h, e, externalFor(e));
  clock.advance(1000); const next = await refreshNotificationSource(h), x = externalFor(e), after = composeNotificationEvidence(next, e, x);
  const plan = planNotification({ event: e, preflight: before.evidence, final: after.evidence }, new Date(Date.now()));
  assert.equal(plan.designStatus, "eligible_in_proposal", plan.reasons.join(",")); assert.equal(plan.sendCapability, false);
  assert.deepEqual(before.evidence.owner, after.evidence.owner); assert.equal(after.productionSendCapability, false);
  (x.attempts as any).historyComplete = false; assert.equal(after.evidence.attempts.historyComplete, true); assert.ok(Object.isFrozen(after.evidence.attempts.records));
}));

for (const kind of ["metadata missing", "currency", "category unverified", "metadata revision", "metadata stale", "DND missing", "DND stale",
  "template unapproved", "channel unapproved", "history incomplete", "prior reserved", "facts missing", "internal unapproved", "wrong destination", "wrong source revision"])
  test(`external ${kind} is never fabricated or granted`, () => withClock(async clock => {
    const f = fixture(), h = await f.read(); let e = eventFor(inspectNotificationSource(h));
    if (kind === "facts missing") e = { ...e, claimedFacts: ["service_suspended"] };
    if (kind === "internal unapproved") e = { ...e, dayPastDue: 21, audience: "internal", contactId: "internal", recipientId: "internal" };
    if (kind === "wrong destination") e = { ...e, destination: "+16025550101" };
    if (kind === "wrong source revision") e = { ...e, sourceRevision: "forged" };
    const x = externalFor(e) as any;
    if (kind === "metadata missing") delete x.metadata;
    if (kind === "currency") x.metadata.currency = "EUR";
    if (kind === "category unverified") { x.metadata.category = "maintenance"; x.metadata.categoryVerified = false; }
    if (kind === "metadata revision") x.metadata.sourceRevision = "forged";
    if (kind === "metadata stale") x.metadata.observedAt = new Date(Date.now() - 60000).toISOString();
    if (kind === "DND missing") delete x.dnd;
    if (kind === "DND stale") x.dnd.observedAt = new Date(Date.now() - 60000).toISOString();
    if (kind === "template unapproved") x.template.approved = false;
    if (kind === "channel unapproved") x.channelAuthorization.approved = false;
    if (kind === "history incomplete") x.attempts.historyComplete = false;
    if (kind === "prior reserved") x.attempts.records.push({ eventKey: eventKey(e), state: "reserved" });
    if (kind === "facts missing") x.facts = [];
    if (kind === "internal unapproved") x.recipient.internalRecipientApproved = false;
    if (["template unapproved", "channel unapproved", "history incomplete", "prior reserved", "facts missing", "internal unapproved"].includes(kind)) {
      const before = composeNotificationEvidence(h, e, x); clock.advance(1); const next = await refreshNotificationSource(h);
      for (const item of [x.metadata, x.recipient, x.dnd, x.template, x.channelAuthorization, x.attempts, ...x.facts]) {
        item.observedAt = new Date(Date.now()).toISOString(); item.expiresAt = new Date(Date.now() + 60000).toISOString();
      }
      const final = composeNotificationEvidence(next, e, x);
      const plan = planNotification({ event: e, preflight: before.evidence, final: final.evidence }, new Date(Date.now()));
      assert.equal(plan.designStatus, "hold");
      const reason = ({ "template unapproved": "template_not_exact_approved", "channel unapproved": "channel_not_explicitly_authorized",
        "history incomplete": "attempt_history_incomplete_or_wrong_account", "prior reserved": "prior_attempt:reserved",
        "facts missing": "fact_not_proven:service_suspended", "internal unapproved": "recipient_not_exact_verified_approved" } as Record<string, string>)[kind];
      assert.ok(plan.reasons.includes(`final:${reason}`), plan.reasons.join(","));
    } else assert.throws(() => composeNotificationEvidence(h, e, x));
  }));

for (const [day, category, eligible] of [[10, null, true], [15, null, true], [21, null, true], [20, null, false],
  [25, "irrigation", false], [30, null, false], [20, "maintenance", true], [25, "maintenance", true], [30, "maintenance", true]] as const)
  test(`day ${day} / ${category} respects common versus maintenance milestones`, () => withClock(async clock => {
    const f = fixture(), due = new Date(NOW - day * 86400000).toISOString().slice(0, 10);
    f.data.invoices[0].issuedDate = "2026-09-01"; f.data.invoices[0].dueDate = due;
    (f.request.originalInvoice as any).issuedDate = "2026-09-01"; (f.request.originalInvoice as any).dueDate = due;
    const h = await f.read(), e = eventFor(inspectNotificationSource(h), day, category);
    const before = composeNotificationEvidence(h, e, externalFor(e)); clock.advance(1); const next = await refreshNotificationSource(h);
    const after = composeNotificationEvidence(next, e, externalFor(e));
    const plan = planNotification({ event: e, preflight: before.evidence, final: after.evidence }, new Date(Date.now()));
    assert.equal(plan.designStatus, eligible ? "eligible_in_proposal" : "hold", plan.reasons.join(","));
  }));

test("the day after actual dueDate is late day one, never createdAt or stage entry", () => withClock(async () => {
  const f = fixture(); f.data.invoices[0].dueDate = "2026-11-08"; (f.request.originalInvoice as any).dueDate = "2026-11-08";
  const s = inspectNotificationSource(await f.read()); assert.equal(s.daysPastDue, 1); assert.equal(s.sentOn, "2026-10-20");
}));

test("read-only deployed factory is inert and forces one no-refresh Jobber reader attempt", () => withClock(async () => {
  let calls = 0;
  const binding = await deployedNotificationSourceReadBindings({ query: async (q, v, options) => {
    calls++; assert.equal(options?.maxAttempts, 1); assert.equal(options?.deadlineAt, Date.now() + 60000); return { synthetic: true };
  } });
  assert.equal(calls, 0); assert.deepEqual(await binding.query("query Synthetic { account { id } }"), { synthetic: true }); assert.equal(calls, 1);
}));

for (const kind of ["cached primary", "new cached identity", "missing cache", "quarantined job", "quarantined invoice", "quarantine missing", "quarantine duplicated"])
  test(`final reuse refuses current ${kind} changes without extending identity proof`, () => withClock(async clock => {
    const f = fixture(), h = await f.read(); clock.advance(1);
    if (kind === "cached primary") f.data.customers[0].email = "changed@example.test";
    if (kind === "new cached identity") f.data.customers.push({ jobberClientId: "new" });
    if (kind === "missing cache") f.data.customers = [];
    if (kind === "quarantined job") f.data.counts[0].jobs = 1;
    if (kind === "quarantined invoice") f.data.counts[0].invoices = 1;
    if (kind === "quarantine missing") f.data.counts.pop();
    if (kind === "quarantine duplicated") f.data.counts[1] = f.data.counts[0];
    await assert.rejects(refreshNotificationSource(h), /cached identities|quarantine links/);
  }));

for (const kind of ["account later page", "missing cursor", "repeated cursor", "duplicate source row", "missing completeness"])
  test(`owner source pagination fails closed on ${kind}`, () => withClock(async () => {
    const f = fixture(), base = f.io.query; let page = 0;
    (f.io as any).query = async (q: string, v: any) => {
      if (!q.includes("VerifyDateOwnerInvoices")) return base(q, v);
      page++;
      const connection: any = { nodes: page === 1 || kind === "duplicate source row" ? f.data.invoices : [{ ...f.data.invoices[0], id: "other" }], pageInfo: { hasNextPage: page === 1 || kind === "repeated cursor", endCursor: "next" } };
      if (kind === "missing cursor") connection.pageInfo.endCursor = null;
      if (kind === "missing completeness") delete connection.pageInfo.hasNextPage;
      return { account: { id: kind === "account later page" && page === 2 ? "other" : "account" }, client: { id: "owner", invoices: connection } };
    };
    await assert.rejects(f.read());
    assert.ok(page <= 2);
  }));

test("changed positive balance produces a different source revision and holds the pinned event", () => withClock(async clock => {
  const f = fixture(), first = await f.read(), e = eventFor(inspectNotificationSource(first));
  f.data.invoices[0].amounts.invoiceBalance = 100; clock.advance(1);
  const next = await refreshNotificationSource(first), s = inspectNotificationSource(next);
  assert.equal(s.status, "open"); assert.equal(s.balanceMinor, 10000); assert.notEqual(s.sourceRevision, e.sourceRevision);
  assert.throws(() => composeNotificationEvidence(next, e, externalFor(eventFor(s))), /event changed/);
}));

test("original request and returned proofs cannot be mutated to extend coverage", () => withClock(async clock => {
  const f = fixture(), first = await f.read(), a = inspectNotificationSource(first);
  (f.request as any).expiresAt = new Date(Date.now() + 86400000).toISOString();
  f.request.identityCoveragePolicy.expiresAt = new Date(Date.now() + 86400000).toISOString();
  clock.advance(1000); const next = await refreshNotificationSource(first), b = inspectNotificationSource(next);
  assert.equal(b.identityExpiresAt, a.identityExpiresAt); assert.equal(b.requestSha256, a.requestSha256);
}));

test("unknown invoice number stays unknown and is never substituted by identity", () => withClock(async () => {
  const f = fixture(); delete f.data.invoices[0].invoiceNumber;
  const s = inspectNotificationSource(await f.read()); assert.equal(s.invoiceNumber, null); assert.equal(s.invoiceId, "invoice");
}));

test("a late-day-15 fee must be independently proven, not inferred from balance or date", () => withClock(async clock => {
  const f = fixture(); f.data.invoices[0].dueDate = "2026-10-25"; (f.request.originalInvoice as any).dueDate = "2026-10-25";
  const h = await f.read(), e = eventFor(inspectNotificationSource(h), 15);
  const x = externalFor(e); const preflight = composeNotificationEvidence(h, e, { ...x, facts: [] }).evidence;
  clock.advance(1); const h2 = await refreshNotificationSource(h), y = externalFor(e);
  const final = composeNotificationEvidence(h2, e, { ...y, facts: [] }).evidence;
  const p = planNotification({ event: e, preflight, final }, new Date(Date.now()));
  assert.ok(p.reasons.includes("final:fact_not_proven:three_percent_fee_applied")); assert.equal(p.sendCapability, false);
}));


test("invoice display-number drift does not change stable invoice identity or gate source revision", () => withClock(async clock => {
  const f = fixture(), first = await f.read(), a = inspectNotificationSource(first);
  f.data.invoices[0].invoiceNumber = "9999"; clock.advance(1);
  const next = await refreshNotificationSource(first), b = inspectNotificationSource(next);
  assert.equal(b.invoiceNumber, "9999"); assert.equal(b.invoiceId, a.invoiceId);
  assert.equal(b.sourceRevision, a.sourceRevision); assert.equal(b.ownerRevision, a.ownerRevision);
}));

test("harmless cache/contact order, identifier order and activity metadata preserve coverage continuity", () => withClock(async clock => {
  const f = fixture();
  f.data.contacts.push({ id: "unrelated", email: "different@example.test", phone: "+16025550199",
    additionalEmails: [{ email: "secondary-2@example.test" }, { email: "secondary-1@example.test" }],
    additionalPhones: [{ phone: "+16025550197" }, { phone: "+16025550198" }], lastActivity: "old" });
  const h = await f.read(), a = inspectNotificationSource(h);
  f.data.customers.reverse(); f.data.customers[0].unrelatedMetadata = "new";
  f.data.contacts[1].lastActivity = "new";
  f.data.contacts[1].additionalEmails.reverse(); f.data.contacts[1].additionalPhones.reverse();
  f.data.contacts.reverse(); clock.advance(1);
  const next = await refreshNotificationSource(h), b = inspectNotificationSource(next);
  assert.equal(b.ownerRevision, a.ownerRevision); assert.equal(b.identitySourceRef, a.identitySourceRef);
  assert.equal(b.identityExpiresAt, a.identityExpiresAt);
}));

for (const kind of ["additional email", "additional phone", "new collision", "malformed additional", "malformed primary", "malformed cache"])
  test(`canonical refresh retains every collision-relevant ${kind}`, () => withClock(async clock => {
    const f = fixture();
    f.data.contacts.push({ id: "unrelated", email: "different@example.test", phone: "+16025550199",
      additionalEmails: [{ email: "secondary@example.test" }], additionalPhones: [{ phone: "+16025550198" }] });
    const h = await f.read(); clock.advance(1);
    if (kind === "additional email") f.data.contacts[1].additionalEmails[0].email = "changed@example.test";
    if (kind === "additional phone") f.data.contacts[1].additionalPhones[0].phone = "+16025550197";
    if (kind === "new collision") f.data.contacts[1].additionalPhones.push({ phone: f.owner.phone });
    if (kind === "malformed additional") f.data.contacts[1].additionalPhones.push({ phone: null });
    if (kind === "malformed primary") f.data.contacts[1].phone = { number: "+16025550199" };
    if (kind === "malformed cache") f.data.customers[1].phone = { number: "+16025550199" };
    await assert.rejects(refreshNotificationSource(h), /identity|unverified/);
  }));

for (const kind of ["cache", "counts"]) test(`slow final ${kind} read holds despite fresh later source and identity rechecks`, () => withClock(async clock => {
  const f = fixture(); let slow = false;
  if (kind === "cache") (f.io as any).customers = async () => { if (slow) clock.advance(60000); return f.data.customers; };
  if (kind === "counts") (f.io as any).quarantineCounts = async () => { if (slow) clock.advance(60000); return f.data.counts; };
  const h = await f.read(); slow = true; clock.advance(1);
  await assert.rejects(refreshNotificationSource(h), /cacheObservedAt.*expired|quarantineCountsObservedAt.*expired/);
}));

test("slow original cache read cannot be stamped fresh by later complete identity coverage", () => withClock(async clock => {
  const f = fixture(); (f.io as any).customers = async () => { clock.advance(60000); return f.data.customers; };
  await assert.rejects(f.read(), /cacheObservedAt.*expired/);
}));

test("composing later cannot hide aged cache/count checks behind a younger source observation", () => withClock(async clock => {
  const f = fixture(), q = f.io.query;
  (f.io as any).query = async (s: string, v: any) => { if (s.includes("VerifyExplicitIdentityCoverage") && s.includes("isArchived: false")) clock.advance(39000); return q(s, v); };
  const h = await f.read(), e = eventFor(inspectNotificationSource(h));
  clock.advance(21000);
  assert.throws(() => composeNotificationEvidence(h, e, externalFor(e)), /expired/);
}));

async function withGhlConfig(run: () => Promise<void>) {
  const location = process.env.GHL_LOCATION_ID, key = process.env.GHL_API_KEY;
  process.env.GHL_LOCATION_ID = "location"; process.env.GHL_API_KEY = "synthetic-not-a-real-key";
  try { await run(); } finally {
    if (location === undefined) delete process.env.GHL_LOCATION_ID; else process.env.GHL_LOCATION_ID = location;
    if (key === undefined) delete process.env.GHL_API_KEY; else process.env.GHL_API_KEY = key;
  }
}

test("deployed contact binding uses bounded read-only search and retains all secondary identity witnesses", () => withClock(async () => withGhlConfig(async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), "https://services.leadconnectorhq.com/contacts/search");
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("Version"), "2021-07-28");
    const body = JSON.parse(String(init?.body)); assert.equal(body.locationId, "location"); assert.equal(body.pageLimit, 100);
    assert.equal(body.fastPagination, false); assert.deepEqual(body.sort, [{ field: "dateAdded", direction: "asc" }]);
    if (calls === 1) {
      assert.equal(body.page, 1); assert.equal(body.searchAfter, undefined);
      return Response.json({ total: 2, contacts: [{ id: "first", locationId: "location", email: "owner@example.test", phone: "+16025550100",
        additionalEmails: [{ email: "secondary@example.test" }, { email: "other@example.test" }],
        additionalPhones: [{ phone: "+16025550101" }, { phone: "malformed witness retained" }], searchAfter: [123, "cursor"] }] });
    }
    assert.equal(body.page, undefined); assert.deepEqual(body.searchAfter, [123, "cursor"]);
    return Response.json({ total: 2, contacts: [{ id: "second", locationId: "location" }] });
  };
  const io = await deployedNotificationSourceReadBindings({ query: async () => ({}) }, { fetch: fetcher });
  assert.equal(calls, 0); const contacts = await io.contacts(); assert.equal(calls, 2);
  assert.deepEqual(contacts[0].additionalEmails, [{ email: "secondary@example.test" }, { email: "other@example.test" }]);
  assert.deepEqual(contacts[0].additionalPhones, [{ phone: "+16025550101" }, { phone: "malformed witness retained" }]);
  assert.equal(contacts.length, 2); assert.equal((contacts[0] as any).locationId, "location");
})));

for (const kind of ["malformed primary", "malformed secondary", "redirect", "429", "oversized header", "wrong location", "missing cursor", "runtime deadline"])
  test(`bounded deployed contact binding rejects ${kind} without retry or dropping witnesses`, () => withClock(async clock => withGhlConfig(async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      if (kind === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.invalid" } });
      if (kind === "429") return new Response("synthetic", { status: 429 });
      if (kind === "oversized header") return new Response("{}", { headers: { "content-type": "application/json", "content-length": "3000001" } });
      if (kind === "runtime deadline") clock.advance(60000);
      const contact: any = { id: "contact", locationId: kind === "wrong location" ? "other" : "location", email: "owner@example.test", phone: "+16025550100" };
      if (kind === "malformed primary") contact.phone = { number: "+16025550100" };
      if (kind === "malformed secondary") contact.additionalPhones = [{ phone: "+16025550101" }, { phone: null }];
      return Response.json({ total: kind === "missing cursor" ? 2 : 1, contacts: [contact] });
    };
    const io = await deployedNotificationSourceReadBindings({ query: async () => ({}) }, { fetch: fetcher });
    await assert.rejects(io.contacts()); assert.equal(calls, 1);
  })));

test("changed deployed GHL configuration holds without provider IO", () => withClock(async () => withGhlConfig(async () => {
  let calls = 0;
  const io = await deployedNotificationSourceReadBindings({ query: async () => ({}) }, { fetch: async () => { calls++; return Response.json({}); } });
  process.env.GHL_LOCATION_ID = "other"; await assert.rejects(io.contacts(), /configuration changed/); assert.equal(calls, 0);
})));


test("new metadata cannot masquerade as a new invoice read from the same source handle", () => withClock(async clock => {
  const f = fixture(), q = f.io.query; let delayed = false;
  (f.io as any).query = async (s: string, v: any) => {
    if (!delayed) { delayed = true; clock.advance(39000); }
    return q(s, v);
  };
  const h = await f.read(), snapshot = inspectNotificationSource(h), e = eventFor(snapshot);
  const pre = externalFor(e);
  (pre.metadata as any).observedAt = new Date(NOW + 38000).toISOString();
  const preflight = composeNotificationEvidence(h, e, pre).evidence;
  clock.advance(1000);
  const final = composeNotificationEvidence(h, e, externalFor(e)).evidence;
  assert.equal(f.calls.filter(q => q.includes("VerifyDateOwnerInvoices")).length, 1);
  assert.equal(preflight.source.observedAt, snapshot.observedAt);
  assert.equal(final.source.observedAt, snapshot.observedAt);
  const held = planNotification({ event: e, preflight, final }, new Date(Date.now()));
  assert.equal(held.designStatus, "hold");
  assert.ok(held.reasons.includes("final:source_not_newer_than_preflight"), held.reasons.join(","));
  // A real complete invoice/identity recheck still advances the source observation.
  const next = await refreshNotificationSource(h);
  const refreshed = composeNotificationEvidence(next, e, externalFor(e)).evidence;
  assert.equal(f.calls.filter(q => q.includes("VerifyDateOwnerInvoices")).length, 2);
  const allowedInProposal = planNotification({ event: e, preflight, final: refreshed }, new Date(Date.now()));
  assert.equal(allowedInProposal.designStatus, "eligible_in_proposal", allowedInProposal.reasons.join(","));
  assert.equal(allowedInProposal.sendCapability, false);
}));

test("already-composed evidence expires at the oldest exact check without being recomposed", () => withClock(async clock => {
  const f = fixture(), q = f.io.query; let delayed = false;
  (f.io as any).query = async (s: string, v: any) => {
    if (!delayed) { delayed = true; clock.advance(39000); }
    return q(s, v);
  };
  const h = await f.read(), first = inspectNotificationSource(h), e = eventFor(first);
  const preflight = composeNotificationEvidence(h, e, externalFor(e)).evidence;
  assert.equal(first.observedAt, new Date(NOW + 39000).toISOString());
  assert.equal(first.expiresAt, new Date(NOW + 60000).toISOString());
  assert.equal(preflight.source.expiresAt, first.expiresAt);
  clock.advance(1000);
  const next = await refreshNotificationSource(h), second = inspectNotificationSource(next);
  const final = composeNotificationEvidence(next, e, externalFor(e)).evidence;
  assert.equal(second.expiresAt, new Date(NOW + 100000).toISOString());
  assert.equal(planNotification({ event: e, preflight, final }, new Date(Date.now())).designStatus, "eligible_in_proposal");
  clock.advance(20000); // Initial cache proof reached 60s; source read itself is only 21s old.
  const plan = planNotification({ event: e, preflight, final }, new Date(Date.now()));
  assert.equal(plan.designStatus, "hold");
  assert.ok(plan.reasons.includes("preflight:source_proof_not_fresh"), plan.reasons.join(","));
  assert.equal(final.owner.expiresAt, new Date(NOW + 300000).toISOString());
}));

test("composed expiry includes metadata observation age even when metadata claims a longer expiry", () => withClock(async clock => {
  const f = fixture(), h = await f.read(), e = eventFor(inspectNotificationSource(h));
  const x = externalFor(e);
  (x.metadata as any).observedAt = new Date(NOW - 50000).toISOString();
  (x.metadata as any).expiresAt = new Date(NOW + 300000).toISOString();
  const preflight = composeNotificationEvidence(h, e, x).evidence;
  assert.equal(preflight.source.observedAt, new Date(NOW).toISOString());
  assert.equal(preflight.source.expiresAt, new Date(NOW + 10000).toISOString());
  clock.advance(1000);
  const next = await refreshNotificationSource(h), final = composeNotificationEvidence(next, e, externalFor(e)).evidence;
  assert.equal(planNotification({ event: e, preflight, final }, new Date(Date.now())).designStatus, "eligible_in_proposal");
  clock.advance(9000);
  const plan = planNotification({ event: e, preflight, final }, new Date(Date.now()));
  assert.ok(plan.reasons.includes("preflight:source_proof_not_fresh"), plan.reasons.join(","));
  assert.equal(plan.designStatus, "hold");
}));
