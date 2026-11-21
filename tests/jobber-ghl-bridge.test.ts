import test from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { Budget } from '../scripts/source-audit/transport';
import { readAllCachedCustomerContacts, runOptionalGhlPreview } from '../scripts/source-audit/run-ghl-preview';
function fakeDb(count: number, rows: unknown[]) {
  const calls: string[] = [];
  const tx = { $executeRawUnsafe: async (sql: string) => { calls.push(sql); }, customer: {
    count: async () => { calls.push('count-all'); return count; },
    findMany: async (args: Record<string, unknown>) => { assert.equal(args.where, undefined); assert.deepEqual(args.select, { jobberClientId: true, email: true, phone: true }); calls.push('read-all'); return rows; },
  } };
  const db = { $transaction: async (fn: (x: typeof tx) => unknown, options: Record<string, unknown>) => {
    assert.equal(options.isolationLevel, 'RepeatableRead'); assert.equal(options.timeout, 30_000); return fn(tx);
  } } as unknown as PrismaClient;
  return { db, calls };
}
test('disabled GHL bridge reads nothing', async () => {
  const { db, calls } = fakeDb(0, []);
  const r = await runOptionalGhlPreview(db, new Budget(), [], [], { enabled: false });
  assert.equal(r.outcome, 'not_requested'); assert.deepEqual(calls, []);
});
test('missing optional configuration is explicit, without affecting Jobber or querying DB', async () => {
  const { db, calls } = fakeDb(0, []);
  const r = await runOptionalGhlPreview(db, new Budget(), [], [], { enabled: true });
  assert.equal(r.outcome, 'incomplete'); assert.equal(r.code, 'EXISTING_GHL_CONFIGURATION_REQUIRED'); assert.deepEqual(calls, []);
});
test('insufficient global budget skips optional reads, reserving output time', async () => {
  const { db, calls } = fakeDb(0, []), budget = new Budget();
  Object.defineProperty(budget, 'startedAt', { value: Date.now() - 13 * 60_000 });
  const r = await runOptionalGhlPreview(db, budget, [], [], { enabled: true, apiKey: 'synthetic', locationId: 'synthetic' });
  assert.equal(r.code, 'GHL_INSUFFICIENT_REMAINING_BUDGET'); assert.deepEqual(calls, []);
});
test('full customer read includes non-invoice owners and is database-enforced read-only', async () => {
  const rows = [{ jobberClientId: 'owner-without-invoices', email: null, phone: null }];
  const { db, calls } = fakeDb(1, rows);
  const snapshot = await readAllCachedCustomerContacts(db);
  assert.equal(snapshot.count, 1); assert.deepEqual(snapshot.rows, rows);
  assert.deepEqual(calls, ['SET TRANSACTION READ ONLY', "SET LOCAL statement_timeout = '15000ms'", 'count-all', 'read-all']);
});
test('customer count bound fails optional phase before row read', async () => {
  const { db, calls } = fakeDb(10001, []);
  const r = await runOptionalGhlPreview(db, new Budget(), [], [], { enabled: true, apiKey: 'synthetic', locationId: 'synthetic' });
  assert.equal(r.outcome, 'incomplete'); assert.equal(r.code, 'GHL_CUSTOMER_SNAPSHOT_LIMIT'); assert.equal(calls.includes('read-all'), false);
});
test('partial customer rows cannot set a complete snapshot', async () => {
  const { db } = fakeDb(2, [{ jobberClientId: 'one', email: null, phone: null }]);
  const r = await runOptionalGhlPreview(db, new Budget(), [], [], { enabled: true, apiKey: 'synthetic', locationId: 'synthetic' });
  assert.equal(r.code, 'GHL_CUSTOMER_SNAPSHOT_COUNT_MISMATCH'); assert.equal(r.countsAreComplete, false);
});
test('unexpected optional setup exceptions are sanitized', async () => {
  const db = { $transaction: async () => { throw new Error('SECRET database URL'); } } as unknown as PrismaClient;
  const r = await runOptionalGhlPreview(db, new Budget(), [], [], { enabled: true, apiKey: 'synthetic', locationId: 'synthetic' });
  assert.equal(r.code, 'GHL_PREVIEW_SETUP_FAILED'); assert.doesNotMatch(JSON.stringify(r), /SECRET|database URL|synthetic/);
});
