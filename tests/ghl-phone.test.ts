import test from "node:test";
import { writerFixture } from "./helpers/sync-writer-fixture";
import assert from "node:assert/strict";
import { canonicalPhone, matchPhoneCustomer } from "../lib/ghl-phone-match";
import { listContactsForPhoneMatching, findSinglePhoneOpportunity } from "../lib/ghl";
import { phoneExitStage, readPhoneInvoiceEvidence, PhoneInvoiceEvidence } from "../lib/ghl-phone-state";
import { prisma } from "../lib/prisma";
import { syncGhlInvoicePipeline as reconcileGhl } from "../lib/sync";
const syncGhlInvoicePipeline = () => reconcileGhl({ writer: writerFixture().writer });

process.env.GHL_API_KEY = "synthetic-test-only";
process.env.GHL_LOCATION_ID = "test-location";
process.env.CLEANUP_INVALID_OPPS = "true";
process.env.GHL_INVOICE_WRITE_MODE = "sync";
process.env.GHL_PHONE_WRITES_ENABLED = "true";
process.env.GHL_WRITE_APPROVAL_ID = "synthetic-reviewed-plan";
process.env.GHL_APPROVED_OPPORTUNITY_IDS = JSON.stringify(["card-a"]);
const customer = { id: "local-a", jobberClientId: "jobber-a", email: null, phone: "+1 (602) 555-0100", name: "Synthetic" };
const contact = { id: "contact-a", phone: "+16025550100", email: null };
const opportunity = { id: "card-a", contactId: contact.id, pipelineId: "pipeline", pipelineStageId: "sent", status: "open", monetaryValue: 100, name: "Invoice #123" };
let writes: any[];
let sourceEvidence: any[] = [];
(prisma.jobberAuth as any).findFirst = async () => ({ accessToken: "synthetic-jobber-token", expiresAt: new Date(Date.now() + 3600000) });
function mock(contacts: any[] = [contact], opportunities: any[] = [opportunity], failSnapshot = false) {
  writes = [];
  opportunities = structuredClone(opportunities);
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.getjobber.com" && JSON.parse(init.body).query.includes("VerifyGhlIdentityOwnership")) {
      const owners = await prisma.customer.findMany();
      return Response.json({ data: { clients: { nodes: owners.map(c => ({ id: c.jobberClientId,
        emails: c.email ? [{ address: c.email, primary: true }] : [], phones: c.phone ? [{ number: c.phone, primary: true }] : [] })),
        pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (url.hostname === "api.getjobber.com") return Response.json({ data: { invoices: {
      nodes: sourceEvidence, pageInfo: { hasNextPage: false, endCursor: null }
    } } });
    if (url.pathname === "/contacts/search") {
      assert.equal(init.method, "POST");
      return Response.json({ contacts, ...(failSnapshot ? {} : { total: contacts.length }) });
    }
    if (init.method && init.method !== "GET") {
      const body = JSON.parse(init.body || "{}");
      writes.push({ path: url.pathname, method: init.method, body });
      const target = opportunities.find(o => o.id === url.pathname.split("/").pop());
      if (target) Object.assign(target, body);
      return Response.json({ opportunity: target });
    }
    if (url.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "pipeline", name: "Invoice Pipeline", stages: [
      { id: "sent", name: "Invoice Sent" }, { id: "overdue", name: "Invoice Overdue" }, { id: "paid", name: "Invoice Paid" },
    ] }] });
    if (url.pathname.startsWith("/opportunities/") && url.pathname !== "/opportunities/search") {
      return Response.json({ opportunity: opportunities.find(o => o.id === url.pathname.split("/").pop()) });
    }
    if (url.pathname === "/contacts/") return Response.json({ contacts });
    if (url.pathname === "/opportunities/search") return Response.json({ opportunities, meta: { total: opportunities.length } });
    throw new Error(`Unexpected synthetic request: ${url}`);
  };
}
function database(customers: any[] = [customer], status = "past_due") {
  sourceEvidence = customers.map((c, i) => ({ id: `jobber-inv-${i}`, client: { id: c.jobberClientId },
    invoiceStatus: status, amounts: { total: 100, invoiceBalance: status === "paid" ? 0 : 100 },
    issuedDate: "2026-05-01", createdAt: null, dueDate: "2026-06-01" }));
  (prisma.customer as any).findMany = async () => customers;
  (prisma.invoiceRecord as any).findMany = async ({ where }: any) => {
    const rows = customers.map((c, i) => ({ id: `inv-${i}`, jobberInvoiceId: `jobber-inv-${i}`, customerId: c.id, customer: c, invoiceNumber: "123", clientName: "Synthetic", invoiceStatus: status,
      issuedAt: new Date("2026-05-01"), createdAtJobber: null, dueAt: new Date("2026-06-01"), amountDue: 100, total: 100 }));
    return where?.invoiceStatus ? rows.filter(r => r.invoiceStatus === where.invoiceStatus) : rows;
  };
}

test("canonical exact phone with confirmed US local formats, no extension guesses", () => {
  assert.equal(canonicalPhone(customer.phone), contact.phone);
  assert.equal(canonicalPhone("(602) 555-0100"), contact.phone);
  assert.equal(canonicalPhone("1-602-555-0100"), contact.phone);
  assert.equal(canonicalPhone("+44 20 7946 0958"), "+442079460958");
  for (const phone of ["5550100", "0016025550100", "+1 6025550100 x1", "+0123456789", "+1abc6025550100"]) assert.equal(canonicalPhone(phone), null);
});
test("stable source identity, exact unique match and conflicts", () => {
  assert.equal(matchPhoneCustomer(customer, [customer], [contact]).contactId, contact.id);
  assert.equal(matchPhoneCustomer(customer, [customer], [{ ...contact, phone: "+16025550101" }]).contactId, null);
  assert.equal(matchPhoneCustomer(customer, [customer], [contact, { ...contact, id: "duplicate" }]).contactId, null);
  const other = { ...customer, id: "local-b", jobberClientId: "jobber-b" };
  assert.equal(matchPhoneCustomer(customer, [customer, other], [contact]).contactId, null);
  assert.equal(matchPhoneCustomer(customer, [customer, { ...other, phone: null, email: "owner@example.test" }], [{ ...contact, email: "OWNER@example.test" }]).contactId, null);
});
test("contact snapshot requires completeness; opportunity requires single open card", async () => {
  mock(); assert.equal((await listContactsForPhoneMatching()).length, 1);
  mock([contact], [opportunity], true); await assert.rejects(listContactsForPhoneMatching());
  for (const rows of [[], [opportunity, { ...opportunity, id: "duplicate" }], [{ ...opportunity, status: "won" }], [{ ...opportunity, contactId: "other" }]]) {
    mock([contact], rows); assert.equal(await findSinglePhoneOpportunity(contact.id, "pipeline"), null);
  }
});
test("sync phone-only overdue stays held while recurring date integration is disabled", async () => {
  database(); mock(); await syncGhlInvoicePipeline();
  assert.equal(writes.length, 0);
});
test("awaiting with elapsed due date stays held without reviewed date-before-stage activation", async () => {
  database([customer], "awaiting_payment"); mock(); await syncGhlInvoicePipeline();
  assert.deepEqual(writes, []);
});
test("unknown or failed phone preflight aborts before any writes", async () => {
  for (const phone of ["5550100", "+16025550199"]) {
    database([{ ...customer, phone }]); mock(); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
  }
  database(); mock([contact], [opportunity], true); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("duplicate, special-stage and shared phone owners hold without cleanup writes", async () => {
  for (const opps of [[opportunity, { ...opportunity, id: "duplicate" }], [{ ...opportunity, pipelineStageId: "late-fee" }], [{ ...opportunity, status: "lost" }]]) {
    database(); mock([contact], opps); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
  }
  database([customer, { ...customer, id: "local-b", jobberClientId: "jobber-b" }]); mock(); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("US source and GHL formatting normalize consistently; shared owners hold", () => {
  assert.equal(matchPhoneCustomer(customer, [customer], [{ ...contact, phone: "6025550100" }]).contactId, contact.id);
  assert.equal(matchPhoneCustomer(customer, [customer], [contact, { ...contact, id: "domestic", phone: "6025550100" }]).contactId, null);
  assert.equal(matchPhoneCustomer(customer, [customer, { jobberClientId: "other", phone: "6025550100", email: "other@example.test" }], [contact]).contactId, null);
});
// Fixtures follow the pinned Search Contacts documented response:
// { contacts: [{ id, searchAfter: [number, string], ... }], total: number }.
test("documented search cursor and total produce a complete contact snapshot", async () => {
  let calls = 0;
  const cursor = [1730700000000, "contact-a"];
  globalThis.fetch = async (input: any, init: any) => {
    assert.equal(String(input), "https://services.leadconnectorhq.com/contacts/search");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Version, "2021-07-28");
    const body = JSON.parse(init.body);
    assert.equal(body.locationId, "test-location");
    assert.equal(body.fastPagination, false);
    assert.deepEqual(body.sort, [{ field: "dateAdded", direction: "asc" }]);
    if (++calls === 1) {
      assert.equal(body.page, 1); assert.equal(body.searchAfter, undefined);
      return Response.json({ contacts: [{ ...contact, searchAfter: cursor }], total: 2 });
    }
    assert.equal(body.page, undefined); assert.deepEqual(body.searchAfter, cursor);
    return Response.json({ contacts: [{ ...contact, id: "b", searchAfter: [1730700000001, "b"] }], total: 2 });
  };
  assert.equal((await listContactsForPhoneMatching()).length, 2);
  assert.equal(calls, 2);
});
test("documented contact pagination rejects missing/inconsistent pages, totals and cursors", async () => {
  const first = { contacts: [{ ...contact, searchAfter: [1, "a"] }], total: 2 };
  const invalidPages = [
    [{ contacts: [contact], count: 1 }], // Deprecated GET count is not accepted as total.
    [{ contacts: [contact], meta: { total: 1 } }], // Old synthetic-only schema.
    [{ contacts: [contact], hasMore: false }], // fastPagination was not requested.
    [{ contacts: [contact], total: "1" }],
    [{ contacts: [contact], total: -1 }],
    [{ contacts: [contact], total: 0 }],
    [{ contacts: [contact], total: 2 }], // More results but no cursor.
    [{ contacts: [], total: 1 }],
    [first, { contacts: [], total: 2 }],
    [first, { contacts: [{ ...contact, id: "b" }], total: 3 }],
    [first, { contacts: [contact], total: 2 }], // Duplicate ID across pages.
    [{ contacts: [contact, contact], total: 2 }],
    [{ contacts: [{ ...contact, locationId: "other-location" }], total: 1 }],
    [{ contacts: [{ ...contact, searchAfter: [{}] }], total: 2 }],
    [{ contacts: [{ ...contact, searchAfter: [1, "a"] }], total: 3 },
      { contacts: [{ ...contact, id: "b", searchAfter: [1, "a"] }], total: 3 }],
  ];
  for (const pages of invalidPages) {
    let page = 0;
    globalThis.fetch = async () => {
      assert.ok(page < pages.length, "must not fetch after invalid evidence");
      return Response.json(pages[page++]);
    };
    await assert.rejects(listContactsForPhoneMatching());
  }
  globalThis.fetch = async () => Response.json({ contacts: [], total: 0 });
  assert.deepEqual(await listContactsForPhoneMatching(), []);
});
test("contact search uses cursor pagination beyond the 10,000-record page window", async () => {
  let calls = 0;
  globalThis.fetch = async (_input: any, init: any) => {
    const body = JSON.parse(init.body);
    if (calls) {
      assert.equal(body.page, undefined);
      assert.deepEqual(body.searchAfter, [calls * 100 - 1, `id-${calls * 100 - 1}`]);
    }
    const start = calls++ * 100;
    return Response.json({ contacts: Array.from({ length: Math.min(100, 10001 - start) }, (_, i) => ({
      id: `id-${start + i}`, searchAfter: [start + i, `id-${start + i}`],
    })), total: 10001 });
  };
  assert.equal((await listContactsForPhoneMatching()).length, 10001);
  assert.equal(calls, 101);
});
test("pinned opportunity contract scopes all statuses and requires unique open exact owner", async () => {
  globalThis.fetch = async (input: any) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get("location_id"), "test-location");
    assert.equal(url.searchParams.get("pipeline_id"), "pipeline");
    assert.equal(url.searchParams.get("contact_id"), contact.id);
    assert.equal(url.searchParams.get("status"), "all");
    assert.equal(url.searchParams.get("limit"), "100");
    return Response.json({ opportunities: [opportunity], meta: { total: 1, currentPage: 1 } });
  };
  assert.equal((await findSinglePhoneOpportunity(contact.id, "pipeline"))?.id, opportunity.id);
  for (const response of [
    { opportunities: [opportunity], meta: {} },
    { opportunities: [opportunity], meta: { total: 2 } }, // A hidden second page.
    { opportunities: [opportunity], meta: { total: "1" } },
    { opportunities: [{ ...opportunity, status: undefined }], meta: { total: 1 } },
    { opportunities: [{ ...opportunity, pipelineId: "other" }], meta: { total: 1 } },
    { opportunities: [opportunity, { ...opportunity, id: "closed", status: "won" }], meta: { total: 2 } },
  ]) {
    globalThis.fetch = async () => Response.json(response);
    assert.equal(await findSinglePhoneOpportunity(contact.id, "pipeline"), null);
  }
});
test("email/phone ownership conflict blocks both paths before writes", async () => {
  database([customer, { id: "local-b", jobberClientId: "jobber-b", email: "owner@example.test", phone: null }]);
  mock([{ ...contact, email: "owner@example.test" }]); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("email-only baseline still exits its paid existing card", async () => {
  database([{ ...customer, email: "owner@example.test", phone: null }], "paid"); mock([{ ...contact, email: "owner@example.test" }]);
  await syncGhlInvoicePipeline(); assert.equal(writes[0].body.pipelineStageId, "paid");
});
test("phone write failure does not fall through to Paid", async () => {
  database(); mock(); const fetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any = {}) => {
    if (init.method === "PUT") throw new Error("synthetic failure before write"); return fetch(input, init);
  };
  await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("archived unsupported phone without relevant invoices does not gate email sync", async () => {
  const emailCustomer = { ...customer, id: "email-id", jobberClientId: "email-owner", email: "owner@example.test", phone: null };
  database([emailCustomer], "paid"); const findInvoices = prisma.invoiceRecord.findMany;
  (prisma.customer as any).findMany = async () => [emailCustomer, { ...customer, phone: "5550199" }];
  (prisma.invoiceRecord as any).findMany = async (args: any) => args.where?.customerId ? [] : findInvoices(args);
  mock([{ ...contact, email: "owner@example.test" }]); await syncGhlInvoicePipeline();
  assert.equal(writes[0].body.pipelineStageId, "paid");
});
test("exact no-match does not gate unrelated email sync", async () => {
  database([customer, { ...customer, id: "email-id", jobberClientId: "email-owner", email: "owner@example.test", phone: null }], "paid");
  mock([{ ...contact, phone: "+16025550199", email: "owner@example.test" }]);
  await syncGhlInvoicePipeline(); assert.equal(writes[0].body.pipelineStageId, "paid");
});
test("phone payment exit uses explicit fresh paid evidence", async () => {
  database([customer], "paid"); mock([contact], [{ ...opportunity, pipelineStageId: "overdue" }]);
  await syncGhlInvoicePipeline(); assert.deepEqual(writes.map(w => w.body.pipelineStageId), ["paid"]);
});
const paidEvidence = (): PhoneInvoiceEvidence => ({ id: "jobber-inv-0", client: { id: customer.jobberClientId }, invoiceStatus: "paid", amounts: { total: 100, invoiceBalance: 0 }, issuedDate: "2026-05-01", createdAt: null, dueDate: "2026-06-01" });
test("payment predicate rejects empty, omitted, partial, unknown, old, zero and void evidence", () => {
  const now = new Date("2026-11-06T00:00:00Z");
  const decide = (rows: any[], ids = ["jobber-inv-0"]) => phoneExitStage(customer.jobberClientId, ids, rows, now);
  assert.equal(decide([paidEvidence()]), "Invoice Paid");
  assert.equal(decide([]), null);
  assert.equal(decide([paidEvidence()], ["jobber-inv-0", "omitted"]), null);
  assert.equal(decide([paidEvidence()], []), null);
  for (const patch of [
    { invoiceStatus: "void" }, { invoiceStatus: "canceled" }, { invoiceStatus: null }, { invoiceStatus: "past_due" },
    { amounts: { total: 100, invoiceBalance: 1 } }, { amounts: { total: 100, invoiceBalance: null } },
    { amounts: { total: 100, invoiceBalance: -1 } }, { amounts: { total: null, invoiceBalance: 0 } },
    { issuedDate: "2025-01-01", invoiceStatus: "past_due" }, { invoiceStatus: null }, { client: null },
  ]) assert.equal(decide([paidEvidence(), { ...paidEvidence(), id: "other", ...patch }], ["jobber-inv-0", "other"]), null);
});
test("paid after previously aggregated phone overdue exits once with same exact owner", async () => {
  const aggregate = { ...opportunity, pipelineStageId: "overdue", name: "Synthetic — 2 overdue invoices" };
  database([customer], "paid"); mock([contact], [aggregate]); await syncGhlInvoicePipeline();
  assert.deepEqual(writes.map(w => w.body.pipelineStageId), ["paid"]);
});
test("remaining future invoice leaves existing Overdue cycle held for execution review", async () => {
  database([customer], "paid");
  sourceEvidence.push({ ...paidEvidence(), id: "future", invoiceStatus: "awaiting_payment", amounts: { total: 200, invoiceBalance: 50 }, dueDate: "2099-01-01" });
  mock([contact], [{ ...opportunity, pipelineStageId: "overdue", name: "Synthetic — 1 overdue invoice" }]);
  await syncGhlInvoicePipeline(); assert.deepEqual(writes, []);
});
test("fresh outstanding or unknown debt prevents cached paid exit", async () => {
  for (const patch of [{ invoiceStatus: "past_due", amounts: { total: 100, invoiceBalance: 5 } }, { invoiceStatus: "unknown" }, { invoiceStatus: "void" }, { issuedDate: "2025-01-01", invoiceStatus: "past_due" }]) {
    database([customer], "paid"); sourceEvidence.push({ ...paidEvidence(), id: "additional", ...patch });
    mock([contact], [{ ...opportunity, pipelineStageId: "overdue" }]); await syncGhlInvoicePipeline(); assert.equal(writes.some(w => w.body.pipelineStageId === "paid"), false);
  }
});
test("paid lookup or update failure cannot fall through to cleanup", async () => {
  for (const fail of ["lookup", "update"]) {
    database([customer], "paid"); mock([contact], [{ ...opportunity, pipelineStageId: "overdue" }]); const fetch = globalThis.fetch;
    globalThis.fetch = async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      if ((fail === "lookup" && url.pathname === "/opportunities/search") || (fail === "update" && init.method === "PUT")) throw new Error("synthetic failure");
      return fetch(input, init);
    };
    await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
  }
});
test("incomplete fresh source read holds payment exit", async () => {
  database([customer], "paid"); mock([contact], [{ ...opportunity, pipelineStageId: "overdue" }]); const fetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any = {}) => new URL(String(input)).hostname === "api.getjobber.com"
    ? Response.json({ data: { invoices: { nodes: [paidEvidence()], pageInfo: { hasNextPage: true, endCursor: null } } } }) : fetch(input, init);
  await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("strict source pagination rejects repeated cursors, duplicate IDs and unmapped invoices", async () => {
  for (const connection of [
    { nodes: [paidEvidence()], pageInfo: {} },
    { nodes: [paidEvidence(), paidEvidence()], pageInfo: { hasNextPage: false } },
    { nodes: [{ ...paidEvidence(), client: null }], pageInfo: { hasNextPage: false } },
    { nodes: [paidEvidence()], pageInfo: { hasNextPage: true, endCursor: "repeat" } },
  ]) {
    globalThis.fetch = async () => Response.json({ data: { invoices: connection } });
    await assert.rejects(readPhoneInvoiceEvidence());
  }
  let page = 0;
  globalThis.fetch = async () => Response.json({ data: { invoices: ++page === 1
    ? { nodes: [paidEvidence()], pageInfo: { hasNextPage: true, endCursor: "page2" } }
    : { nodes: [{ ...paidEvidence(), id: "second" }], pageInfo: { hasNextPage: false } } } });
  assert.equal((await readPhoneInvoiceEvidence()).length, 2);
});
test("shared-phone email path cannot POST a contact before ownership hold", async () => {
  database([customer, { ...customer, id: "email-id", jobberClientId: "email-owner", email: "different@example.test", phone: "6025550100" }]);
  mock(); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});

test("explicitly paid historical and zero-total invoices do not cause permanent hold", async () => {
  database([customer], "paid");
  sourceEvidence.push({ ...paidEvidence(), id: "old", issuedDate: "2025-01-01" },
    { ...paidEvidence(), id: "zero", amounts: { total: 0, invoiceBalance: 0 } });
  mock([contact], [{ ...opportunity, pipelineStageId: "overdue" }]);
  await syncGhlInvoicePipeline(); assert.deepEqual(writes.map(w => w.body.pipelineStageId), ["paid"]);
});
test("confirmed US display fixtures and blank/extensions do not create guesses", () => {
  for (const [source, target] of [["8015550100", "(801) 555-0100"], ["9045550100", "(904) 555-0100"], ["(480) 555-0100", "+14805550100"], ["14805550100", "4805550100"]]) {
    assert.equal(canonicalPhone(source), canonicalPhone(target));
  }
  for (const invalid of ["", " ", null, "4805550100 ext 2", "+14805550100#2", "480555010", "24805550100", "0000000000", "+10000000000", "1235550100", "4801230100"]) assert.equal(canonicalPhone(invalid), null);
  assert.equal(matchPhoneCustomer(customer, [customer], [contact, { ...contact, id: "collision", phone: "(602) 555-0100" }]).contactId, null);
});
test("possible seven-digit shared owner is held before email contact creation", async () => {
  database([customer, { ...customer, id: "email-id", jobberClientId: "email-owner", email: "different@example.test", phone: "5550100" }]);
  mock(); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
test("Paid to Overdue reentry is held; existing non-enrollment Sent path remains unchanged", async () => {
  for (const [status, due, target] of [["past_due", "2026-06-01", "overdue"], ["awaiting_payment", "2099-01-01", "sent"]]) {
    database([customer], "paid"); sourceEvidence.push({ ...paidEvidence(), id: "new-work", invoiceStatus: status,
      dueDate: due, amounts: { total: 150, invoiceBalance: 75 } });
    mock([contact], [{ ...opportunity, pipelineStageId: "paid" }]); await syncGhlInvoicePipeline();
    assert.deepEqual(writes.map(w => w.body.pipelineStageId), target === "overdue" ? [] : [target]);
    if (target === "sent") assert.equal(writes[0].body.monetaryValue, 75);
  }
});
test("stale cached debt cannot reopen Paid, nor can closed or special-stage cards", async () => {
  database(); sourceEvidence = [paidEvidence()]; mock([contact], [{ ...opportunity, pipelineStageId: "paid" }]);
  await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
  for (const card of [{ ...opportunity, pipelineStageId: "paid", status: "won" }, { ...opportunity, pipelineStageId: "late-fee" }]) {
    database(); mock([contact], [card]); await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
  }
});
test("cleanup cannot infer Paid when a phone-run card omits its owner", async () => {
  database(); mock([contact], [{ ...opportunity, contactId: null, pipelineStageId: "overdue" }]);
  await syncGhlInvoicePipeline(); assert.equal(writes.length, 0);
});
