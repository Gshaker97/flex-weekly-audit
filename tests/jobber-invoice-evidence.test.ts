import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AuditFailure, CacheRow, LIMITS, normalize } from '../scripts/source-audit/core';
import { Budget, JobberReader } from '../scripts/source-audit/transport';
import { deriveEvidenceTargets, EVIDENCE_LIMITS, evidenceDate, evidenceQuery, feeWording, runOptionalInvoiceEvidence, validateEvidenceSchema } from '../scripts/source-audit/invoice-evidence';
const type = (name: string, required = false) => required ? { kind: 'NON_NULL', name: null, ofType: { kind: 'SCALAR', name } } : { kind: 'SCALAR', name };
function schema(updated = true): any {
  return { __schema: { queryType: { fields: [{ name: 'invoice', args: [{ name: 'id', type: type('EncodedId', true) }], type: type('Invoice') }] } },
    invoiceMetadata: { fields: updated ? [{ name: 'updatedAt', type: type('ISO8601DateTime', true) }] : [] },
    adjustment: { kind: 'ENUM', enumValues: [{ name: 'PAYMENT' }, { name: 'REFUND' }] },
    transaction: { kind: 'ENUM', enumValues: [{ name: 'SUCCEEDED' }, { name: 'FAILED' }] },
    category: { kind: 'ENUM', enumValues: [{ name: 'SERVICE' }] } };
}
const payment = (id = 'payment-1') => ({ id, amount: 20, entryDate: '2026-10-02T03:04:05Z', adjustmentType: 'PAYMENT', jobberPaymentTransactionStatus: 'SUCCEEDED', tipAmount: null });
const item = (id = 'item-1') => ({ id, name: 'Late fee', description: 'PRIVATE CUSTOMER NAME secret@example.com +15555550000', quantity: 1, unitPrice: 5, totalPrice: 5,
  category: 'SERVICE', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', date: null });
const connection = (nodes: unknown[] = [], totalCount = nodes.length, hasNextPage = false, endCursor: unknown = nodes.length ? 'cursor-1' : null) => ({ nodes, totalCount, pageInfo: { hasNextPage, endCursor } });
function invoice(id = 'invoice-1', extra: Record<string, unknown> = {}): any {
  return { id, invoiceNumber: '100', invoiceStatus: 'past_due', subtotal: 100, amounts: { total: 100, invoiceBalance: 50, subtotal: 100, discountAmount: 0 },
    client: { id: 'owner-1', name: 'PRIVATE CUSTOMER NAME' }, issuedDate: '2026-10-01', dueDate: '2026-10-31', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', invoiceNet: 30,
    paymentRecords: connection([payment()]), lineItems: connection([item()]), ...extra };
}
function cache(extra: Partial<CacheRow> = {}): CacheRow {
  return { jobberInvoiceId: 'invoice-1', invoiceNumber: '100', invoiceStatus: 'past_due', subtotal: 100, total: 100, amountDue: 50, amountPaid: 50,
    issuedAt: new Date('2026-10-01'), dueAt: new Date('2026-10-31'), paidAt: null, createdAtJobber: new Date('2026-10-01'),
    customerId: 'private-local-owner', customer: { jobberClientId: 'owner-1' }, lastSyncedAt: new Date('2026-11-01'), ...extra };
}
function reader(handler: (query: string, variables: any, n: number) => any, budget = new Budget()) {
  let n = 0; budget.pause = async () => { budget.check(); };
  return new JobberReader('FAKE-PRIVATE-TOKEN', new Date(Date.now() + 3600000), budget, (async (url, init) => {
    assert.equal(url, 'https://api.getjobber.com/api/graphql'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(init!.body as string); n++;
    const result = await handler(body.query, body.variables, n);
    return result instanceof Response ? result : new Response(JSON.stringify({ data: result }), { status: 200 });
  }) as typeof fetch);
}
const normalReader = () => reader((query, vars) => query.includes('__schema') ? schema() : { invoice: invoice(vars.id) });
const source = () => [normalize(invoice())];
const asAny = (x: Record<string, unknown>): any => x;

test('explicit opt-in makes no requests when disabled; empty targets also need no requests', async () => {
  const r = reader(() => { throw new Error('must not fetch'); });
  assert.equal((await runOptionalInvoiceEvidence(r, source(), [], false)).outcome, 'not_requested');
  assert.equal((await runOptionalInvoiceEvidence(r, [], [], true)).outcome, 'complete'); assert.equal(r.budget.requests, 0);
});
test('cohort union uses exact opaque IDs, preserves display number collisions, includes cache-only/status/credits', () => {
  const s = [normalize(invoice('paid', { invoiceStatus: 'paid' })), normalize(invoice('negative', { amounts: { total: 10, invoiceBalance: -5 } })),
    normalize(invoice('old', { issuedDate: '2025-12-31' })), normalize(invoice('changed', { invoiceStatus: 'awaiting_payment' }))];
  const c = [cache({ jobberInvoiceId: 'cache-only' }), cache({ jobberInvoiceId: 'changed', invoiceStatus: 'paid' })];
  const targets = deriveEvidenceTargets(s, c); assert.deepEqual(targets.map(t => t.id), ['cache-only', 'changed', 'negative', 'paid']);
  assert.ok(targets.find(t => t.id === 'changed')!.reasons.includes('source-cache-status-difference'));
  assert.ok(targets.find(t => t.id === 'negative')!.reasons.includes('source-negative-balance'));
});
test('verified root shape and enum metadata are required; updatedAt is optional and never guessed', () => {
  assert.equal(validateEvidenceSchema(schema()).updatedAtAvailable, true);
  assert.equal(validateEvidenceSchema(schema(false)).updatedAtAvailable, false);
  const bad = schema(); bad.__schema.queryType.fields[0].args[0].type = type('String', true);
  assert.throws(() => validateEvidenceSchema(bad), /EVIDENCE_INVOICE_ARGUMENT_UNVERIFIED/);
  const badEnum = schema(); badEnum.transaction.kind = 'OBJECT';
  assert.throws(() => validateEvidenceSchema(badEnum), /EVIDENCE_ENUM_SCHEMA_UNVERIFIED/);
  assert.doesNotMatch(evidenceQuery('EncodedId!'), /updatedAt\s+paymentRecords/);
  assert.match(evidenceQuery('EncodedId!', true), /updatedAt\s+paymentRecords/);
  assert.throws(() => evidenceQuery('String!'), /EVIDENCE_INVOICE_ARGUMENT_UNVERIFIED/);
});
test('current invoice, dates, net terms, safe payment evidence, and label-only candidates are explicit', async () => {
  const r = asAny(await runOptionalInvoiceEvidence(normalReader(), source(), [cache()], true));
  assert.equal(r.outcome, 'complete'); assert.equal(r.verifiedTargets, 1); assert.equal(r.requests, 2);
  const target = r.records[0]; assert.equal(target.current.invoiceNetDays, 30); assert.equal(target.current.ownerId, 'owner-1');
  assert.equal(target.current.updated.value, '2026-10-02T00:00:00.000Z'); assert.equal(target.current.balanceCents, 5000);
  assert.equal(target.payments.records[0].amountCents, 2000); assert.equal(target.payments.records[0].entryDate.value, '2026-10-02T03:04:05.000Z');
  assert.equal(target.feeWordingCandidates.records[0].totalPriceCents, 500); assert.equal(target.feeWordingCandidates.observedCount, 1);
  assert.equal(r.bankReceiptsVerified, false); assert.equal(r.sourceIdentityRead, 'not_performed');
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|secret@example|155555|private-local-owner|FAKE/);
});
test('independent nested pagination exhausts payments and items with terminal/count/ID evidence', async () => {
  let dataCalls = 0;
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema();
    dataCalls++;
    if (dataCalls === 1) return { invoice: invoice(v.id, { paymentRecords: connection([payment('p1')], 2, true, 'p-c1'), lineItems: connection([item('i1')], 2, true, 'i-c1') }) };
    assert.equal(v.paymentAfter, 'p-c1'); assert.equal(v.itemAfter, 'i-c1');
    return { invoice: invoice(v.id, { paymentRecords: connection([payment('p2')], 2, false, 'p-c2'), lineItems: connection([item('i2')], 2, false, 'i-c2') }) };
  });
  const report = asAny(await runOptionalInvoiceEvidence(r, source(), [], true));
  assert.equal(report.outcome, 'complete'); assert.equal(report.records[0].payments.pages, 2); assert.equal(report.records[0].payments.uniqueIds, 2);
  assert.equal(report.records[0].feeWordingCandidates.terminalPageObserved, true);
});
test('completed connection is not fetched again while other connection continues', async () => {
  let n = 0;
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema();
    if (++n === 1) return { invoice: invoice(v.id, { paymentRecords: connection(), lineItems: connection([item('i1')], 2, true) }) };
    assert.equal(v.payments, false); assert.equal(v.items, true);
    return { invoice: invoice(v.id, { paymentRecords: undefined, lineItems: connection([item('i2')], 2, false, 'next') }) };
  });
  assert.equal((await runOptionalInvoiceEvidence(r, source(), [], true)).outcome, 'complete');
});
for (const [name, mutation, code] of [
  ['duplicate payment ID', (i: any) => { i.paymentRecords = connection([payment(), payment()], 2); }, 'EVIDENCE_RECORD_ID_REPEATED'],
  ['terminal count mismatch', (i: any) => { i.paymentRecords.totalCount = 2; }, 'EVIDENCE_CONNECTION_COUNT_MISMATCH'],
  ['unknown enum', (i: any) => { i.paymentRecords.nodes[0].adjustmentType = 'PRIVATE_UNKNOWN'; }, 'EVIDENCE_ENUM_VALUE_UNVERIFIED'],
  ['unknown money', (i: any) => { i.paymentRecords.nodes[0].amount = '20'; }, 'EVIDENCE_MONEY_UNVERIFIED'],
  ['unknown entry date', (i: any) => { i.paymentRecords.nodes[0].entryDate = 'PRIVATE_TEXT'; }, 'EVIDENCE_DATE_UNVERIFIED'],
  ['missing cursor', (i: any) => { i.paymentRecords.pageInfo.endCursor = null; }, 'EVIDENCE_CURSOR_INVALID'],
  ['record bound', (i: any) => { i.paymentRecords.totalCount = 201; }, 'EVIDENCE_CONNECTION_RECORD_LIMIT'],
  ['wrong exact ID', (i: any) => { i.id = 'not-requested'; }, 'EVIDENCE_EXACT_INVOICE_ID_MISMATCH'],
] as const) test(`fails soft and preserves only safe partial evidence on ${name}`, async () => {
  const r = reader((q, v) => { if (q.includes('__schema')) return schema(); const i = invoice(v.id); mutation(i); return { invoice: i }; });
  const out = await runOptionalInvoiceEvidence(r, source(), [], true);
  assert.equal(out.outcome, 'incomplete'); assert.equal(out.code, code); assert.equal(out.countsAreComplete, false);
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
});
test('repeated cursor and moving invoice metadata fail even with a terminal page', async () => {
  for (const moving of [false, true]) {
    let n = 0;
    const r = reader((q, v) => {
      if (q.includes('__schema')) return schema(); n++;
      return { invoice: invoice(v.id, { invoiceNet: moving && n === 2 ? 10 : 30,
        paymentRecords: connection([payment(`p${n}`)], 2, n === 1, 'repeat') }) };
    });
    assert.equal((await runOptionalInvoiceEvidence(r, source(), [], true)).code,
      moving ? 'EVIDENCE_INVOICE_CHANGED_DURING_PAGINATION' : 'EVIDENCE_CURSOR_REPEATED');
  }
});
test('null exact result is unresolved and remaining targets still read; no deletion/payment inference', async () => {
  const r = reader((q, v) => q.includes('__schema') ? schema() : { invoice: v.id === 'a-null' ? null : invoice(v.id) });
  const out = asAny(await runOptionalInvoiceEvidence(r, [normalize(invoice('a-null')), normalize(invoice('b-live'))], [], true));
  assert.equal(out.outcome, 'incomplete'); assert.equal(out.exactNullTargets, 1); assert.equal(out.verifiedTargets, 1);
  assert.equal(out.allTargetsAttempted, true); assert.equal(out.records[0].outcome, 'not_returned_by_exact_read');
  assert.equal(out.records[0].current, null); assert.equal(out.records[1].outcome, 'complete');
});
test('target limit refuses before any schema or business request', async () => {
  const r = normalReader();
  const out = await runOptionalInvoiceEvidence(r, Array.from({ length: EVIDENCE_LIMITS.targets + 1 }, (_, n) => normalize(invoice(`i${n}`))), [], true);
  assert.equal(out.code, 'EVIDENCE_TARGET_LIMIT'); assert.equal(r.budget.requests, 0);
});
test('remaining global deadline is reserved and token gates are never weakened', async () => {
  const b = new Budget(); Object.defineProperty(b, 'startedAt', { value: Date.now() - LIMITS.runMs + 80_000 });
  const r = reader(() => { throw new Error('must not fetch'); }, b);
  assert.equal((await runOptionalInvoiceEvidence(r, source(), [], true)).code, 'EVIDENCE_INSUFFICIENT_REMAINING_BUDGET');
  assert.equal(r.budget.requests, 0);
});
test('401 and partial GraphQL errors do not retry or expose raw details', async () => {
  for (const mode of ['auth', 'partial']) {
    const r = reader((q) => q.includes('__schema') ? schema() : mode === 'auth' ? new Response('PRIVATE TOKEN', { status: 401 }) :
      new Response(JSON.stringify({ data: { invoice: invoice() }, errors: [{ message: 'PRIVATE TOKEN' }] }), { status: 200 }));
    const out = await runOptionalInvoiceEvidence(r, source(), [], true);
    assert.equal(out.outcome, 'incomplete'); assert.equal(r.budget.requests, 2); assert.equal(r.budget.retries, 0);
    assert.doesNotMatch(JSON.stringify(out), /PRIVATE TOKEN/);
  }
});
test('fee matching emits only controlled labels; date shapes never print arbitrary notes', () => {
  assert.deepEqual(feeWording('Mowing', 'ordinary service'), []);
  assert.ok(feeWording('Late fee waived', 'No payment collected').some(v => v.label === 'late-fee-wording'));
  assert.deepEqual(evidenceDate('PRIVATE DATE NOTE'), { value: null, kind: 'unknown' });
});
test('queries never fetch card, method, communication bodies or identity contact data', () => {
  assert.doesNotMatch(evidenceQuery('EncodedId!', true), /Last4|PaymentMethod|emails|phones|linkedCommunications|refunds|allocations|mutation|refresh/i);
  const script = readFileSync('scripts/audit-jobber-source.ts', 'utf8');
  assert.match(script, /--with-invoice-evidence/); assert.match(script, /requireTokenRunCoverage/);
  assert.match(script, /EVIDENCE_COMBINED_REPORT_LIMIT/); assert.match(script, /invoiceEvidenceOutcome/);
});
test('nested page limit never claims complete without a terminal page', async () => {
  let n = 0;
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema(); n++;
    return { invoice: invoice(v.id, { paymentRecords: connection([payment(`p${n}`)], 20, true, `c${n}`) }) };
  });
  const out = await runOptionalInvoiceEvidence(r, source(), [], true);
  assert.equal(out.code, 'EVIDENCE_CONNECTION_PAGE_LIMIT'); assert.equal(r.budget.requests, 9);
});
test('changed nested totalCount cannot pass as complete', async () => {
  let n = 0;
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema(); n++;
    return { invoice: invoice(v.id, { paymentRecords: connection([payment(`p${n}`)], n === 1 ? 2 : 3, n === 1, `c${n}`) }) };
  });
  assert.equal((await runOptionalInvoiceEvidence(r, source(), [], true)).code, 'EVIDENCE_CONNECTION_COUNT_CHANGED');
});
test('request budget is enforced at exactly 384 attempted HTTP requests', async () => {
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema();
    const n = v.paymentAfter ? Number(v.paymentAfter) + 1 : 1;
    return { invoice: invoice(v.id, { paymentRecords: connection([payment(`p${n}`)], 3, n < 3, String(n)) }) };
  });
  const out = await runOptionalInvoiceEvidence(r, Array.from({ length: 128 }, (_, n) => normalize(invoice(`i${n}`))), [], true);
  assert.equal(out.code, 'EVIDENCE_REQUEST_LIMIT'); assert.equal(r.budget.requests, EVIDENCE_LIMITS.requests);
});
test('phase deadline aborts optional evidence without waiting for global watchdog', async () => {
  const originalNow = Date.now; let now = originalNow();
  Date.now = () => now;
  try {
    const r = reader(() => { now += EVIDENCE_LIMITS.durationMs; return schema(); });
    assert.equal((await runOptionalInvoiceEvidence(r, source(), [], true)).code, 'EVIDENCE_TIME_LIMIT');
    assert.equal(r.budget.requests, 1);
  } finally { Date.now = originalNow; }
});
test('two MB optional output cap returns explicit omission rather than a truncated success', async () => {
  const r = reader((q, v) => {
    if (q.includes('__schema')) return schema();
    const n = v.paymentAfter ? Number(v.paymentAfter) + 1 : 1;
    const nodes = Array.from({ length: 25 }, (_, i) => payment(`p${n}-${i}-` + 'x'.repeat(490)));
    return { invoice: invoice(v.id, { paymentRecords: connection(nodes, 200, n < 8, String(n)), lineItems: connection() }) };
  });
  const out = await runOptionalInvoiceEvidence(r, Array.from({ length: 30 }, (_, n) => normalize(invoice(`i${n}`))), [], true);
  assert.equal(out.code, 'EVIDENCE_OUTPUT_LIMIT'); assert.equal(out.detailsOmitted, true); assert.deepEqual(out.records, []);
  assert.ok(Buffer.byteLength(JSON.stringify(out)) < EVIDENCE_LIMITS.outputBytes);
});
