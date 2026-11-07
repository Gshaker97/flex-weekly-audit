/** Optional read-only GHL bridge. Contacts never leave deployment memory/log-safe analysis. */
import type { PrismaClient } from '@prisma/client';
import { AuditFailure, CacheRow, Invoice, LIMITS } from './core';
import type { Budget } from './transport';

export type ContactSnapshot = { rows: { jobberClientId: string; email: string | null; phone: string | null }[]; capturedAt: string; count: number };
export async function readAllCachedCustomerContacts(prisma: PrismaClient): Promise<ContactSnapshot> {
  return prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15000ms'");
    const count = await tx.customer.count();
    if (count > 10_000) throw new AuditFailure('GHL_CUSTOMER_SNAPSHOT_LIMIT', { count });
    const rows = await tx.customer.findMany({ select: { jobberClientId: true, email: true, phone: true }, orderBy: { jobberClientId: 'asc' }, take: 10_001 });
    if (rows.length !== count) throw new AuditFailure('GHL_CUSTOMER_SNAPSHOT_COUNT_MISMATCH', { count, rows: rows.length });
    return { rows, count, capturedAt: new Date().toISOString() };
  }, { isolationLevel: 'RepeatableRead', maxWait: 5_000, timeout: 30_000 });
}
export async function runOptionalGhlPreview(
  prisma: PrismaClient, budget: Budget, source: Invoice[], cache: CacheRow[],
  options: { enabled: boolean; apiKey?: string; locationId?: string },
): Promise<Record<string, unknown>> {
  if (!options.enabled) return { outcome: 'not_requested', mutationAllowed: false };
  let stage = 'configuration';
  const incomplete = (code: string, facts: Record<string, number | boolean> = {}) => ({ outcome: 'incomplete', stage, code, facts, countsAreComplete: false, mutationAllowed: false });
  // Reserve time for final DB disconnect and complete report output.
  const deadlineAt = budget.startedAt + LIMITS.runMs - 30_000;
  if (Date.now() + 40_000 >= deadlineAt) return incomplete('GHL_INSUFFICIENT_REMAINING_BUDGET');
  if (!options.apiKey || !options.locationId) return incomplete('EXISTING_GHL_CONFIGURATION_REQUIRED');
  try {
    stage = 'complete-cached-customer-snapshot';
    const contacts = await readAllCachedCustomerContacts(prisma);
    stage = 'ghl-read-only-preview';
    const { runGhlReadonlyPreview } = await import('./ghl-readonly-preview');
    const report = await runGhlReadonlyPreview({
      customers: contacts.rows, customerSnapshotComplete: true,
      cachedInvoices: cache.map(row => ({ jobberInvoiceId: row.jobberInvoiceId, jobberClientId: row.customer?.jobberClientId ?? null })),
      freshInvoices: source.map(row => ({ id: row.id, owner: row.owner, invoiceStatus: row.invoiceStatus, balance: row.balance })),
      freshInvoicesComplete: true,
    }, { apiKey: options.apiKey, locationId: options.locationId, deadlineAt });
    return { ...report, customerSnapshot: { complete: true, count: contacts.count, capturedAt: contacts.capturedAt,
      databaseEnforcedReadOnly: true, provenance: 'cached Customer identities, not freshly verified Jobber identities' } };
  } catch (error) {
    return error instanceof AuditFailure ? incomplete(error.code, error.facts) : incomplete('GHL_PREVIEW_SETUP_FAILED');
  }
}
