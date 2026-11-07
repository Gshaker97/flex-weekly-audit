import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { planOpenInvoiceStatusRefresh, refreshOpenInvoiceStatuses, OpenInvoiceSnapshot } from "../lib/open-invoice-status-refresh";

function cached(id = "synthetic-invoice", amount = 100): OpenInvoiceSnapshot {
  return {
    id: `local-${id}`, jobberInvoiceId: id, invoiceStatus: "awaiting_payment",
    total: amount, amountDue: amount, customerId: "local-owner",
    customer: { jobberClientId: "synthetic-owner" }, lastSyncedAt: new Date("2026-11-07T02:12:00Z"),
  };
}
function source(invoice = cached(), patch: Record<string, unknown> = {}) {
  return { id: invoice.jobberInvoiceId, invoiceStatus: "past_due", amounts: { total: invoice.total, invoiceBalance: invoice.amountDue }, client: { id: "synthetic-owner" }, ...patch };
}
const reader = (rows: Record<string, unknown>) => async (_query: string, variables: Record<string, string>) =>
  Object.fromEntries(Object.entries(variables).map(([key, id]) => [key.replace("id", "i"), rows[id]]));

let records: OpenInvoiceSnapshot[];
let writes: Array<{ where: any; data: any }>;
let transactions: number;
let sourceRows: Record<string, unknown>;
let response: (() => Response | Promise<Response>) | undefined;
let failedUpdate: number | undefined;
let fetches: number;
let cacheReads: number;
beforeEach(() => {
  delete process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED;
  records = [cached()]; sourceRows = { [records[0].jobberInvoiceId]: source(records[0]) };
  writes = []; transactions = 0; fetches = 0; cacheReads = 0; response = undefined; failedUpdate = undefined;
  (prisma.invoiceRecord as any).findMany = async (query: any) => {
    cacheReads++;
    assert.deepEqual(query.where, { invoiceStatus: { in: ["awaiting_payment", "past_due"] } }, "no issue-date cutoff or balance filter");
    return records;
  };
  (prisma.jobberAuth as any).findFirst = async () => ({ accessToken: "synthetic-only", expiresAt: new Date(Date.now() + 3600000) });
  (prisma.$transaction as any) = async (callback: any, options: any) => {
    transactions++;
    assert.equal(options.isolationLevel, "Serializable");
    const staged: typeof writes = [];
    const result = await callback({ invoiceRecord: { updateMany: async (update: any) => {
      staged.push(update);
      return { count: staged.length === failedUpdate ? 0 : 1 };
    } } });
    writes.push(...staged);
    return result;
  };
  globalThis.fetch = async (input: any, init: any) => {
    fetches++;
    assert.equal(String(input), "https://api.getjobber.com/api/graphql", "never GHL or another provider");
    assert.equal(init.method, "POST");
    if (response) return response();
    const body = JSON.parse(init.body);
    assert.ok(body.query.startsWith("query RefreshOpenInvoiceStatuses"));
    assert.ok(!body.query.includes("mutation"));
    return Response.json({ data: await reader(sourceRows)(body.query, body.variables) });
  };
});

test("five synthetic status-only differences are corrected without an updatedAt filter", async () => {
  // Invented amounts; no production invoice values or identities.
  const amounts = [120, 340, 55, 85, 200];
  const invoices = amounts.map((amount, i) => cached(`synthetic-${i}`, amount));
  const rows = Object.fromEntries(invoices.map(invoice => [invoice.jobberInvoiceId, source(invoice)]));
  const plan = await planOpenInvoiceStatusRefresh(invoices, async (query, variables) => {
    assert.equal(query.includes("updatedAt"), false);
    assert.equal(query.includes("issuedDate"), false);
    assert.equal(Object.keys(variables).length, 5);
    return reader(rows)(query, variables);
  });
  assert.equal(plan.checked, 5); assert.equal(plan.updates.length, 5); assert.deepEqual(plan.holds, []);
  assert.equal(plan.updates.reduce((sum, update) => sum + update.cached.amountDue, 0), 800);
  assert.ok(plan.updates.every(update => update.invoiceStatus === "past_due"));
});

test("complete batches include every ID; only the final complete result is returned", async () => {
  const invoices = Array.from({ length: 51 }, (_, i) => cached(`synthetic-${i}`));
  const rows = Object.fromEntries(invoices.map(invoice => [invoice.jobberInvoiceId, source(invoice)]));
  const sizes: number[] = [];
  const plan = await planOpenInvoiceStatusRefresh(invoices, async (query, variables) => {
    sizes.push(Object.keys(variables).length); return reader(rows)(query, variables);
  });
  assert.deepEqual(sizes, [25, 25, 1]); assert.equal(plan.updates.length, 51);
});

test("empty target list performs no source reads", async () => {
  assert.deepEqual(await planOpenInvoiceStatusRefresh([], async () => { throw new Error("unexpected read"); }), { checked: 0, updates: [], holds: [] });
});

test("same explicit status is a no-op even if caller believes due date elapsed", async () => {
  const plan = await planOpenInvoiceStatusRefresh([cached()], reader({ "synthetic-invoice": source(cached(), { invoiceStatus: "awaiting_payment", dueDate: "2000-01-01" }) }));
  assert.deepEqual(plan.updates, []); assert.deepEqual(plan.holds, []);
});

test("a return from past_due to awaiting_payment is accepted from explicit source only", async () => {
  const invoice = { ...cached(), invoiceStatus: "past_due" };
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({ [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: "awaiting_payment" }) }));
  assert.equal(plan.updates[0].invoiceStatus, "awaiting_payment");
});

test("null source invoice holds only that row and never invents void, zero, or paid", async () => {
  const other = cached("available");
  const plan = await planOpenInvoiceStatusRefresh([cached(), other], reader({ "synthetic-invoice": null, available: source(other) }));
  assert.equal(plan.updates.length, 1); assert.equal(plan.holds.length, 1);
  assert.equal(plan.updates[0].cached.jobberInvoiceId, "available"); assert.equal(plan.holds[0].jobberInvoiceId, "synthetic-invoice");
});

for (const [name, patch] of Object.entries({
  "missing status": { invoiceStatus: undefined }, "null status": { invoiceStatus: null }, "unknown status": { invoiceStatus: "something_new" },
  "null amounts": { amounts: null }, "null balance": { amounts: { total: 100, invoiceBalance: null } },
  "missing total": { amounts: { invoiceBalance: 100 } }, "string balance": { amounts: { total: 100, invoiceBalance: "100" } },
  "nonfinite balance": { amounts: { total: 100, invoiceBalance: Infinity } }, "subcent balance": { amounts: { total: 100, invoiceBalance: 99.999 } },
  "negative credit": { amounts: { total: 100, invoiceBalance: -1 } }, "balance over total": { amounts: { total: 100, invoiceBalance: 101 } },
  "paid positive": { invoiceStatus: "paid" }, "open zero": { amounts: { total: 100, invoiceBalance: 0 } },
  "missing owner": { client: null }, "changed owner": { client: { id: "another-owner" } },
  "changed total": { amounts: { total: 101, invoiceBalance: 100 } }, "changed balance": { amounts: { total: 100, invoiceBalance: 99 } },
})) {
  test(`${name} holds status without zero defaults`, async () => {
    const plan = await planOpenInvoiceStatusRefresh([cached()], reader({ "synthetic-invoice": source(cached(), patch) }));
    assert.deepEqual(plan.updates, []); assert.equal(plan.holds.length, 1);
  });
}

test("explicit paid and void can be copied only with known unchanged balances", async () => {
  for (const status of ["paid", "void", "bad_debt", "draft"]) {
    const invoice = { ...cached(), amountDue: 0 };
    const plan = await planOpenInvoiceStatusRefresh([invoice], reader({ [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: status }) }));
    assert.equal(plan.updates[0].invoiceStatus, status);
    assert.deepEqual(Object.keys(plan.updates[0]).sort(), ["cached", "invoiceStatus"]);
  }
});

test("unknown cache money, missing cached owner, and non-open cache state are held", async () => {
  for (const patch of [{ amountDue: NaN }, { total: NaN }, { customer: null }, { invoiceStatus: "paid" }]) {
    const plan = await planOpenInvoiceStatusRefresh([{ ...cached(), ...patch }], reader({ "synthetic-invoice": source() }));
    assert.deepEqual(plan.updates, []); assert.equal(plan.holds.length, 1);
  }
});

for (const [name, data] of Object.entries({ "null envelope": null, "missing alias": {}, "undefined alias": { i0: undefined }, "wrong identity": { i0: source(cached("wrong")) }, "nonobject row": { i0: [] }, "unexpected alias": { i0: source(), extra: source() } })) {
  test(`${name} rejects the entire source read`, async () => {
    await assert.rejects(planOpenInvoiceStatusRefresh([cached()], async () => data));
  });
}

test("duplicate cached IDs and empty identities reject before source read", async () => {
  for (const invoices of [[cached(), cached()], [{ ...cached(), jobberInvoiceId: "" }], [cached(), { ...cached("second"), id: cached().id }]]) {
    await assert.rejects(planOpenInvoiceStatusRefresh(invoices, async () => { throw new Error("unexpected read"); }), /cached invoice identity/);
  }
});

test("default release hold performs no source or cache actions", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1"]) {
    if (value === undefined) delete process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED;
    else process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = value;
    assert.equal(await refreshOpenInvoiceStatuses(), null);
  }
  assert.equal(cacheReads, 0); assert.equal(fetches, 0); assert.equal(transactions, 0); assert.deepEqual(writes, []);
});

test("enabled refresh writes only status and guards every cached snapshot value", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  const result = await refreshOpenInvoiceStatuses();
  assert.equal(result?.updates.length, 1); assert.equal(transactions, 1); assert.equal(fetches, 1);
  assert.deepEqual(writes[0].data, { invoiceStatus: "past_due" });
  assert.deepEqual(writes[0].where, {
    id: records[0].id, jobberInvoiceId: records[0].jobberInvoiceId, invoiceStatus: records[0].invoiceStatus,
    total: records[0].total, amountDue: records[0].amountDue, customerId: records[0].customerId,
    customer: { is: { jobberClientId: "synthetic-owner" } }, lastSyncedAt: records[0].lastSyncedAt,
  });
});

test("repeat refresh after the corrected cache state performs no transaction", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  await refreshOpenInvoiceStatuses(); records[0].invoiceStatus = "past_due";
  await refreshOpenInvoiceStatuses(); assert.equal(transactions, 1); assert.equal(writes.length, 1);
});

test("late batch HTTP error discards earlier valid responses before opening a transaction", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  records = Array.from({ length: 26 }, (_, i) => cached(`synthetic-${i}`));
  response = () => fetches === 1
    ? Response.json({ data: Object.fromEntries(records.slice(0, 25).map((invoice, i) => [`i${i}`, source(invoice)])) })
    : new Response("synthetic error", { status: 503 });
  await assert.rejects(refreshOpenInvoiceStatuses(), /503/);
  assert.equal(fetches, 2); assert.equal(transactions, 0); assert.deepEqual(writes, []);
});

test("partial data with GraphQL errors is rejected before any write", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  response = () => Response.json({ data: { i0: source() }, errors: [{ message: "synthetic field error" }] });
  await assert.rejects(refreshOpenInvoiceStatuses(), /GraphQL error/);
  assert.equal(transactions, 0); assert.deepEqual(writes, []);
});

test("changed cache on later update rolls back the transaction without replay", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  records.push(cached("second")); sourceRows.second = source(records[1]); failedUpdate = 2;
  await assert.rejects(refreshOpenInvoiceStatuses(), /rolled back/);
  assert.equal(transactions, 1); assert.deepEqual(writes, []);
});

test("source null and unchanged rows do not open a transaction", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  sourceRows[records[0].jobberInvoiceId] = null;
  assert.equal((await refreshOpenInvoiceStatuses())?.holds.length, 1);
  assert.equal(transactions, 0); assert.deepEqual(writes, []);
});

test("sync integration refreshes before aggregates and GHL without swallowing errors", () => {
  const sync = readFileSync(new URL("../lib/sync.ts", import.meta.url), "utf8");
  const invocation = sync.indexOf('await step("refreshOpenInvoiceStatuses", () => refreshOpenInvoiceStatuses());');
  assert.ok(invocation > 0);
  assert.ok(invocation < sync.indexOf('await step("recomputeCustomerAggregates"'));
  assert.ok(invocation < sync.indexOf("await syncGhlInvoicePipeline({ writer })"));
  assert.equal(sync.slice(sync.lastIndexOf("if (!heavy.ok)", invocation), invocation).includes("catch"), false);
});
