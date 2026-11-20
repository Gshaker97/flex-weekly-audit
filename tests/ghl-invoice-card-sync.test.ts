/**
 * The per-invoice writer inside the real sync: what is off by default, what the
 * environment switch turns on, and the boundary that stops the per-customer
 * aggregate and the per-invoice writer fighting over the same card.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writerFixture } from "./helpers/sync-writer-fixture";
import { prisma } from "../lib/prisma";
import { syncGhlInvoicePipeline, type GhlInvoiceReview } from "../lib/sync";
import type { InvoiceCardWriteReport } from "../lib/ghl-invoice-card-writer";

process.env.GHL_API_KEY = "synthetic-only";

const owner = { id: "customer-a", jobberClientId: "jobber-a", email: "owner@example.test", phone: null, name: "Synthetic", companyName: null };
const contact = { id: "contact-a", email: owner.email, phone: null };
const perInvoiceCard = { id: "card-per-invoice", contactId: contact.id, pipelineId: "pipeline",
  pipelineStageId: "sent", status: "open", monetaryValue: 0, name: "Invoice #7226 — Synthetic" };
const cached = { id: "local-invoice", jobberInvoiceId: "source-invoice", customerId: owner.id, invoiceNumber: "7226",
  clientName: "Synthetic", invoiceStatus: "past_due", total: 300, amountDue: 137.5,
  issuedAt: new Date("2026-09-01"), dueAt: new Date("2026-10-01"), createdAtJobber: null };
const overdueSource = { id: cached.jobberInvoiceId, client: { id: owner.jobberClientId }, invoiceStatus: "past_due",
  amounts: { total: 300, invoiceBalance: 137.5 }, issuedDate: "2026-09-01", dueDate: "2026-10-01",
  createdAt: null, invoiceNumber: "7226" };

let customers: any[], contacts: any[], cards: any[], invoices: any[], source: any[];
let writes: any[], reviews: GhlInvoiceReview[], cardReports: InvoiceCardWriteReport[];
let writerState: ReturnType<typeof writerFixture>;

function setup(env: Record<string, string> = {}) {
  writerState = writerFixture();
  for (const key of ["GHL_PER_INVOICE_CARD_WRITES_ENABLED", "GHL_PER_INVOICE_CARD_WRITE_BUDGET",
    "GHL_PER_INVOICE_PAID_EXITS_ENABLED", "GHL_INVOICE_WRITE_MODE", "GHL_PHONE_WRITES_ENABLED",
    "GHL_RECURRING_DUE_DATE_ENABLED", "GHL_CYCLE_OWNERSHIP_ENABLED", "GHL_STANDING_IDENTITY_ENABLED",
    "GHL_LEGACY_INVOICE_WORKFLOW_ID"]) delete process.env[key];
  process.env.GHL_LOCATION_ID = "synthetic-location";
  process.env.GHL_WRITE_APPROVAL_ID = "reviewed-plan-1";
  process.env.GHL_APPROVED_OPPORTUNITY_IDS = JSON.stringify([perInvoiceCard.id]);
  Object.assign(process.env, env);

  customers = [{ ...owner }]; contacts = [{ ...contact }]; cards = [];
  invoices = [{ ...cached, customer: customers[0] }]; source = [structuredClone(overdueSource)];
  writes = []; reviews = []; cardReports = [];
  (prisma.customer as any).findMany = async () => customers;
  (prisma.invoiceRecord as any).findMany = async () => invoices;
  (prisma.jobberAuth as any).findFirst = async () => ({ accessToken: "synthetic-only", expiresAt: new Date(Date.now() + 3600000) });
  globalThis.fetch = async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "api.getjobber.com") {
      if (JSON.parse(init.body).query.includes("VerifyGhlIdentityOwnership")) return Response.json({ data: { clients: {
        nodes: customers.map(c => ({ id: c.jobberClientId, emails: [{ address: c.email, primary: true }], phones: [] })),
        pageInfo: { hasNextPage: false, endCursor: null } } } });
      return Response.json({ data: { invoices: { nodes: source, pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    assert.equal(url.hostname, "services.leadconnectorhq.com");
    if (url.pathname === "/contacts/search") return Response.json({ contacts, total: contacts.length });
    if (url.pathname === "/opportunities/pipelines") return Response.json({ pipelines: [{ id: "pipeline", name: "Invoice Pipeline", stages: [
      { id: "sent", name: "Invoice Sent" }, { id: "overdue", name: "Invoice Overdue" },
      { id: "paid", name: "Invoice Paid" }, { id: "late-fee", name: "Late Fee Invoice Sent" } ] }] });
    if (url.pathname === "/opportunities/search") {
      assert.equal(url.searchParams.get("status"), "all");
      return Response.json({ opportunities: cards, meta: { total: cards.length } });
    }
    if (url.pathname === "/opportunities/" && init.method === "POST") {
      const body = JSON.parse(init.body);
      writes.push({ method: "POST", body });
      const made = { id: `card-${cards.length + 1}`, pipelineId: body.pipelineId, pipelineStageId: body.pipelineStageId,
        contactId: body.contactId, status: body.status, monetaryValue: body.monetaryValue, name: body.name };
      cards.push(made);
      return Response.json({ opportunity: made });
    }
    const target = cards.find(c => c.id === url.pathname.split("/").pop());
    if (target && init.method === "PUT") {
      const body = JSON.parse(init.body);
      writes.push({ method: "PUT", id: target.id, body });
      Object.assign(target, body);
      return Response.json({ opportunity: target });
    }
    if (target && (!init.method || init.method === "GET")) return Response.json({ opportunity: target });
    throw new Error(`Unexpected provider request: ${init.method ?? "GET"} ${url.pathname}`);
  };
}

const run = () => syncGhlInvoicePipeline({ writer: writerState.writer,
  report: entry => reviews.push(entry), perInvoiceWriteReport: entry => cardReports.push(entry) });

test("with nothing configured, the per-invoice writer does not run at all", async () => {
  setup();
  await run();
  assert.deepEqual(writes, []);
  assert.deepEqual(cardReports, []);
});

test("turning the per-customer sync to its most permissive mode does NOT turn card writes on", async () => {
  setup({ GHL_INVOICE_WRITE_MODE: "sync" });
  await run();
  assert.deepEqual(writes.filter(w => w.method === "POST"), []);
  assert.deepEqual(cardReports, []);
});

test("switched on, an invoice with no card gets one created in Invoice Sent", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  await run();
  const posts = writes.filter(w => w.method === "POST");
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { pipelineId: "pipeline", locationId: "synthetic-location",
    pipelineStageId: "sent", contactId: contact.id, name: "Invoice #7226 — Synthetic",
    status: "open", monetaryValue: 137.5 });
  assert.equal(cardReports.filter(r => r.action === "applied").length, 1);
});

test("the invoice is 50 days past due and the new card STILL goes to Sent, never Overdue", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  await run();
  // Nothing in this run may name the overdue stage as a target.
  assert.equal(writes.some(w => (w.body.pipelineStageId ?? null) === "overdue"), false);
  assert.deepEqual(cards.filter(c => c.pipelineStageId === "overdue"), []);
});

test("even with the legacy gate opened, the writer refuses the Overdue move", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true", GHL_LEGACY_INVOICE_WORKFLOW_ID: "legacy-workflow" });
  cards = [structuredClone(perInvoiceCard)];
  const legacySending = { source: "operator-confirmed-workflow-sending-disabled" as const,
    workflowId: "legacy-workflow", disabledOn: "2026-11-20", observedAt: new Date().toISOString(),
    evidenceRef: "synthetic-evidence" };
  await syncGhlInvoicePipeline({ writer: writerState.writer, legacySending,
    report: entry => reviews.push(entry), perInvoiceWriteReport: entry => cardReports.push(entry) });
  // The plan's own gate is open, so it WANTED Overdue. The writer would not.
  assert.ok(cardReports.some(r => r.reason === "overdue_writes_are_locked_off_in_this_build"));
  assert.equal(writes.some(w => w.body.pipelineStageId === "overdue"), false);
});

test("a paid invoice's card is moved to Paid with a zero balance", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  cards = [{ ...structuredClone(perInvoiceCard), monetaryValue: 137.5 }];
  source = [{ ...overdueSource, invoiceStatus: "paid", amounts: { total: 300, invoiceBalance: 0 } }];
  await run();
  const puts = writes.filter(w => w.method === "PUT" && w.id === perInvoiceCard.id);
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0].body, { pipelineStageId: "paid", monetaryValue: 0 });
  assert.equal(puts[0].body.name, undefined, "a card is never renamed");
});

test("the per-customer aggregate leaves per-invoice cards alone once the writer owns them", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true", GHL_INVOICE_WRITE_MODE: "sync" });
  cards = [structuredClone(perInvoiceCard)];
  await run();
  assert.ok(reviews.some(r => r.opportunityId === perInvoiceCard.id
    && r.action === "hold" && r.reason.includes("belongs to the per-invoice writer")));
  // The aggregate's rewrite would have renamed the card to "Synthetic — 1 overdue invoice".
  assert.equal(writes.some(w => typeof w.body?.name === "string" && w.body.name.includes("overdue invoice")), false);
});

test("without the writer on, the aggregate is still free to act on the same card", async () => {
  setup({ GHL_INVOICE_WRITE_MODE: "sync" });
  cards = [structuredClone(perInvoiceCard)];
  await run();
  assert.equal(reviews.some(r => r.reason.includes("belongs to the per-invoice writer")), false);
});

test("a run that cannot be bounded writes nothing", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true", GHL_PER_INVOICE_CARD_WRITE_BUDGET: "not-a-number" });
  await run();
  assert.deepEqual(writes.filter(w => w.method === "POST"), []);
  assert.deepEqual(cardReports, []);
});

test("writes enabled without a durable writer are refused and reported", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  await syncGhlInvoicePipeline({ report: entry => reviews.push(entry),
    perInvoiceWriteReport: entry => cardReports.push(entry) });
  assert.deepEqual(writes.filter(w => w.method === "POST"), []);
  assert.ok(reviews.some(r => r.reason.includes("no durable writer with cycle history was admitted")));
});

test("a caller can force the writer off even when the host says otherwise", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  await syncGhlInvoicePipeline({ writer: writerState.writer, perInvoiceWritesDisabled: true,
    report: entry => reviews.push(entry), perInvoiceWriteReport: entry => cardReports.push(entry) });
  assert.deepEqual(writes.filter(w => w.method === "POST"), []);
  assert.deepEqual(cardReports, []);
});

test("the budget bounds the whole run, not one customer", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true", GHL_PER_INVOICE_CARD_WRITE_BUDGET: "1" });
  const second = { id: "customer-b", jobberClientId: "jobber-b", email: "two@example.test", phone: null, name: "Other", companyName: null };
  customers.push(second);
  contacts.push({ id: "contact-b", email: second.email, phone: null });
  invoices.push({ ...cached, id: "local-invoice-2", jobberInvoiceId: "source-invoice-2",
    customerId: second.id, invoiceNumber: "7227", clientName: "Other", customer: second });
  source.push({ ...overdueSource, id: "source-invoice-2", client: { id: second.jobberClientId }, invoiceNumber: "7227" });
  await run();
  assert.equal(writes.filter(w => w.method === "POST").length, 1, "one card, then the budget is spent");
  assert.ok(cardReports.some(r => r.reason === "run_write_budget_exhausted"));
});

test("with the writer on, the aggregate stops proposing a rival card of its own", async () => {
  setup({ GHL_PER_INVOICE_CARD_WRITES_ENABLED: "true" });
  await run();
  assert.ok(reviews.some(r => r.reason === "No existing card; card creation belongs to the per-invoice writer"));
  assert.equal(reviews.some(r => typeof r.to?.name === "string" && r.to.name.includes("unpaid invoice")), false);
});

test("with the writer off, the aggregate still reports what it would create", async () => {
  setup();
  await run();
  assert.ok(reviews.some(r => typeof r.to?.name === "string" && r.to.name.includes("unpaid invoice")));
});
