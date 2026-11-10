import test from "node:test";
import assert from "node:assert/strict";
import { readNotificationInventory, inspectNotificationInventory, planNotificationInventory, notificationRequestFromInventory,
  readDiscoveredNotificationSource, deployedNotificationInventoryReadBindings, type NotificationInventoryIO } from "../lib/notification-inventory";
import { readNotificationSourceBatch, inspectNotificationSourceBatch, resolveNotificationBatchOwner, readNotificationSource,
  readNotificationSourceFromBatch, inspectNotificationSource, refreshNotificationSource, type NotificationRecurringSourceIO } from "../lib/notification-source";
import { readReviewedIdentityInventory, inspectReviewedIdentityInventory, reviewedIdentityOwnerEvidence, bindReviewedIdentityInvoice,
  coveragePermitsExactInvoice, type ReviewedOmissionPolicy } from "../lib/ghl-identity-coverage";
import { GhlReadonlyReader, GHL_ORIGIN, assertReadOnlyRequest } from "../scripts/ghl-preview/transport";

const NOW = Date.parse("2026-11-10T16:00:00.000Z");
async function clock(run: (advance: (ms: number) => void) => Promise<void>) {
  const real = Date.now; let at = NOW; Date.now = () => at;
  try { await run(ms => { at += ms; }); } finally { Date.now = real; }
}
function fixture() {
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

test("full account discovery feeds real planner, preserves multiple invoices and creates genuine exact capabilities", () => clock(async () => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch(), result = planNotificationInventory(inventory, batch);
  assert.equal(result.inventory.coverage, "complete-account-invoices"); assert.equal(result.inventory.invoiceCount, 3);
  assert.equal(Object.hasOwn(result.inventory, "failure"), false);
  assert.deepEqual(result.excluded, [{ invoiceId: "old-paid", reasons: ["paid_no_reminder"] }]);
  assert.equal(result.worklist.homeowner.filter(row => row.dayPastDue === 10).length, 2);
  assert.equal(result.worklist.homeowner.every(row => row.dispatchEligible === false), true);
  assert.equal(result.worklist.homeowner.filter(row => row.dayPastDue === 10).every(row => row.category === null && row.requiredFacts.length === 0), true);
  assert.equal(result.worklist.contactDayConflicts.length, 5);
  assert.equal(result.inventory.identityVerified, false); assert.equal(result.productionSendCapability, false);
  const a = await readDiscoveredNotificationSource(inventory, batch, "invoice-a");
  const b = await readDiscoveredNotificationSource(inventory, batch, "invoice-b");
  assert.equal(inspectNotificationSource(a).invoiceId, "invoice-a"); assert.equal(inspectNotificationSource(b).invoiceId, "invoice-b");
  assert.equal(inspectNotificationSource(b).currency, null); assert.equal(inspectNotificationSource(b).productionSendCapability, false);
  assert.equal(f.counts.customers, 1); assert.equal(f.counts.contacts, 1);
  assert.equal(f.calls.filter(row => row.q.includes("VerifyExplicitIdentityCoverage")).length, 2);
  assert.equal(f.counts.customer, 2); assert.equal(f.counts.contact, 2);
  assert.equal(f.calls.filter(row => row.q.includes("VerifyExactCoverageOwnerInvoice")).length, 2);
  assert.equal(f.calls.filter(row => row.q.includes("VerifyDateOwnerInvoices")).length, 2);
  assert.deepEqual(f.calls[0].options, { maxAttempts: 3, deadlineAt: NOW + 840000, notificationReadRateLimit: true });
  assert.ok(f.calls.filter(row => row.q.includes("VerifyExplicitIdentityCoverage"))
    .every(row => row.options.deadlineAt === NOW + 300000));
  assert.ok(f.calls.filter(row => row.q.includes("VerifyExactCoverageOwnerInvoice") || row.q.includes("VerifyDateOwnerInvoices"))
    .every(row => row.options.deadlineAt === NOW + 60000));
}));

test("fresh exact reread retains original population lifetime without full rescans", () => clock(async advance => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch();
  const first = await readDiscoveredNotificationSource(inventory, batch, "invoice-a"), before = inspectNotificationSource(first);
  advance(61000); assert.throws(() => inspectNotificationSource(first), /expired/);
  const next = await refreshNotificationSource(first), after = inspectNotificationSource(next);
  assert.equal(after.identityObservedAt, before.identityObservedAt); assert.equal(after.identityExpiresAt, before.identityExpiresAt);
  assert.equal(after.ownerRevision, before.ownerRevision); assert.equal(after.identitySourceRef, before.identitySourceRef);
  assert.equal(after.observedAt, new Date(NOW + 61000).toISOString());
  assert.deepEqual(f.counts, { customers: 1, contacts: 1, customer: 2, contact: 2 });
  advance(239000); await assert.rejects(refreshNotificationSource(next), /expired/);
  assert.equal(f.counts.contacts, 1);
}));

test("legacy source entry rejects v2 before IO and retains the pilot singleton constraint", () => clock(async () => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch(), request = notificationRequestFromInventory(inventory, batch, "invoice-a");
  const before = f.calls.length;
  await assert.rejects(readNotificationSource(request as any, f.sourceIO), /version 1/); assert.equal(f.calls.length, before);
  await assert.rejects(readNotificationSource({ ...request, version: 1 }, f.sourceIO), /invoice set/);
}));

for (const kind of ["account", "second-page-account", "duplicate-id", "missing-cursor", "repeat-cursor", "empty-continuation", "missing-pageinfo", "oversize-page", "denial", "deadline", "location-drift"])
  test(`account discovery is explicitly held for ${kind}`, () => clock(async advance => {
    const f = fixture(); f.data.invoices = Array.from({ length: 30 }, (_, i) => f.invoice(`invoice-${i}`));
    const query = f.inventoryIO.query; let count = 0;
    (f.inventoryIO as any).query = async (q: string, vars: any, options: any) => {
      count++;
      if (kind === "denial") throw new Error("synthetic provider failure containing private text");
      const data: any = await query(q, vars, options);
      if (kind === "account" || kind === "second-page-account" && count === 2) data.account.id = "other";
      if (kind === "duplicate-id" && count === 2) data.invoices.nodes[0].id = "invoice-0";
      if (kind === "missing-cursor") data.invoices.pageInfo.endCursor = null;
      if (kind === "repeat-cursor" && count === 2) data.invoices.pageInfo.endCursor = "25";
      if (kind === "empty-continuation" && count === 2) data.invoices.nodes = [];
      if (kind === "missing-pageinfo") delete data.invoices.pageInfo;
      if (kind === "oversize-page") data.invoices.nodes.push(f.invoice("extra"));
      if (kind === "deadline") advance(840000);
      if (kind === "location-drift") f.data.location = "other";
      return data;
    };
    const handle = await f.scan(), snapshot = inspectNotificationInventory(handle);
    assert.equal(snapshot.coverage, "partial-held"); assert.equal(snapshot.terminalPageObserved, false);
    assert.equal(snapshot.rows.length, 0); assert.equal(snapshot.holds.length, 1);
    const expected: Record<string, string> = { account: "INVENTORY_ACCOUNT_CHANGED", "second-page-account": "INVENTORY_ACCOUNT_CHANGED",
      "duplicate-id": "SOURCE_ID_REPEATED", "missing-cursor": "SOURCE_CURSOR_MISSING", "repeat-cursor": "SOURCE_CURSOR_REPEATED",
      "empty-continuation": "SOURCE_EMPTY_CONTINUATION", "missing-pageinfo": "SOURCE_PAGE_MALFORMED", "oversize-page": "SOURCE_PAGE_OVERSIZE",
      denial: "INVENTORY_UNEXPECTED_FAILURE", deadline: "INVENTORY_SCOPE_OR_DEADLINE", "location-drift": "INVENTORY_SCOPE_OR_DEADLINE" };
    assert.equal(snapshot.failure?.code, expected[kind]);
    if (kind === "duplicate-id") assert.deepEqual(snapshot.failure?.facts, { pages: 1, invoices: 25 });
    assert.equal(JSON.stringify(snapshot).includes("private text"), false);
    if (!["deadline", "location-drift"].includes(kind)) {
      const batch = await f.batch(); const result = planNotificationInventory(handle, batch);
      assert.equal(result.worklist.homeowner.length, 0); assert.equal(result.holds.length, 1);
      assert.throws(() => notificationRequestFromInventory(handle, batch, "invoice-0"), /Complete/);
    }
  }));

for (const remaining of [NaN, -1, 30000, 899999]) test(`900-second token guard rejects ${remaining} without query or refresh`, () => clock(async () => {
  const f = fixture(); f.data.tokenRemaining = remaining;
  await assert.rejects(f.scan()); assert.equal(f.calls.length, 0);
}));

test("more than 1000 historical paid invoices do not truncate discovery or block two current invoices", () => clock(async () => {
  const f = fixture(); f.data.invoices.push(...Array.from({ length: 1001 }, (_, i) => f.invoice(`paid-${i}`, "paid", 0)));
  const inventory = await f.scan(), batch = await f.batch(), result = planNotificationInventory(inventory, batch);
  assert.equal(result.inventory.invoiceCount, 1004); assert.equal(result.inventory.pages, 41);
  assert.equal(result.excluded.length, 1002); assert.equal(result.worklist.invoiceCount, 2); assert.equal(result.holds.length, 0);
}));
test("more than 1000 open rows holds entire planner input rather than silently selecting a subset", () => clock(async () => {
  const f = fixture(); f.data.invoices = Array.from({ length: 1001 }, (_, i) => f.invoice(`invoice-${i}`));
  const result = planNotificationInventory(await f.scan(), await f.batch());
  assert.equal(result.inventory.invoiceCount, 1001); assert.deepEqual(result.holds, ["open_invoice_worklist_limit"]);
  assert.equal(result.worklist.homeowner.length, 0); assert.deepEqual(result.worklist.batchHolds, ["invoice_input_limit_or_shape"]);
}));
test("source 12500-record ceiling holds overflow instead of certifying complete coverage", () => clock(async () => {
  const f = fixture(); f.data.invoices = Array.from({ length: 12501 }, (_, i) => f.invoice(`invoice-${i}`));
  const result = inspectNotificationInventory(await f.scan());
  assert.equal(result.coverage, "partial-held"); assert.equal(result.rows.length, 0); assert.equal(result.pages, 500);
  assert.deepEqual(result.failure, { code: "SOURCE_PAGE_LIMIT", facts: { pages: 500, invoices: 12500 } });
}));

for (const [kind, mutate] of Object.entries({
  "negative balance": (i: any) => { i.amounts.invoiceBalance = -1; }, "missing amount": (i: any) => { delete i.amounts.total; },
  "subcent": (i: any) => { i.amounts.invoiceBalance = 0.001; }, "paid positive": (i: any) => { i.invoiceStatus = "paid"; },
  "unknown status": (i: any) => { i.invoiceStatus = "refunded"; }, "owner missing": (i: any) => { i.client = null; },
  "invalid due date": (i: any) => { i.dueDate = "2026-02-30"; }, "missing issued": (i: any) => { i.issuedDate = null; },
  "balance exceeds total": (i: any) => { i.amounts.invoiceBalance = 138; },
})) test(`discovery preserves visible held row for ${kind}`, () => clock(async () => {
  const f = fixture(); mutate(f.data.invoices[1]); const inventory = await f.scan(), batch = await f.batch();
  assert.equal(inspectNotificationInventory(inventory).coverage, "complete-account-invoices");
  const result = planNotificationInventory(inventory, batch); assert.equal(result.excluded.some(row => row.invoiceId === "invoice-a"), true);
  assert.throws(() => notificationRequestFromInventory(inventory, batch, "invoice-a"), /held/);
}));

for (const kind of ["cached-owner-drift", "contact-drift", "contact-location", "quarantine-link", "source-owner-drift", "source-account-drift", "source-total-drift", "source-date-drift", "cache-omission", "duplicate-cache"])
  test(`exact source binding holds ${kind} without accepting discovery as send proof`, () => clock(async () => {
    const f = fixture(), inventory = await f.scan(), batch = await f.batch();
    if (kind === "cached-owner-drift") f.data.customers[0].phone = "+16025550101";
    if (kind === "contact-drift") f.data.contacts[0].phone = "+16025550101";
    if (kind === "contact-location") f.data.contacts[0].locationId = "other";
    if (kind === "quarantine-link") f.data.counts[0].invoices = 1;
    if (kind === "source-owner-drift") f.data.active[0].emails[0].address = "changed@example.test";
    if (kind === "source-account-drift") f.data.account = "other";
    if (kind === "source-total-drift") f.data.invoices[1].amounts.total = 138;
    if (kind === "source-date-drift") f.data.invoices[1].dueDate = "2026-10-30";
    if (kind === "cache-omission") f.data.stored.push({ jobberInvoiceId: "omitted" });
    if (kind === "duplicate-cache") f.data.stored.push(f.data.stored[0]);
    await assert.rejects(readDiscoveredNotificationSource(inventory, batch, "invoice-a"));
  }));

test("payment since discovery is freshly visible and cannot remain open", () => clock(async () => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch();
  f.data.invoices[1].invoiceStatus = "paid"; f.data.invoices[1].amounts.invoiceBalance = 0;
  const source = inspectNotificationSource(await readDiscoveredNotificationSource(inventory, batch, "invoice-a"));
  assert.equal(source.status, "paid"); assert.equal(source.balanceMinor, 0);
}));

test("new invoice under cached owner needs no invented manual invoice approval or cache singleton", () => clock(async () => {
  const f = fixture(); f.data.invoices.push(f.invoice("new-cycle"));
  const inventory = await f.scan(), batch = await f.batch();
  const source = inspectNotificationSource(await readDiscoveredNotificationSource(inventory, batch, "new-cycle"));
  assert.equal(source.invoiceId, "new-cycle"); assert.equal(source.issuedDate, "2026-10-20");
  const plan = planNotificationInventory(inventory, batch); assert.equal(new Set(plan.worklist.homeowner.filter(row => row.dayPastDue === 10).map(row => row.eventKey)).size, 3);
}));

for (const kind of ["new-owner", "secondary-contact-collision", "quarantined-collision", "source-secondary-collision"])
  test(`genuine account discovery retains ${kind} as an owner hold`, () => clock(async () => {
    const f = fixture();
    if (kind === "new-owner") { f.data.invoices[1].client.id = "new-owner"; f.data.active.push({ id: "new-owner", emails: [], phones: [] }); }
    if (kind === "secondary-contact-collision") f.data.contacts.push({ id: "other", locationId: "location", additionalEmails: [{ email: f.owner.email }] });
    if (kind === "quarantined-collision") { f.data.customers[1].phone = f.owner.phone; (f.policy.quarantine[0] as any).phone = f.owner.phone; }
    if (kind === "source-secondary-collision") f.data.active.push({ id: "other-owner", emails: [{ address: f.owner.email, primary: false }], phones: [] });
    const inventory = await f.scan(), batch = await f.batch(), plan = planNotificationInventory(inventory, batch);
    assert.equal(plan.inventory.invoiceCount, 3); assert.ok(plan.ownerHolds.some(row => row.invoiceId === "invoice-a"));
    assert.throws(() => notificationRequestFromInventory(inventory, batch, "invoice-a"), /unresolved/);
  }));

for (const kind of ["quarantine-reappears", "new-omission", "linked-quarantine", "population-account", "duplicate-population", "malformed-contact"])
  test(`batch fails closed on ${kind}`, () => clock(async () => {
    const f = fixture();
    if (kind === "quarantine-reappears") f.data.reappears = true;
    if (kind === "new-omission") f.data.customers.push({ jobberClientId: "new-missing" });
    if (kind === "linked-quarantine") f.data.counts[0].jobs = 1;
    if (kind === "population-account") f.data.account = "other";
    if (kind === "duplicate-population") f.data.archived.push(f.data.active[0]);
    if (kind === "malformed-contact") f.data.contacts[0].additionalPhones = [null];
    await assert.rejects(f.batch());
  }));

test("forged or serialized inventory, population and owner-only proof cannot mint exact source identity", () => clock(async () => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch();
  for (const forged of [{}, structuredClone(inventory), inspectNotificationInventory(inventory)]) {
    assert.throws(() => notificationRequestFromInventory(forged as any, batch, "invoice-a"), /Unissued/);
  }
  for (const forged of [{}, structuredClone(batch), inspectNotificationSourceBatch(batch)]) {
    assert.throws(() => resolveNotificationBatchOwner(forged as any, "owner"), /Unissued/);
  }
  const handle = await readReviewedIdentityInventory(f.policy, f.data.customers, async () => f.data.counts, f.sourceIO.query);
  const population = inspectReviewedIdentityInventory(handle), proof = reviewedIdentityOwnerEvidence(handle, "owner");
  assert.equal(coveragePermitsExactInvoice(proof, population.customers, population.identities, { jobberClientId: "owner", invoiceId: "invoice-a" }), false);
  await assert.rejects(bindReviewedIdentityInvoice(population as any, { jobberClientId: "owner", invoiceId: "invoice-a" }, f.sourceIO.query), /Unissued/);
  const bound = await bindReviewedIdentityInvoice(handle, { jobberClientId: "owner", invoiceId: "invoice-a" }, f.sourceIO.query);
  assert.equal(coveragePermitsExactInvoice(bound, population.customers, population.identities, { jobberClientId: "owner", invoiceId: "invoice-a" }), true);
  assert.equal(coveragePermitsExactInvoice(bound, population.customers, population.identities, { jobberClientId: "owner", invoiceId: "invoice-b" }), false);
}));

test("slow exact reads cannot relabel stale cache/contact evidence or extend population expiry", () => clock(async advance => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch(), original = f.sourceIO.contact;
  // The IO functions were frozen by batch creation; configure the delegate before creating a new batch.
  (f.sourceIO as any).contact = async (id: string) => { advance(60000); return original(id); };
  const slowBatch = await f.batch(), priorOwnerReads = f.calls.filter(row => row.q.includes("VerifyDateOwnerInvoices")).length;
  await assert.rejects(readDiscoveredNotificationSource(inventory, slowBatch, "invoice-a"), /PROBE_TIME_LIMIT/);
  assert.equal(f.calls.filter(row => row.q.includes("VerifyDateOwnerInvoices")).length, priorOwnerReads,
    "expired contact/cache evidence must prevent a later owner-invoice read");
  assert.equal(inspectNotificationSourceBatch(batch).expiresAt, new Date(NOW + 300000).toISOString());
}));
test("09:15 boundary is missed without catch-up even with new current source reads", () => clock(async advance => {
  const f = fixture(); advance(15 * 60000);
  f.request.expiresAt = new Date(Date.now() + 900000).toISOString(); f.policy.reviewedAt = new Date(Date.now()).toISOString(); f.policy.expiresAt = f.request.expiresAt;
  const plan = planNotificationInventory(await f.scan(), await f.batch());
  assert.equal(plan.worklist.homeowner.filter(row => row.dayPastDue === 10).every(row => row.timing === "missed_no_catch_up"), true);
}));

test("deployed read binding construction is inert and rejects token-expiry shortage before provider read", () => clock(async () => {
  let calls = 0;
  const bindings = await deployedNotificationInventoryReadBindings({ query: async () => { calls++; throw new Error("must not read"); } }, { tokenExpiresAt: new Date(NOW + 899999), fetch: async () => { calls++; throw new Error("must not fetch"); } });
  assert.equal(calls, 0); assert.equal(bindings.inventoryIO.tokenExpiresAt().getTime(), NOW + 899999);
}));

for (const kind of ["ok", "wrong-location", "wrong-id", "redirect", "403", "malformed", "oversize"])
  test(`bounded exact contact GET ${kind} remains read-only and no-retry`, () => clock(async () => {
    let calls = 0;
    const reader = new GhlReadonlyReader({ locationId: "location", apiKey: "synthetic-only", fetch: async (input, init) => {
      calls++; assert.equal(String(input), `${GHL_ORIGIN}/contacts/contact`); assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "manual");
      if (kind === "redirect") return new Response(null, { status: 302 });
      if (kind === "403") return new Response(null, { status: 403 });
      return new Response(JSON.stringify({ contact: kind === "malformed" ? null : { id: kind === "wrong-id" ? "other" : "contact",
        locationId: kind === "wrong-location" ? "other" : "location" } }), { headers: { "content-type": "application/json", ...(kind === "oversize" ? { "content-length": "3000001" } : {}) } });
    } });
    if (kind === "ok") assert.equal((await reader.request("/contacts/contact")).contact !== undefined, true);
    else await assert.rejects(reader.request("/contacts/contact"));
    assert.equal(calls, 1);
  }));
for (const path of ["/contacts/search", "/contacts/id/workflow", "/contacts/id?locationId=other", "/contacts/id?extra=1", "/contacts/id%2Fother"])
  test(`exact contact route rejects ${path}`, () => assert.throws(() => assertReadOnlyRequest(new URL(path, GHL_ORIGIN), "GET")));

for (const [tags, category, maintenance] of [[["irrigation"], "irrigation", false], [[], "maintenance", true],
  [["maintenance", "irrigation"], "irrigation", false], [["Irrigation"], null, true], [null, null, true], [[null], null, true]] as const)
  test(`only genuine exact-contact tags contribute branch ${JSON.stringify(tags)}`, () => clock(async () => {
    const f = fixture(); f.data.contacts[0].tags = tags;
    const inventory = await f.scan(), batch = await f.batch(), source = await readDiscoveredNotificationSource(inventory, batch, "invoice-a");
    const plan = planNotificationInventory(inventory, batch, [source]), rows = plan.worklist.homeowner.filter(row => row.invoiceId === "invoice-a");
    assert.equal(rows[0].category, category); assert.equal(rows.some(row => row.dayPastDue === 20), maintenance);
    assert.equal(rows.find(row => row.dayPastDue === 10)!.requiredFacts.length, 0);
    if (category === null) assert.ok(rows.find(row => row.dayPastDue === 20)!.planningHolds.includes("maintenance_contact_tag_branch_unresolved"));
    assert.equal(rows.every(row => row.dispatchEligible === false), true);
    // Untouched second invoice does not inherit tag evidence from a neighboring invoice handle.
    assert.equal(plan.worklist.homeowner.find(row => row.invoiceId === "invoice-b")!.category, null);
  }));
test("source-handle planning projects fresh payment rather than stale discovery balance", () => clock(async () => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch();
  f.data.invoices[1].invoiceStatus = "paid"; f.data.invoices[1].amounts.invoiceBalance = 0;
  const source = await readDiscoveredNotificationSource(inventory, batch, "invoice-a");
  const result = planNotificationInventory(inventory, batch, [source]);
  assert.equal(result.worklist.homeowner.some(row => row.invoiceId === "invoice-a"), false);
  assert.equal(result.worklist.invoiceHolds.find(row => row.invoiceId === "invoice-a")!.reason, "paid_zero_balance_no_reminder");
  assert.throws(() => planNotificationInventory(inventory, batch, [inspectNotificationSource(source) as any]), /Unissued/);
  assert.throws(() => planNotificationInventory(inventory, batch, [source, source]), /unique/);
}));

test("875-owner / 1436-contact population is read once for several invoice bindings and final rereads", () => clock(async advance => {
  const f = fixture();
  for (let i = 1; i < 875; i++) {
    f.data.active.push({ id: `owner-${i}`, emails: [], phones: [] });
    f.data.customers.push({ jobberClientId: `owner-${i}`, email: null, phone: null });
  }
  for (let i = 1; i < 1436; i++) f.data.contacts.push({ id: `contact-${i}`, locationId: "location" });
  const inventory = await f.scan(), batch = await f.batch();
  const original = await readDiscoveredNotificationSource(inventory, batch, "invoice-a");
  await readDiscoveredNotificationSource(inventory, batch, "invoice-b"); advance(1000); await refreshNotificationSource(original);
  assert.equal(f.calls.filter(row => row.q.includes("isArchived: false")).length, 35);
  assert.equal(f.calls.filter(row => row.q.includes("isArchived: true")).length, 1);
  assert.deepEqual(f.counts, { customers: 1, contacts: 1, customer: 3, contact: 3 });
  assert.equal(inspectNotificationSourceBatch(batch).sourceOwnerCount, 875);
  assert.equal(inspectNotificationSourceBatch(batch).contactCount, 1436);
}));
test("shorter generated request expiry bounds already-issued source proof and cannot be renewed", () => clock(async advance => {
  const f = fixture(), inventory = await f.scan(), batch = await f.batch();
  const generated = notificationRequestFromInventory(inventory, batch, "invoice-a");
  const request = { ...generated, expiresAt: new Date(NOW + 30000).toISOString() };
  const source = await readNotificationSourceFromBatch(batch, request);
  assert.equal(inspectNotificationSource(source).expiresAt, request.expiresAt);
  assert.equal(inspectNotificationSource(source).identityExpiresAt, request.expiresAt);
  advance(30000); assert.throws(() => inspectNotificationSource(source), /expired/); await assert.rejects(refreshNotificationSource(source), /expired/);
}));
