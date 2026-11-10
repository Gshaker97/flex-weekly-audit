import test from "node:test";
import { writerFixture } from "./helpers/sync-writer-fixture";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { standingOmissionScopeHash, type StandingOmissionPolicy } from "../lib/ghl-identity-coverage";
import { DUE_DATE_LOCATION, DUE_DATE_FIELD } from "../lib/ghl-recurring-due-date";
import { buildGhlWriteIntent } from "../lib/ghl-write-intent";
import { cardNameHash, type GhlWriteIntent } from "../lib/sync-writer-control";
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
  process.env.GHL_LOCATION_ID = "synthetic-location";
  process.env.GHL_WRITE_APPROVAL_ID = "synthetic-reviewed-plan";
  process.env.GHL_APPROVED_OPPORTUNITY_IDS = JSON.stringify(["card-a", "card-b"]);
  delete process.env.GHL_INVOICE_WRITE_MODE;
  delete process.env.GHL_PHONE_WRITES_ENABLED;
  delete process.env.GHL_RECURRING_DUE_DATE_ENABLED;
  delete process.env.GHL_CYCLE_OWNERSHIP_ENABLED;
  delete process.env.GHL_STANDING_IDENTITY_ENABLED;
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
test("disabled recurring Overdue route cannot fall back to a legacy stage write", async () => {
  setup(); source = [debt]; cards[0].pipelineStageId = "sent"; putFailure = "before";
  await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.action === "hold" && r.reason === "recurring_due_date_disabled"));
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
  await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.action === "hold" && r.reason.includes("Existing Overdue cycle")));
  assert.ok(!reviews.some(r => r.to?.stageId === "sent"));
});
test("multiple awaiting invoices remain held instead of binding an aggregate date", async () => {
  setup(); cards[0].pipelineStageId = "sent"; invoices[0].invoiceStatus = "awaiting_payment";
  invoices.push({ ...cached, id: "future-local", jobberInvoiceId: "future", invoiceStatus: "awaiting_payment", dueAt: new Date("2099-01-01") });
  source = [{ ...debt, invoiceStatus: "awaiting_payment" }, { ...debt, id: "future", invoiceStatus: "awaiting_payment", dueDate: "2099-01-01" }];
  await run("sync"); assert.equal(writes.length, 0);
  assert.ok(reviews.some(r => r.action === "hold" && r.reason.includes("exactly one unpaid")));
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
test("email sync holds multi-invoice cents and rejects aggregate cent overflow", async () => {
  for (const balances of [[0.1, 0.2], [50000000000000, 50000000000000]]) {
    setup(); cards[0].pipelineStageId = "sent";
    source = balances.map((invoiceBalance, index) => ({ ...debt, id: index ? "uncached" : debt.id,
      amounts: { total: invoiceBalance, invoiceBalance },
    }));
    const overflow = balances[0] > 1;
    assert.equal(await run("sync"), 0);
    assert.equal(writes.length, 0);
    if (!overflow) assert.ok(reviews.some(r => r.action === "hold" && r.reason.includes("exactly one unpaid")));
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


async function seedOwnedEnrollment() {
  setup();process.env.GHL_CYCLE_OWNERSHIP_ENABLED="true";process.env.GHL_LOCATION_ID=DUE_DATE_LOCATION;
  cards[0].locationId=DUE_DATE_LOCATION;cards[0].customFields=[{id:DUE_DATE_FIELD,fieldValue:"2026-06-01"}];
  const previousFetch=globalThis.fetch;
  globalThis.fetch=async(input:any,init:any)=>new URL(String(input)).pathname===`/locations/${DUE_DATE_LOCATION}/customFields`
    ? Response.json({customFields:[{id:DUE_DATE_FIELD,locationId:DUE_DATE_LOCATION,fieldKey:"opportunity.due_date",model:"opportunity",dataType:"DATE"}]})
    : previousFetch(input,init);
  const intent=buildGhlWriteIntent({current:{...card,pipelineStageId:"sent"},to:{stageId:"overdue",monetaryValue:100},
    jobberClientId:owner.jobberClientId,source:[structuredClone(debt)],storedInvoiceIds:[debt.id],observedAt:new Date().toISOString()})!;
  intent.cycle={version:1,locationId:DUE_DATE_LOCATION,workflowId:"reminder",invoiceId:debt.id,dueOn:"2026-06-01",phase:"enroll"};
  const id=await writerState.writer.prepare(intent);await writerState.writer.confirm(id);return {intent,id};
}
test("enabled Paid hook owns reset successor B even when B pays before any Overdue enrollment",async()=>{
  const a=await seedOwnedEnrollment();assert.equal(await run(),1);
  const aPaid=(await writerState.writer.readCycleHistory()).find(w=>w.intent.cycle?.phase==="paid")!;
  const b={...debt,id:"invoice-b",invoiceStatus:"awaiting_payment",issuedDate:"2026-11-01",dueDate:"2026-11-20"};
  const before={stageId:"paid",status:"open" as const,amountCents:0,nameHash:cardNameHash(cards[0].name)};
  const reset:GhlWriteIntent={...a.intent,expected:before,target:{...before,updateName:false},
    source:{observedAt:new Date().toISOString(),storedInvoiceIds:[debt.id,b.id],invoices:[
      {id:paid.id,jobberClientId:owner.jobberClientId,invoiceStatus:"paid",totalCents:10000,balanceCents:0,issuedDate:paid.issuedDate,dueDate:paid.dueDate,createdAt:null},
      {id:b.id,jobberClientId:owner.jobberClientId,invoiceStatus:"awaiting_payment",totalCents:10000,balanceCents:10000,issuedDate:b.issuedDate,dueDate:b.dueDate,createdAt:null}]},
    cycle:{...a.intent.cycle!,invoiceId:b.id,dueOn:b.dueDate,phase:"reset_date",predecessorInvoiceId:debt.id,
      cleanup:{contractSha256:"a".repeat(64),observedAt:new Date().toISOString(),evidenceRef:"synthetic-confirmed-cleanup",oldEnrollmentJournalId:a.id,oldPaidJournalId:aPaid.id,orderedClearAcknowledged:false}},
    dateField:{locationId:DUE_DATE_LOCATION,fieldId:DUE_DATE_FIELD,key:"opportunity.due_date",invoiceId:b.id,expectedValue:paid.dueDate,targetValue:b.dueDate,sourceFingerprint:"b".repeat(64)}};
  const dateId=await writerState.writer.prepare(reset);await writerState.writer.confirm(dateId);
  const stage={...reset,dateField:undefined,cycle:{...reset.cycle!,phase:"reset_stage" as const},target:{stageId:"sent",amountCents:10000,nameHash:before.nameHash,updateName:false}};
  const stageId=await writerState.writer.prepare(stage);await writerState.writer.confirm(stageId);
  cards[0].pipelineStageId="sent";cards[0].monetaryValue=100;
  source=[structuredClone(paid),{...b,invoiceStatus:"paid",amounts:{total:100,invoiceBalance:0}}];
  invoices.push({...cached,id:"cached-b",jobberInvoiceId:b.id,invoiceStatus:"paid",issuedAt:new Date(b.issuedDate),dueAt:new Date(b.dueDate)});writes=[];reviews=[];
  assert.equal(await run(),1);assert.deepEqual(writes.map(w=>w.body),[{pipelineStageId:"paid",monetaryValue:0}]);
  const history=await writerState.writer.readCycleHistory();assert.deepEqual(history.filter(w=>w.intent.cycle?.phase==="paid").map(w=>w.intent.cycle!.invoiceId),[debt.id,b.id]);
  assert.ok(!history.some(w=>w.intent.cycle?.phase==="enroll" && w.intent.cycle.invoiceId===b.id));assert.equal(writerState.rows[0].status,"running");
});
test("enabled Paid hook preserves actual edited source due date and historical enrolled card date",async()=>{
  await seedOwnedEnrollment();source=[{...paid,dueDate:"2026-06-02"}];assert.equal(await run(),1);
  assert.deepEqual(writes.map(w=>w.body),[{pipelineStageId:"paid",monetaryValue:0}]);
  const claim=(await writerState.writer.readCycleHistory()).at(-1)!;assert.equal(claim.intent.cycle!.phase,"paid");
  assert.equal(claim.intent.cycle!.dueOn,"2026-06-01");assert.equal(claim.intent.source.invoices[0].dueDate,"2026-06-02");assert.equal(writerState.rows[0].status,"running");
});
test("enabled Paid hook permits ordinary corrective Paid exit without duplicating paid claim",async()=>{
  await seedOwnedEnrollment();assert.equal(await run(),1);cards[0].pipelineStageId="overdue";cards[0].monetaryValue=100;writes=[];
  assert.equal(await run(),1);assert.deepEqual(writes.map(w=>w.body),[{pipelineStageId:"paid",monetaryValue:0}]);
  const history=await writerState.writer.readCycleHistory();assert.equal(history.filter(w=>w.intent.cycle?.phase==="paid").length,1);
  assert.equal(history.at(-1)!.intent.cycle,undefined);assert.equal(writerState.rows[0].status,"running");
});

test("missing pre-Paid date witness does not block a valid source-paid exit",async()=>{
 await seedOwnedEnrollment();cards[0].customFields=[];assert.equal(await run(),1);
 const last=(await writerState.writer.readCycleHistory()).at(-1)!;assert.equal(last.intent.cycle!.phase,"paid");assert.equal(last.intent.cycle!.paidDateWitness,undefined);assert.equal(last.paidDateReadback,undefined);assert.equal(writerState.rows[0].status,"running");
});
test("unexpected optional field readback withholds reuse evidence but preserves verified Paid card exit",async()=>{
 await seedOwnedEnrollment();const previous=globalThis.fetch;globalThis.fetch=async(input:any,init:any={})=>{const r=await previous(input,init);if(init.method==="PUT")cards[0].customFields[0].fieldValue="2026-06-03";return r;};
 assert.equal(await run(),1);const last=(await writerState.writer.readCycleHistory()).at(-1)!;assert.ok(last.intent.cycle!.paidDateWitness);assert.equal(last.paidDateReadback,undefined);assert.equal(writerState.rows[0].status,"running");
});
async function setupStandingPaidFixture(){
 setup();const missing=[{id:"missing-local-a",jobberClientId:"missing-a",email:"archived-a@example.test",phone:null},{id:"missing-local-b",jobberClientId:"missing-b",email:"archived-b@example.test",phone:null}];customers.push(...missing);
 freshOwners=[{id:owner.jobberClientId,emails:[{address:owner.email,primary:true}],phones:[]}];assert.equal(await run(),0);assert.equal(writes.length,0);
 const p:StandingOmissionPolicy={kind:"explicit_standing",approvalId:"synthetic-standing-grant",approvalRef:"synthetic-explicit-user-reference",approvedAt:"2025-01-01T00:00:00Z",validity:"until_revoked",accountId:"synthetic-account",scopeSha256:"",quarantine:[missing[0],missing[1]]};p.scopeSha256=standingOmissionScopeHash(p);
 const raw=JSON.stringify(p);Object.assign(process.env,{GHL_STANDING_IDENTITY_ENABLED:"true",GHL_STANDING_IDENTITY_APPROVAL_ID:p.approvalId,GHL_STANDING_IDENTITY_POLICY:raw,GHL_STANDING_IDENTITY_POLICY_SHA256:createHash("sha256").update(raw).digest("hex")});
 const previous=globalThis.fetch;let populationReads=0,nullReads=0;
 globalThis.fetch=async(input:any,init:any={})=>{if(String(input).includes("api.getjobber.com")){const q=JSON.parse(init.body).query;
 if(q.includes("VerifyExplicitIdentityCoverage")){populationReads++;return Response.json({data:{account:{id:p.accountId},clients:{nodes:q.includes("isArchived: false")?freshOwners:[],pageInfo:{hasNextPage:false,endCursor:null}}}});}
 if(q.includes("VerifyQuarantinedIdentity")){nullReads++;return Response.json({data:{account:{id:p.accountId},client:null}});}}return previous(input,init);};
 (prisma.customer as any).findMany=async(args:any)=>args?.select?missing.map(c=>({jobberClientId:c.jobberClientId,_count:{jobs:0,invoices:0}})):customers;
 return {p,raw,counts:()=>({populationReads,nullReads})};
}
test("outer sync uses separately approved standing omission scope instead of failing strict preflight first",async()=>{
 const h=await setupStandingPaidFixture();assert.equal(await run(),1);assert.deepEqual(h.counts(),{populationReads:2,nullReads:2});assert.deepEqual(writes.map(w=>w.body),[{pipelineStageId:"paid",monetaryValue:0}]);delete process.env.GHL_STANDING_IDENTITY_ENABLED;
});
test("standing evidence expiring during card GET holds before admission without renewal",async()=>{
 const h=await setupStandingPaidFixture(),realNow=Date.now;
 beforeRead=()=>{const expiry=realNow()+300001;Date.now=()=>expiry;};
 try {assert.equal(await run(),0);assert.equal(writes.length,0);assert.equal(writerState.rows[0].status,"running");assert.equal(writerState.rows[0].errorMessage,null);
  assert.ok(reviews.some(r=>r.reason.includes("Standing identity evidence expired")));
  assert.deepEqual(h.counts(),{populationReads:2,nullReads:2});assert.equal(process.env.GHL_STANDING_IDENTITY_POLICY,h.raw);assert.equal(h.p.approvedAt,"2025-01-01T00:00:00Z");
 }finally{Date.now=realNow;delete process.env.GHL_STANDING_IDENTITY_ENABLED;}
});
for(const kind of ["expiry","revocation"] as const)test(`standing ${kind} after durable claim fences before PUT`,async()=>{
 const h=await setupStandingPaidFixture(),realNow=Date.now;
 const check=writerState.writer.assertPending.bind(writerState.writer);writerState.writer.assertPending=async(id)=>{await check(id);if(kind==="expiry"){const expiry=realNow()+300001;Date.now=()=>expiry;}else delete process.env.GHL_STANDING_IDENTITY_ENABLED;};
 try {assert.equal(await run(),0);assert.equal(writes.length,0);assert.equal(writerState.rows[0].status,"blocked");assert.match(writerState.rows[0].errorMessage,/"state":"pending"/);await assert.rejects(writerState.writer.finish("complete"));
  assert.deepEqual(h.counts(),{populationReads:2,nullReads:2});assert.equal(process.env.GHL_STANDING_IDENTITY_POLICY,h.raw);
 }finally{Date.now=realNow;delete process.env.GHL_STANDING_IDENTITY_ENABLED;}
});
test("standing revocation during final read withholds admission rather than retaining cached grant",async()=>{
 await setupStandingPaidFixture();beforeRead=()=>{delete process.env.GHL_STANDING_IDENTITY_ENABLED;};
 assert.equal(await run(),0);assert.equal(writes.length,0);assert.equal(writerState.rows[0].errorMessage,null);assert.equal(writerState.rows[0].status,"running");
});

async function setupOverlapCancellation(){
 const owned=await seedOwnedEnrollment();
 const {workflowInventoryHash}=await import("../lib/ghl-paid-cycle-workflows");
 const at=new Date().toISOString();
 Object.assign(process.env,{GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED:"true",GHL_RECURRING_DUE_DATE_ENABLED:"true",
  GHL_INVOICE_WRITE_MODE:"sync",SYNC_ADMISSION_MODE:"cron_only"});
 const b={...debt,id:"successor",invoiceStatus:"awaiting_payment",issuedDate:"2026-11-01",dueDate:"2026-12-01"};
 source=[structuredClone(paid),b];invoices.push({...cached,id:"local-successor",jobberInvoiceId:b.id,customer:customers[0]});
 const entries=[{id:"reminder",locationId:DUE_DATE_LOCATION,status:"published",version:1,updatedAt:at},{id:"closure",locationId:DUE_DATE_LOCATION,status:"draft",version:1,updatedAt:at}];
 const policy:any={version:1,approvalId:process.env.GHL_WRITE_APPROVAL_ID,expiresAt:new Date(Date.now()+3600000).toISOString(),locationId:DUE_DATE_LOCATION,
  pipelineId:"pipeline",sentStageId:"sent",overdueStageId:"overdue",reminderId:"reminder",closureId:"closure",executionClearance:[],
  inventory:{entries,sha256:workflowInventoryHash(entries,DUE_DATE_LOCATION)},definitionReviewRef:"synthetic",listenerInventoryReviewRef:"synthetic",dateOnlyTriggerQaRef:"synthetic",
  contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,freshPaymentAndChannelGuards:true,noCatchupOrRetainedExecutionReplay:true,
   unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true},
  directRemoval:{apiVersion:"v3",contractSha256:"b".repeat(64),evidenceRef:"synthetic",singleCycleWriterReviewRef:"synthetic",residualDispatchAndExternalEnrollmentRiskAcceptanceRef:"synthetic"}};
 const raw=JSON.stringify(policy);process.env.GHL_RECURRING_DUE_DATE_POLICY=raw;process.env.GHL_RECURRING_DUE_DATE_POLICY_SHA256=createHash("sha256").update(raw).digest("hex");
 let deletes=0;let reply:"ok"|"timeout"|"malformed"="ok";
 const previous=globalThis.fetch;
 globalThis.fetch=async(input:any,init:any={})=>{
  const url=new URL(String(input));
  if(url.hostname==="api.getjobber.com" && JSON.parse(init.body).query.includes("VerifyDateOwnerInvoices"))
   return Response.json({data:{client:{id:owner.jobberClientId,invoices:{nodes:source,pageInfo:{hasNextPage:false,endCursor:null}}}}});
  if(url.pathname==="/workflows/")return Response.json({workflows:entries});
  if(init.method==="PUT" && url.pathname.endsWith("/"+card.id) && JSON.parse(init.body).customFields){
   const body=JSON.parse(init.body);writes.push({method:"PUT",id:card.id,body});
   cards[0].customFields=body.customFields.map((v:any)=>({id:v.id,fieldValue:v.field_value}));
   return Response.json({opportunity:cards[0]});
  }
  if(init.method==="DELETE"){
   assert.equal(url.pathname,`/contacts/${contact.id}/workflow/reminder`);deletes++;
   const pending=(await writerState.writer.readCycleHistory()).at(-1)!;assert.equal(pending.state,"pending");
   assert.equal(pending.intent.workflowRemoval!.purpose,"paid_cycle_cancellation");
   if(reply==="timeout")throw new Error("unknown timeout");
   return Response.json(reply==="ok"?{succeeded:true}:{});
  }
  return previous(input,init);
 };
 return {owned,policy,deletes:()=>deletes,setReply:(value:typeof reply)=>{reply=value;}};
}
test("actual hook cancels paid owned A while B remains unpaid without aggregate card writes",async()=>{
 const h=await setupOverlapCancellation(),before=structuredClone(cards[0]);
 try{
  assert.equal(await run("sync"),1,JSON.stringify(reviews));assert.equal(h.deletes(),1);assert.equal(writes.length,0);assert.deepEqual(cards[0],before);
  const history=await writerState.writer.readCycleHistory();assert.equal(history.length,2);
  assert.equal(history[1].intent.workflowRemoval!.oldPaidJournalId,undefined);
  assert.equal(history[1].state,"confirmed");assert.ok(!history.some(w=>w.intent.cycle?.phase==="paid"));
  assert.equal(await run("sync"),0);assert.equal(h.deletes(),1);assert.equal(writes.length,0);
 }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
for(const response of ["timeout","malformed"] as const)test(`actual overlap cancellation ${response} fences without retry`,async()=>{
 const h=await setupOverlapCancellation();h.setReply(response);
 try{
  assert.equal(await run("sync"),0);assert.equal(h.deletes(),1);assert.equal(writes.length,0);
  assert.equal(writerState.rows[0].status,"blocked");assert.equal((await writerState.writer.readCycleHistory()).at(-1)!.state,"pending");
  assert.equal(await run("sync"),0);assert.equal(h.deletes(),1);
 }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
test("actual overlap cancellation holds unknown ownership/date and preserves unpaid original cycle",async()=>{
 for(const kind of ["unpaid-original","wrong-date","closed"]){
  const h=await setupOverlapCancellation();
  try{
   if(kind==="unpaid-original")source[0]=structuredClone(debt);
   if(kind==="wrong-date")cards[0].customFields[0].fieldValue="2026-06-02";
   if(kind==="closed")cards[0].status="won";
   assert.equal(await run("sync"),0);assert.equal(h.deletes(),0);assert.equal(writes.length,0);
  }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
 }
});
test("cancelled A receipt is reused after genuine aggregate Paid and later C reset",async()=>{
 const h=await setupOverlapCancellation();
 try{
  assert.equal(await run("sync"),1);assert.equal(h.deletes(),1);
  source[1]={...source[1],invoiceStatus:"paid",amounts:{total:100,invoiceBalance:0}};
  assert.equal(await run("sync"),1,JSON.stringify(reviews));assert.equal(cards[0].pipelineStageId,"paid");assert.equal(cards[0].monetaryValue,0);
  const paidClaim=(await writerState.writer.readCycleHistory()).find(w=>w.intent.cycle?.phase==="paid")!;
  assert.ok(paidClaim.intent.cycle?.paidDateWitness);assert.ok(paidClaim.paidDateReadback);
  source.push({...debt,id:"later-c",invoiceStatus:"awaiting_payment",issuedDate:"2026-11-01",dueDate:"2026-12-02"});
  invoices.push({...cached,id:"local-c",jobberInvoiceId:"later-c",customer:customers[0]});
  writes=[];
  assert.equal(await run("sync"),1,JSON.stringify(reviews));assert.equal(h.deletes(),1);
  assert.equal(cards[0].pipelineStageId,"sent");assert.equal(cards[0].monetaryValue,100);
  const history=await writerState.writer.readCycleHistory();
  assert.equal(history.filter(w=>w.intent.workflowRemoval).length,1);
  assert.equal(history.at(-1)!.intent.cycle!.phase,"reset_stage");
  assert.equal(history.at(-1)!.intent.cycle!.invoiceId,"later-c");
 }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
test("cancellation source change after durable intent fences before DELETE",async()=>{
 const h=await setupOverlapCancellation(),prepare=writerState.writer.prepare.bind(writerState.writer);
 writerState.writer.prepare=async(intent)=>{
  const id=await prepare(intent);
  if(intent.workflowRemoval)source[0]=structuredClone(debt);
  return id;
 };
 try{
  assert.equal(await run("sync"),0);assert.equal(h.deletes(),0);assert.equal(writes.length,0);
  assert.equal(writerState.rows[0].status,"blocked");assert.equal((await writerState.writer.readCycleHistory()).at(-1)!.state,"pending");
 }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
test("paid old source due-date edit does not prevent exact owned cancellation",async()=>{
 const h=await setupOverlapCancellation();source[0].dueDate="2026-06-02";
 try{assert.equal(await run("sync"),1,JSON.stringify(reviews));assert.equal(h.deletes(),1);assert.equal(writes.length,0);}
 finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
async function setupBootstrapSyncFixture(){
 setup();
 const {planOpportunityDueDate}=await import("../lib/invoice-workflow-binding");
 const {bootstrapCycleKey}=await import("../lib/ghl-existing-overdue-bootstrap");
 const {workflowInventoryHash}=await import("../lib/ghl-paid-cycle-workflows");
 const {invoiceCalendarDate,addInvoiceCalendarDays}=await import("../lib/invoice-reminder-clock");
 const now=new Date(),at=now.toISOString(),today=invoiceCalendarDate(now)!;
 const due=addInvoiceCalendarDays(today,-16)!,issued=addInvoiceCalendarDays(today,-30)!;
 process.env.GHL_LOCATION_ID=DUE_DATE_LOCATION;
 Object.assign(process.env,{GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED:"true",GHL_RECURRING_DUE_DATE_ENABLED:"true",
  GHL_CYCLE_OWNERSHIP_ENABLED:"true",GHL_INVOICE_WRITE_MODE:"sync",SYNC_ADMISSION_MODE:"cron_only"});
 cards[0].locationId=DUE_DATE_LOCATION;cards[0].customFields=[];
 source=[{...debt,issuedDate:issued,dueDate:due}];
 const scope={locationId:DUE_DATE_LOCATION,pipelineId:"pipeline",opportunityId:card.id,contactId:contact.id,jobberClientId:owner.jobberClientId,invoiceId:debt.id,workflowId:"fixed"};
 const snapshot:any={now:at,source:{observedAt:at,complete:true,invoices:[{id:debt.id,jobberClientId:owner.jobberClientId,status:"past_due",totalCents:10000,balanceCents:10000,issuedDate:issued,dueDate:due,category:null}]},
  card:{id:card.id,locationId:DUE_DATE_LOCATION,contactId:contact.id,pipelineId:"pipeline",stageId:"overdue",status:"open",amountCents:10000,observedAt:at},
  binding:{...scope,method:"unique_unpaid_invoice",evidenceRef:"synthetic",identityVerified:true,uniqueInvoiceCardVerified:true},
  stageIds:{sent:"sent",overdue:"overdue"},field:{id:DUE_DATE_FIELD,locationId:DUE_DATE_LOCATION,model:"opportunity",key:"opportunity.due_date",type:"DATE",currentValueKnown:true,currentValue:null}};
 const entries=[{id:"fixed",locationId:DUE_DATE_LOCATION,status:"published",version:1,updatedAt:at},{id:"closure",locationId:DUE_DATE_LOCATION,status:"draft",version:1,updatedAt:at}];
 const expiry=new Date(now.getTime()+3600000).toISOString();
 const policy:any={version:1,approvalId:process.env.GHL_WRITE_APPROVAL_ID,expiresAt:expiry,locationId:DUE_DATE_LOCATION,pipelineId:"pipeline",
  sentStageId:"sent",overdueStageId:"overdue",reminderId:"fixed",closureId:"closure",executionClearance:[],
  inventory:{entries,sha256:workflowInventoryHash(entries,DUE_DATE_LOCATION)},definitionReviewRef:"synthetic",listenerInventoryReviewRef:"synthetic",dateOnlyTriggerQaRef:"synthetic",
  contract:{exactOpportunityStageTriggerOnly:true,sourceDueDateAnchoredWaits:true,noCatchupOrRetainedExecutionReplay:true,unrelatedDateListenersAbsent:true,dateOnlyUpdateCannotEnrollOrSend:true,
    paymentGuard:{kind:"native_hourly_sync",intervalMinutes:60,cronExpression:"0 * * * *",scheduleReviewRef:"synthetic",sourceSyncBeforeGhlReviewRef:"synthetic",
      nativeStageAndPositiveValueGuardReviewRef:"synthetic",nativeChannelSuppressionReviewRef:"synthetic",stalePaymentRiskAcceptanceRef:"synthetic"}},
  existingOverdueBootstrap:{reviewRef:"synthetic",nativeSkipRouteQaRef:"synthetic",sentTransitionReviewRef:"synthetic",futureFactGuardReviewRef:"synthetic",exclusiveCycleWriterReviewRef:"synthetic",
    cohort:[{...scope,sourceFingerprint:planOpportunityDueDate(snapshot).intent!.sourceFingerprint,cycleKey:bootstrapCycleKey(scope),dueOn:due,category:"maintenance",
      categoryReviewRef:"synthetic-current-native-branch-review",reviewedAt:new Date(now.getTime()-86400000).toISOString(),expiresAt:expiry,reviewRef:"synthetic-original-review",
      clearanceMode:"historical_review_v1",noPriorCurrentCycleEnrollment:true,noActiveOldCycle:true}]}};
 const pin=()=>{const raw=JSON.stringify(policy);process.env.GHL_RECURRING_DUE_DATE_POLICY=raw;process.env.GHL_RECURRING_DUE_DATE_POLICY_SHA256=createHash("sha256").update(raw).digest("hex");};pin();
 const previous=globalThis.fetch;
 globalThis.fetch=async(input:any,init:any={})=>{
  const url=new URL(String(input));
  if(url.hostname==="api.getjobber.com" && JSON.parse(init.body).query.includes("VerifyDateOwnerInvoices"))return Response.json({data:{client:{id:owner.jobberClientId,invoices:{nodes:source,pageInfo:{hasNextPage:false,endCursor:null}}}}});
  if(url.pathname.includes("/customFields"))return Response.json({customFields:[{id:DUE_DATE_FIELD,fieldKey:"opportunity.due_date",dataType:"DATE",model:"opportunity",locationId:DUE_DATE_LOCATION}]});
  if(url.pathname==="/workflows/")return Response.json({workflows:entries});
  if(init.method==="PUT" && url.pathname.endsWith("/"+card.id)){
   const body=JSON.parse(init.body);
   if(body.customFields){writes.push({method:"PUT",id:card.id,body});cards[0].customFields=body.customFields.map((v:any)=>({id:v.id,fieldValue:v.field_value}));return Response.json({opportunity:cards[0]});}
  }
  return previous(input,init);
 };
 return {scope,policy,pin,due};
}
test("real sync hook bootstraps reviewed existing Overdue through durable stage/date/enrollment",async()=>{
 const h=await setupBootstrapSyncFixture();
 try{
  assert.equal(await run("sync"),1,JSON.stringify(reviews));
  assert.deepEqual(writes.map(w=>w.body.pipelineStageId??"date"),["sent","date","overdue"]);
  assert.equal(cards[0].customFields[0].fieldValue,h.due);
  const history=await writerState.writer.readCycleHistory();
  assert.deepEqual(history.map(w=>w.intent.bootstrap?.phase),["claim","bootstrap_stage","source_date","enroll_stage"]);
  assert.ok(history.every(w=>w.state==="confirmed"));assert.equal(history.at(-1)!.intent.cycle!.phase,"enroll");
  writes=[];assert.equal(await run("sync"),0);assert.equal(writes.length,0);
 }finally{delete process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED;}
});
test("real bootstrap hook preserves default disabled and review holds",async()=>{
 await setupBootstrapSyncFixture();
 try{
  assert.equal(await run("review"),0);assert.equal(writes.length,0);
  delete process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED;assert.equal(await run("sync"),0);assert.equal(writes.length,0);
 }finally{delete process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED;}
});
test("actual bootstrap hook fences unknown first stage with no date/reentry retry",async()=>{
 await setupBootstrapSyncFixture();putFailure="after";
 try{
  assert.equal(await run("sync"),0);assert.equal(writes.length,1);assert.equal(writes[0].body.pipelineStageId,"sent");
  assert.equal(writerState.rows[0].status,"blocked");
  assert.equal((await writerState.writer.readCycleHistory()).at(-1)!.state,"pending");
  await run("sync");assert.equal(writes.length,1);
 }finally{delete process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED;}
});
test("actual bootstrap hook stops on source payment after first stage",async()=>{
 await setupBootstrapSyncFixture();const previous=globalThis.fetch;
 globalThis.fetch=async(input:any,init:any={})=>{
  const response=await previous(input,init);
  if(init.method==="PUT" && JSON.parse(init.body).pipelineStageId==="sent")source[0]={...source[0],invoiceStatus:"paid",amounts:{total:100,invoiceBalance:0}};
  return response;
 };
 try{
  assert.equal(await run("sync"),0);assert.deepEqual(writes.map(w=>w.body.pipelineStageId??"date"),["sent"]);
  assert.equal(writerState.rows[0].status,"blocked");
 }finally{delete process.env.GHL_EXISTING_OVERDUE_BOOTSTRAP_ENABLED;}
});
test("actual cancellation removes paid A with two unpaid successors while holding both",async()=>{
 const h=await setupOverlapCancellation(),before=structuredClone(cards[0]);
 source.push({...debt,id:"second-successor",invoiceStatus:"awaiting_payment",issuedDate:"2026-11-01",dueDate:"2026-12-02"});
 invoices.push({...cached,id:"local-second-successor",jobberInvoiceId:"second-successor",customer:customers[0]});
 try{
  assert.equal(await run("sync"),1,JSON.stringify(reviews));assert.equal(h.deletes(),1);
  assert.equal(writes.length,0);assert.deepEqual(cards[0],before);
  assert.equal((await writerState.writer.readCycleHistory()).at(-1)!.intent.workflowRemoval!.purpose,"paid_cycle_cancellation");
 }finally{delete process.env.GHL_DIRECT_WORKFLOW_REMOVAL_ENABLED;}
});
