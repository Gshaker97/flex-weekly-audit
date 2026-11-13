import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prisma } from "../lib/prisma";
import { planOpenInvoiceStatusRefresh, refreshOpenInvoiceStatuses, OpenInvoiceSnapshot } from "../lib/open-invoice-status-refresh";

function cached(id = "synthetic-invoice", amount = 100): OpenInvoiceSnapshot {
  return {
    id: `local-${id}`, jobberInvoiceId: id, invoiceStatus: "awaiting_payment",
    total: amount, amountPaid: 0, amountDue: amount, customerId: "local-owner",
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
    total: records[0].total, amountPaid: records[0].amountPaid,
    amountDue: records[0].amountDue, customerId: records[0].customerId,
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

// --- Paid-invoice correction: status and balance from one authoritative read ---
// Every value below is synthetic. No production invoice, customer or identity.

function settled(id = "synthetic-invoice", amount = 90): OpenInvoiceSnapshot {
  return { ...cached(id, amount), invoiceStatus: "past_due" };
}

test("an open invoice paid in full is corrected in a single pass", async () => {
  const invoice = settled();
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
    [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 } }),
  }));
  assert.deepEqual(plan.holds, []);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].invoiceStatus, "paid");
  assert.equal(plan.updates[0].amountDue, 0);
  assert.equal(plan.updates[0].amountPaid, 90, "derived as total minus balance from the same read");
});

test("the shipped behaviour of holding this case is what changed, and only this case", async () => {
  // A balance that moves without a status change is still the full sync's job.
  const invoice = settled();
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
    [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: "past_due", amounts: { total: 90, invoiceBalance: 45 } }),
  }));
  assert.deepEqual(plan.updates, []);
  assert.match(plan.holds[0].reason, /without a status change/);
});

for (const [status, invoiceBalance] of [["void", 0], ["bad_debt", 0], ["draft", 0], ["awaiting_payment", 45]] as Array<[string, number]>) {
  test(`a ${status} transition never carries a balance across`, async () => {
    const invoice = settled();
    const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
      [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: status, amounts: { total: 90, invoiceBalance } }),
    }));
    assert.deepEqual(plan.updates, [], "only a settled-to-zero payment may move amounts");
    assert.match(plan.holds[0].reason, /non-payment transition/);
  });
}

test("a status-only correction still writes status alone", async () => {
  const invoice = settled();
  const plan = await planOpenInvoiceStatusRefresh([invoice], reader({
    [invoice.jobberInvoiceId]: source(invoice, { invoiceStatus: "awaiting_payment", amounts: { total: 90, invoiceBalance: 90 } }),
  }));
  assert.deepEqual(Object.keys(plan.updates[0]).sort(), ["cached", "invoiceStatus"]);
});

// --- An older read cannot overwrite a newer verified payment ---

test("a stale source read claiming the invoice is still open is held, not applied", async () => {
  // The cache already holds the newer verified payment; the read is older.
  const paidAlready: OpenInvoiceSnapshot = { ...cached(), invoiceStatus: "paid", amountDue: 0, amountPaid: 100 };
  const plan = await planOpenInvoiceStatusRefresh([paidAlready], reader({
    [paidAlready.jobberInvoiceId]: source(paidAlready, { invoiceStatus: "past_due", amounts: { total: 100, invoiceBalance: 100 } }),
  }));
  assert.deepEqual(plan.updates, [], "a newer verified payment is never reopened by an older read");
  assert.match(plan.holds[0].reason, /no longer open/);
});

test("a stale in-flight correction matches no row and rolls the batch back", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  records = [settled()];
  sourceRows = { [records[0].jobberInvoiceId]: source(records[0], { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 } }) };
  failedUpdate = 1; // another pass already wrote the verified payment
  await assert.rejects(refreshOpenInvoiceStatuses(), /rolled back/);
  assert.equal(transactions, 1);
  assert.deepEqual(writes, [], "nothing is persisted when the pre-image no longer matches");
});

test("the write guard pins every amount, so a newer payment blocks a stale correction", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  records = [settled()];
  sourceRows = { [records[0].jobberInvoiceId]: source(records[0], { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 } }) };
  await refreshOpenInvoiceStatuses();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].data, { invoiceStatus: "paid", amountDue: 0, amountPaid: 90 });
  for (const field of ["invoiceStatus", "total", "amountPaid", "amountDue", "lastSyncedAt"]) {
    assert.ok(field in writes[0].where, `${field} is part of the optimistic guard`);
  }
  assert.equal(writes[0].where.amountDue, 90, "guarded on the pre-payment balance");
  assert.equal(writes[0].where.amountPaid, 0);
  assert.equal("paidAt" in writes[0].data, false, "no invented payment timestamp");
  assert.equal("lastSyncedAt" in writes[0].data, false, "the row was not fully refreshed");
});

// --- Incomplete or conflicting reads leave the last verified values intact ---

for (const [name, patch] of Object.entries({
  "paid claimed with a balance still owed": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 90 } },
  "paid claimed with a partial balance": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 45 } },
  "paid claimed with a credit balance": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: -1 } },
  "paid claimed with a balance over total": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 91 } },
  "paid claimed with the total also changed": { invoiceStatus: "paid", amounts: { total: 140, invoiceBalance: 0 } },
  "paid claimed with no amounts block": { invoiceStatus: "paid", amounts: null },
  "paid claimed with a null balance": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: null } },
  "paid claimed with a missing balance": { invoiceStatus: "paid", amounts: { total: 90 } },
  "paid claimed with a string balance": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: "0" } },
  "paid claimed with a sub-cent balance": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0.001 } },
  "paid claimed by a different owner": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 }, client: { id: "another-owner" } },
  "paid claimed with no owner": { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 }, client: null },
  "unrecognised settled status": { invoiceStatus: "settled", amounts: { total: 90, invoiceBalance: 0 } },
  "source object unavailable": null,
})) {
  test(`${name} holds and leaves the verified values untouched`, async () => {
    const invoice = settled();
    const pristine = structuredClone({ ...invoice, lastSyncedAt: invoice.lastSyncedAt.toISOString() });
    const row = patch === null ? null : source(invoice, patch as Record<string, unknown>);
    const plan = await planOpenInvoiceStatusRefresh([invoice], reader({ [invoice.jobberInvoiceId]: row }));
    assert.deepEqual(plan.updates, [], "no correction is produced");
    assert.equal(plan.holds.length, 1);
    assert.deepEqual(
      structuredClone({ ...invoice, lastSyncedAt: invoice.lastSyncedAt.toISOString() }), pristine,
      "the cached snapshot is never mutated, so the last verified values survive"
    );
  });
}

for (const [name, data] of Object.entries({
  "truncated envelope": {},
  "null envelope": null,
  "extra alias": { i0: null, i1: null },
  "non-object envelope": "paid",
})) {
  test(`${name} aborts before any paid correction exists`, async () => {
    const invoice = settled();
    await assert.rejects(planOpenInvoiceStatusRefresh([invoice], async () => data as unknown));
    assert.equal(invoice.invoiceStatus, "past_due");
    assert.equal(invoice.amountDue, 90);
  });
}

test("one conflicting row never suppresses a valid correction, and vice versa", async () => {
  const good = settled("synthetic-good");
  const bad = settled("synthetic-bad");
  const plan = await planOpenInvoiceStatusRefresh([good, bad], reader({
    [good.jobberInvoiceId]: source(good, { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 } }),
    [bad.jobberInvoiceId]: source(bad, { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 90 } }),
  }));
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].cached.jobberInvoiceId, good.jobberInvoiceId);
  assert.equal(plan.holds.length, 1);
  assert.equal(plan.holds[0].jobberInvoiceId, bad.jobberInvoiceId);
});

test("the correction reads Jobber only, never GHL, and issues no mutation", async () => {
  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  records = [settled()];
  sourceRows = { [records[0].jobberInvoiceId]: source(records[0], { invoiceStatus: "paid", amounts: { total: 90, invoiceBalance: 0 } }) };
  await refreshOpenInvoiceStatuses();
  assert.equal(fetches, 1); // the beforeEach fetch stub asserts the Jobber URL and rejects mutations
});

test("reminder behaviour is untouched by this module", () => {
  const module = readFileSync(new URL("../lib/open-invoice-status-refresh.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const term of ["leadconnectorhq", "notification", "reminder", "sendSms", "workflow", "mutation"]) {
    assert.equal(module.toLowerCase().includes(term.toLowerCase()), false, `${term} must not appear in the status refresh`);
  }
});
