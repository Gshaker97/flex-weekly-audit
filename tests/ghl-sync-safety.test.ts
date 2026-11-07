import test from "node:test";
import { writerFixture } from "./helpers/sync-writer-fixture";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma";
import { syncGhlInvoicePipeline, reconcileDeletedInvoices, GhlInvoiceReview } from "../lib/sync";
import { listPipelineOpportunities, createOpportunity } from "../lib/ghl";

process.env.GHL_API_KEY = "synthetic-only";
process.env.GHL_LOCATION_ID = "synthetic-location";
const owner = { id: "customer-a", jobberClientId: "jobber-a", email: "owner@example.test", phone: null, name: "Synthetic" };
const contact = { id: "contact-a", email: owner.email, phone: null };
const card = { id: "card-a", contactId: contact.id, pipelineId: "pipeline", pipelineStageId: "overdue", status: "open", monetaryValue: 100, name: "Invoice #1" };
const cached = { id: "local-invoice", jobberInvoiceId: "source-invoice", customerId: owner.id, invoiceNumber: "1", clientName: "Synthetic", invoiceStatus: "past_due", total: 100, amountDue: 100, issuedAt: new Date("2026-05-01"), dueAt: new Date("2026-06-01"), createdAtJobber: null };
const paid = { id: cached.jobberInvoiceId, client: { id: owner.jobberClientId }, invoiceStatus: "paid", amounts: { total: 100, invoiceBalance: 0 }, issuedDate: "2026-05-01", dueDate: "2026-06-01", createdAt: null };
const debt = { ...paid, invoiceStatus: "past_due", amounts: { total: 100, invoiceBalance: 100 } };
let customers: any[], contacts: any[], cards: any[], invoices: any[], source: any[], writes: any[], reviews: GhlInvoiceReview[];
let sourceReads: number;
let writerState: ReturnType<typeof writerFixture>;
let freshOwners: any[] | undefined;
let sourceConnection: any;
let snapshotCards: any[] | undefined;
let beforeRead: (() => void) | undefined;
let putFailure: "before" | "after" | undefined;
function setup() {
  writerState = writerFixture(); freshOwners = undefined;
  process.env.GHL_WRITE_APPROVAL_ID = "synthetic-reviewed-plan";
  process.env.GHL_APPROVED_OPPORTUNITY_IDS = JSON.stringify(["card-a", "card-b"]);
  delete process.env.GHL_INVOICE_WRITE_MODE;
  delete process.env.GHL_PHONE_WRITES_ENABLED;
  process.env.CLEANUP_INVALID_OPPS = "true";
  customers = [{ ...owner }]; contacts = [{ ...contact }]; cards = [{ ...card }];
  invoices = [{ ...cached, customer: customers[0] }]; source = [structuredClone(paid)];
  writes = []; reviews = []; sourceReads = 0; sourceConnection = undefined; snapshotCards = undefined; beforeRead = undefined; putFailure = undefined;
  (prisma.customer as any).findMany = async () => customers;
  (prisma.invoiceRecord as any).findMany = async () => invoices;
  (prisma.jobberAuth as any).findFirst = async () => ({ accessToken: "synthetic-only", expiresAt: new Date(Date.now() + 3600000) });
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.getjobber.com") {
      if (JSON.parse(init.body).query.includes("VerifyGhlIdentityOwnership")) return Response.json({ data: { clients: {
        nodes: freshOwners ?? customers.map(c => ({ id: c.jobberClientId,
          emails: c.email ? [{ address: c.email, primary: true }] : [], phones: c.phone ? [{ number: c.phone, primary: true }] : [] })),
        pageInfo: { hasNextPage: false, endCursor: null },
      } } });
      sourceReads++;
      return Response.json({ data: { invoices: sourceConnection ?? { nodes: source, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    assert.equal(url.hostname, "services.leadconnectorhq.com");
    if (url.pathname === "/contacts/search") return Response.json({ contacts, total: contacts.length });
    if (url.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "pipeline", name: "Invoice Pipeline", stages: [
      { id: "sent", name: "Invoice Sent" }, { id: "overdue", name: "Invoice Overdue" }, { id: "paid", name: "Invoice Paid" }, { id: "late-fee", name: "Late Fee" },
    ] }] });
    if (url.pathname === "/opportunities/search") {
      assert.equal(url.searchParams.get("status"), "all");
      return Response.json({ opportunities: snapshotCards ?? cards, meta: { total: (snapshotCards ?? cards).length } });
    }
    const target = cards.find(c => c.id === url.pathname.split("/").pop());
    if (target && init.method === "PUT") {
      const body = JSON.parse(init.body);
      assert.equal(body.status, undefined, "never force open");
      writes.push({ method: "PUT", id: target.id, body });
      if (putFailure === "before") throw new Error("synthetic network failure before acceptance");
      Object.assign(target, body);
      if (putFailure === "after") throw new Error("synthetic timeout after acceptance");
      return Response.json({ opportunity: target });
    }
    if (target && (!init.method || init.method === "GET")) {
      beforeRead?.();
      return Response.json({ opportunity: target });
    }
    throw new Error(`Unexpected provider write/request: ${init.method ?? "GET"} ${url.pathname}`);
  };
}
const run = (mode?: "review" | "paid_only" | "sync") => syncGhlInvoicePipeline({ mode, writer: writerState.writer, report: entry => reviews.push(entry) });

test("default mode preserves explicitly paid email exits from Sent and Overdue", async () => {
  for (const stage of ["sent", "overdue"]) {
    setup(); cards[0].pipelineStageId = stage;
    assert.equal(await run(), 1);
    assert.deepEqual(writes.map(w => w.body), [{ pipelineStageId: "paid", monetaryValue: 0 }]);
  }
});
test("default mode blocks enrollment/reentry and includes reviewable diff", async () => {
  for (const stage of ["sent", "paid"]) {
    setup(); source = [debt]; cards[0].pipelineStageId = stage;
    await run(); assert.equal(writes.length, 0);
    assert.ok(reviews.some(r => r.action === "hold" && r.to?.stageId === "overdue" && r.to?.monetaryValue === 100));
  }
});
test("review mode performs no provider mutations even for an eligible Paid exit", async () => {
  setup(); await run("review"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.opportunityId === card.id && r.from?.stageId === "overdue" && r.to?.stageId === "paid" && r.reason.includes("Review mode")));
});
test("unknown/missing/void/negative/partial balances never imply Paid", async () => {
  for (const patch of [
    { invoiceStatus: null }, { invoiceStatus: "unknown" }, { invoiceStatus: "void" }, { invoiceStatus: "canceled" },
    { invoiceStatus: "past_due" }, { amounts: null }, { amounts: { total: 100, invoiceBalance: null } },
    { amounts: { total: 100, invoiceBalance: -1 } }, { amounts: { total: 100, invoiceBalance: 1 } },
    { amounts: { total: null, invoiceBalance: 0 } }, { amounts: { total: 0, invoiceBalance: 1 } },
  ]) {
    setup(); source = [{ ...paid, ...patch }]; await run(); assert.equal(writes.length, 0);
  }
});
test("empty source or omitted stored invoice holds existing Overdue", async () => {
  for (const rows of [[], [{ ...paid, id: "other" }]]) {
    setup(); source = rows; await run(); assert.equal(writes.length, 0);
  }
});
test("a card with no stored source owner is held, never swept Paid", async () => {
  setup(); invoices = []; await run(); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.opportunityId === card.id && r.reason.includes("No unambiguous")));
});
test("partial full source read fails closed even when returned row is paid", async () => {
  for (const pageInfo of [{}, { hasNextPage: true, endCursor: null }]) {
    setup(); sourceConnection = { nodes: [paid], pageInfo }; await run(); assert.equal(writes.length, 0);
  }
});
test("additional uncached positive debt prevents Paid and snapshot is reused", async () => {
  setup(); source.push({ ...debt, id: "new-debt" });
  await run(); assert.equal(writes.length, 0); assert.equal(sourceReads, 1);
});
test("duplicate cards including won/lost and old invoices are never deleted or marked Paid", async () => {
  setup(); cards.push({ ...card, id: "closed-card", status: "won" }); invoices[0].issuedAt = new Date("2025-01-01");
  await run("sync"); assert.equal(writes.length, 0);
  assert.equal(reviews.filter(r => r.reason.includes("Multiple existing cards")).length, 2);
});
test("Late Fee, Closed Out, won, lost and missing status are protected", async () => {
  for (const patch of [{ pipelineStageId: "late-fee" }, { pipelineStageId: "closed-out" }, { status: "won" }, { status: "lost" }, { status: null }]) {
    for (const rows of [[paid], [debt]]) {
      setup(); Object.assign(cards[0], patch); source = rows;
      await run("sync"); assert.equal(writes.length, 0); assert.equal(sourceReads, 0);
    }
  }
});
test("failed Overdue write cannot fall through to Paid or a second write", async () => {
  setup(); source = [debt]; cards[0].pipelineStageId = "sent"; putFailure = "before";
  await run("sync"); assert.equal(writes.length, 1); assert.equal(writes[0].body.pipelineStageId, "overdue");
  assert.ok(reviews.some(r => r.action === "failed"));
});
test("unknown PUT outcome is not retried even when a later snapshot already matches", async () => {
  setup(); putFailure = "after"; await run(); assert.equal(writes.length, 1);
  assert.equal(cards[0].pipelineStageId, "paid");
  putFailure = undefined; await run(); assert.equal(writes.length, 1);
});
test("fresh read already at intended target avoids replay despite stale pipeline snapshot", async () => {
  setup(); snapshotCards = structuredClone(cards); cards[0].pipelineStageId = "paid";
  await run(); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.reason.includes("no repeated PUT")));
});
test("fresh changed stage/status/owner/amount/name is held immediately before PUT", async () => {
  for (const patch of [{ pipelineStageId: "late-fee" }, { status: "won" }, { contactId: "other" }, { monetaryValue: 999 }, { name: "Manual change" }]) {
    setup(); beforeRead = () => Object.assign(cards[0], patch);
    await run(); assert.equal(writes.length, 0);
  }
});
test("past_due group guard prevents awaiting future invoice from demoting the aggregate", async () => {
  setup(); source = [debt, { ...debt, id: "future", invoiceStatus: "awaiting_payment", dueDate: "2099-01-01" }];
  invoices.push({ ...cached, id: "future-local", jobberInvoiceId: "future", invoiceStatus: "awaiting_payment", dueAt: new Date("2099-01-01") });
  await run("sync"); assert.equal(writes.length, 1); assert.equal(writes[0].body.pipelineStageId, "overdue");
  assert.equal(writes[0].body.monetaryValue, 100);
});
test("multiple awaiting invoices aggregate only elapsed debt into one Overdue card", async () => {
  setup(); invoices[0].invoiceStatus = "awaiting_payment";
  invoices.push({ ...cached, id: "future-local", jobberInvoiceId: "future", invoiceStatus: "awaiting_payment", dueAt: new Date("2099-01-01") });
  source = [{ ...debt, invoiceStatus: "awaiting_payment" }, { ...debt, id: "future", invoiceStatus: "awaiting_payment", dueDate: "2099-01-01" }];
  await run("sync"); assert.equal(writes.length, 1); assert.equal(writes[0].body.pipelineStageId, "overdue"); assert.equal(writes[0].body.monetaryValue, 100);
});
test("phone writes require separate gate even with sync mode; unique existing card only", async () => {
  setup(); customers[0].email = null; customers[0].phone = "6025550100";
  contacts[0].email = null; contacts[0].phone = "+16025550100";
  await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.reason === "Phone writes not enabled"));
  process.env.GHL_PHONE_WRITES_ENABLED = "true"; await run(); assert.equal(writes.length, 1);
});
test("duplicate phone owner example holds a Sent $180 card despite four $180 overdue invoices", async () => {
  setup(); customers[0].email = null; customers[0].phone = "6025550100";
  contacts = [1, 2, 3].map(i => ({ id: `contact-${i}`, email: null, phone: "+16025550100" }));
  cards[0] = { ...card, contactId: "contact-1", pipelineStageId: "sent", monetaryValue: 180 };
  invoices = [1, 2, 3, 4].map(i => ({ ...cached, id: `local-${i}`, jobberInvoiceId: `source-${i}`, amountDue: 180, total: 180 }));
  source = [1, 2, 3, 4].map(i => ({ ...debt, id: `source-${i}`, amounts: { total: 180, invoiceBalance: 180 } }));
  process.env.GHL_PHONE_WRITES_ENABLED = "true"; await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.opportunityId === card.id && r.reason.includes("ambiguous GHL phone")));
});
test("won Closed Out $98 example is held even with current positive Jobber debt", async () => {
  setup(); cards[0] = { ...card, status: "won", pipelineStageId: "closed-out", monetaryValue: 98 };
  source = [{ ...debt, amounts: { total: 98, invoiceBalance: 98 } }];
  await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.opportunityId === card.id && r.reason.includes("automatic reopening disabled")));
});
test("missing contact/card and duplicate email owners never trigger creation", async () => {
  for (const which of ["contact", "card", "duplicate-contact", "duplicate-customer"]) {
    setup(); source = [debt];
    if (which === "contact") contacts = [];
    if (which === "card") cards = [];
    if (which === "duplicate-contact") contacts.push({ ...contact, id: "duplicate" });
    if (which === "duplicate-customer") customers.push({ ...owner, id: "second", jobberClientId: "second-source" });
    await run("sync"); assert.equal(writes.length, 0);
  }
});
test("strict opportunity pagination rejects missing totals, cursors, duplicate IDs and changing totals", async () => {
  setup();
  for (const payload of [
    { opportunities: [card] }, { opportunities: [card], meta: { total: 2 } },
    { opportunities: [card, card], meta: { total: 2 } }, { opportunities: [{ ...card, pipelineId: "other" }], meta: { total: 1 } },
  ]) {
    globalThis.fetch = async () => Response.json(payload);
    await assert.rejects(listPipelineOpportunities("pipeline"));
  }
  let calls = 0;
  globalThis.fetch = async () => Response.json(++calls === 1 ?
    { opportunities: [card], meta: { total: 2, startAfter: 123, startAfterId: card.id } } :
    { opportunities: [{ ...card, id: "card-b" }], meta: { total: 3 } });
  await assert.rejects(listPipelineOpportunities("pipeline"));
});
test("strict opportunity pagination traverses all statuses without silently capping", async () => {
  setup(); let calls = 0;
  globalThis.fetch = async (input: any) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get("status"), "all");
    if (++calls === 1) return Response.json({ opportunities: [card], meta: { total: 2, startAfter: 123, startAfterId: card.id } });
    assert.equal(url.searchParams.get("startAfter"), "123"); assert.equal(url.searchParams.get("startAfterId"), card.id);
    return Response.json({ opportunities: [{ ...card, id: "closed", status: "lost" }], meta: { total: 2 } });
  };
  assert.equal((await listPipelineOpportunities("pipeline")).length, 2);
});
test("duplicate-create helper no longer mutates an unverified existing ID", async () => {
  setup(); let calls = 0;
  globalThis.fetch = async (_input: any, init: any) => {
    assert.equal(init.method, "POST"); calls++;
    return Response.json({ meta: { existingId: "unverified" } }, { status: 400 });
  };
  await assert.rejects(createOpportunity({ pipelineId: "pipeline", pipelineStageId: "overdue", contactId: contact.id, name: "Synthetic" }));
  assert.equal(calls, 1);
});
test("an unconfirmed PUT halts all remaining writes in the same run", async () => {
  setup(); putFailure = "after";
  customers.push({ ...owner, id: "customer-b", jobberClientId: "jobber-b", email: "second@example.test" });
  contacts.push({ ...contact, id: "contact-b", email: "second@example.test" });
  cards.push({ ...card, id: "card-b", contactId: "contact-b" });
  invoices.push({ ...cached, id: "local-b", jobberInvoiceId: "source-b", customerId: "customer-b" });
  source.push({ ...paid, id: "source-b", client: { id: "jobber-b" } });
  await run(); assert.equal(writes.length, 1);
  assert.ok(reviews.some(r => r.opportunityId === "card-b" && r.action === "hold" && r.reason.includes("remaining writes halted")));
});
test("a rate-limited PUT is not automatically replayed", async () => {
  setup(); let attempts = 0; const fetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any = {}) => {
    if (init.method === "PUT") { attempts++; return Response.json({}, { status: 429 }); }
    return fetch(input, init);
  };
  await run(); assert.equal(attempts, 1);
  assert.ok(reviews.some(r => r.action === "failed" && r.reason.includes("remaining writes halted")));
});

test("missing source-by-ID never fabricates a void or zero cached balance", async () => {
  setup(); let cacheWrites = 0;
  (prisma.invoiceRecord as any).updateMany = async () => { cacheWrites++; return { count: 1 }; };
  globalThis.fetch = async () => Response.json({ data: { i0: null } });
  assert.equal(await reconcileDeletedInvoices(), 0); assert.equal(cacheWrites, 0);
  globalThis.fetch = async () => Response.json({ data: {} });
  assert.equal(await reconcileDeletedInvoices(), 0); assert.equal(cacheWrites, 0);
});

for (const identity of ["email", "phone"]) {
  test(`${identity} sync mode holds invalid source money before proposing or writing a card change`, async () => {
    for (const amounts of [
      { total: 100, invoiceBalance: 150 }, { total: 100.001, invoiceBalance: 100 },
      { total: 100, invoiceBalance: 1.001 }, { total: 100, invoiceBalance: 0.000000001 },
      { total: 100, invoiceBalance: -1 }, { total: 100, invoiceBalance: null },
      { total: null, invoiceBalance: 1 }, { total: Number.MAX_SAFE_INTEGER, invoiceBalance: 1 },
    ]) {
      for (const invoiceStatus of ["past_due", "awaiting_payment"]) {
        setup(); cards[0].pipelineStageId = "paid";
        source = [{ ...debt, invoiceStatus, dueDate: "2099-01-01", amounts }];
        if (identity === "phone") {
          customers[0].email = null; customers[0].phone = "6025550100";
          contacts[0].email = null; contacts[0].phone = "+16025550100";
          process.env.GHL_PHONE_WRITES_ENABLED = "true";
        }
        // Exercise the activation flag, rather than relying on paid_only to hide a bad plan.
        process.env.GHL_INVOICE_WRITE_MODE = "sync";
        assert.equal(await run(), 0);
        assert.equal(writes.length, 0);
        assert.equal(sourceReads, 1);
        assert.ok(reviews.some(r => r.opportunityId === card.id && r.action === "hold" && !r.to));
        assert.ok(!reviews.some(r => r.action === "planned" || r.action === "applied"));
      }
    }
  });
}
test("email paid_only mode holds explicit paid evidence with invalid total", async () => {
  for (const total of [100.001, Number.MAX_SAFE_INTEGER]) {
    setup(); source = [{ ...paid, amounts: { total, invoiceBalance: 0 } }];
    assert.equal(await run(), 0); assert.equal(writes.length, 0);
    assert.ok(reviews.some(r => r.opportunityId === card.id && r.action === "hold" && !r.to));
  }
});
test("email sync aggregates valid cents exactly and rejects aggregate cent overflow", async () => {
  for (const balances of [[0.1, 0.2], [50000000000000, 50000000000000]]) {
    setup(); cards[0].pipelineStageId = "sent";
    source = balances.map((invoiceBalance, index) => ({ ...debt, id: index ? "uncached" : debt.id,
      amounts: { total: invoiceBalance, invoiceBalance },
    }));
    const overflow = balances[0] > 1;
    assert.equal(await run("sync"), overflow ? 0 : 1);
    assert.equal(writes.length, overflow ? 0 : 1);
    if (!overflow) assert.equal(writes[0].body.monetaryValue, 0.3);
    else assert.ok(reviews.some(r => r.opportunityId === card.id && r.action === "hold" && !r.to));
  }
});

test("unset/malformed cohort, missing approval ID and unadmitted reconciliation withhold Paid writes", async () => {
  for (const change of [() => { delete process.env.GHL_APPROVED_OPPORTUNITY_IDS; },
    () => { process.env.GHL_APPROVED_OPPORTUNITY_IDS = "{}"; },
    () => { process.env.GHL_APPROVED_OPPORTUNITY_IDS = '["other"]'; },
    () => { delete process.env.GHL_WRITE_APPROVAL_ID; }]) {
    setup(); change(); assert.equal(await run(), 0); assert.equal(writes.length, 0);
    assert.ok(reviews.some(r => r.action === "hold" && r.reason.includes("Paid exits are also held")));
  }
  setup(); await syncGhlInvoicePipeline({ report: entry => reviews.push(entry) });
  assert.equal(writes.length, 0); assert.ok(reviews.some(r => r.reason.includes("No admitted durable writer")));
});
test("selected contact phone cannot belong to another email-bearing Jobber owner", async () => {
  setup(); contacts[0].phone = "+16025550100";
  customers.push({ ...owner, id: "customer-b", jobberClientId: "jobber-b", email: "other@example.test", phone: "6025550100" });
  await run(); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.reason.includes("belongs to another Jobber customer")));
});
test("email/phone disagreement, another contact and secondary-field collisions hold Paid exits", async () => {
  for (const conflict of ["different-primary", "other-phone-card", "secondary-email", "secondary-phone", "selected-secondary-owner", "bad-shape"]) {
    setup(); customers[0].phone = "+16025550100";
    if (conflict === "different-primary") contacts[0].phone = "+16025550101";
    if (conflict === "other-phone-card") contacts.push({ id: "other", email: null, phone: "+16025550100" });
    if (conflict === "secondary-email") contacts.push({ id: "other", email: null, phone: null, additionalEmails: [{ email: owner.email }] });
    if (conflict === "secondary-phone") contacts.push({ id: "other", email: null, phone: null, additionalPhones: [{ phone: "6025550100" }] });
    if (conflict === "selected-secondary-owner") {
      contacts[0].additionalEmails = [{ email: "other@example.test" }];
      customers.push({ ...owner, id: "customer-b", jobberClientId: "jobber-b", email: "other@example.test" });
    }
    if (conflict === "bad-shape") contacts[0].additionalEmails = [{ email: 123 }];
    await run(); assert.equal(writes.length, 0, conflict);
  }
});
test("fresh Jobber changed primary identity and secondary-owner collisions block permitted writes", async () => {
  for (const conflict of ["primary-changed", "other-secondary-email", "other-secondary-phone", "missing-owner", "missing-fields"]) {
    setup(); customers[0].phone = "+16025550100"; contacts[0].phone = "+16025550100";
    freshOwners = [{ id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: "+16025550100", primary: true }] }];
    if (conflict === "primary-changed") freshOwners[0].emails[0].address = "changed@example.test";
    if (conflict === "other-secondary-email") freshOwners.push({ id: "uncached-owner", emails: [{ address: "other@example.test", primary: true }, { address: owner.email, primary: false }], phones: [] });
    if (conflict === "other-secondary-phone") freshOwners.push({ id: "uncached-owner", emails: [], phones: [{ number: "6025550100", primary: false }] });
    if (conflict === "missing-owner") freshOwners = [];
    if (conflict === "missing-fields") delete freshOwners[0].emails;
    await run(); assert.equal(writes.length, 0, conflict);
    assert.equal(writerState.rows[0].errorMessage, null, "No mutation intent on failed identity preflight");
  }
});
test("write intent precedes PUT and binds approved plan, expected/target money and exact source evidence", async () => {
  setup(); const fetch = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any = {}) => {
    if (init.method === "PUT") {
      const journal = JSON.parse(writerState.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
      const entry = journal.writes[0]; assert.equal(entry.state, "pending");
      assert.equal(entry.intent.approvalId, "synthetic-reviewed-plan");
      assert.equal(entry.intent.expected.amountCents, 10000); assert.equal(entry.intent.target.amountCents, 0);
      assert.equal(entry.intent.source.invoices[0].id, paid.id); assert.equal(entry.intent.source.invoices[0].balanceCents, 0);
    }
    return fetch(input, init);
  };
  assert.equal(await run(), 1);
  assert.equal(JSON.parse(writerState.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length)).writes[0].state, "confirmed");
});
test("wrong post-PUT owner, stage, amount, name, ID or missing response blocks future writes", async () => {
  for (const delta of [{ contactId: "other" }, { pipelineStageId: "sent" }, { monetaryValue: 1 }, { name: "changed" }, { id: "other" }, null]) {
    setup(); const fetch = globalThis.fetch; let hasWritten = false;
    globalThis.fetch = async (input: any, init: any = {}) => {
      if (init.method === "PUT") { hasWritten = true; return fetch(input, init); }
      const url = new URL(String(input));
      if (hasWritten && url.pathname === `/opportunities/${card.id}`) return Response.json({ opportunity: delta ? { ...cards[0], ...delta } : null });
      return fetch(input, init);
    };
    assert.equal(await run(), 0); assert.equal(writes.length, 1); assert.equal(writerState.rows[0].status, "blocked");
    const journal = JSON.parse(writerState.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
    assert.equal(journal.writes[0].state, "pending");
    await assert.rejects(writerState.writer.finish("complete"));
    assert.equal(writes.length, 1);
  }
});

test("unsupported selected secondary and fresh primary phone identities hold before prepare or PUT", async () => {
  for (const conflict of ["selected-secondary-suffix", "fresh-unparsed-primary", "fresh-secondary-suffix"]) {
    setup();
    if (conflict === "selected-secondary-suffix") {
      contacts[0].additionalPhones = [{ phone: "5550100" }];
      customers.push({ ...owner, id: "customer-b", jobberClientId: "jobber-b", email: "other@example.test", phone: "+16025550100" });
    } else {
      freshOwners = [{ id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }],
        phones: [{ number: conflict === "fresh-unparsed-primary" ? "unparsed phone" : "5550100", primary: conflict === "fresh-unparsed-primary" }] }];
    }
    assert.equal(await run(), 0); assert.equal(writes.length, 0);
    assert.equal(writerState.rows[0].errorMessage, null); assert.equal(writerState.calls.length, 0);
    assert.ok(reviews.some(r => r.action === "hold"));
  }
});
