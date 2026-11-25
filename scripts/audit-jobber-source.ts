/** Run only inside the existing Railway web deployment. No refresh or writes; optional GHL reads are explicit. */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { AuditFailure, CacheRow, compare, deriveTargets, LIMITS, paginate } from './source-audit/core';
import { Budget, capabilityProbe, expiryMinutes, JobberReader, requireTokenRunCoverage } from './source-audit/transport';
import { reportLines } from './source-audit/output';
import { runOptionalGhlPreview } from './source-audit/run-ghl-preview';
import { runOptionalInvoiceEvidence } from './source-audit/invoice-evidence';

const budget = new Budget();
let stage = 'configuration';
let finished = false;
function output(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > LIMITS.outputBytes) throw new AuditFailure('OUTPUT_BYTE_LIMIT');
  console.log(text);
}
/**
 * THIS AUDIT IS A REPORT, NOT A DEPLOYMENT GATE.
 *
 * It runs as the web service's Railway pre-deploy command, and a non-zero exit
 * there fails the whole deployment. Only one class of problem actually says
 * anything about the deployment: the pre-deploy command being wrong - run in
 * the wrong service or environment, or without the flag that makes it
 * deliberate. Those are decided in milliseconds, before anything is read, and
 * the next deployment would be wrong in exactly the same way.
 *
 * Everything else is a finding about Jobber or about this account's data, and
 * none of it is evidence about the code being shipped. Letting those fail a
 * deployment is what stopped the web service from shipping any commit at all
 * on 2026-11-25: three deployments in a row failed, first because an expired
 * Jobber token could not cover the run, then because an invoice changed while
 * the audit was paging through 241 requests over three minutes. Neither had
 * anything to do with the code being deployed.
 *
 * So an audit that could not be completed now says so and exits 0. The report
 * still records it, and `deploymentBlocked` says which kind it was.
 */
const DEPLOYMENT_BLOCKING_CODES: ReadonlySet<string> = new Set([
  'EXPLICIT_DEPLOYMENT_FLAG_REQUIRED',
  'EXISTING_RAILWAY_DEPLOYMENT_REQUIRED',
  'WRONG_RAILWAY_SERVICE_OR_ENVIRONMENT',
]);
function failure(error: unknown, exitCode = 2) {
  if (finished) return;
  finished = true;
  const safe = error instanceof AuditFailure ? error : new AuditFailure('UNEXPECTED_AUDIT_ERROR');
  const blocking = DEPLOYMENT_BLOCKING_CODES.has(safe.code);
  // Only codes controlled by this script and numeric/boolean facts reach logs.
  output({ audit: 'jobber-source-v1', outcome: 'incomplete', stage, code: safe.code, facts: safe.facts,
    deploymentBlocked: blocking,
    elapsedSeconds: Math.floor((Date.now() - budget.startedAt) / 1000), requests: budget.requests, bytes: budget.bytes });
  process.exitCode = blocking ? exitCode : 0;
}
/** The exit code `failure` settled on, so a hard stop cannot fail a deploy either. */
const exitNow = () => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
const watchdog = setTimeout(() => { failure(new AuditFailure('HARD_RUNTIME_LIMIT'), 3); exitNow(); }, LIMITS.hardStopMs);
process.once('SIGTERM', () => { failure(new AuditFailure('TERMINATED'), 3); exitNow(); });
process.once('SIGINT', () => { failure(new AuditFailure('INTERRUPTED'), 3); exitNow(); });

const invoiceSelect = {
  jobberInvoiceId: true, invoiceNumber: true, invoiceStatus: true,
  subtotal: true, total: true, amountPaid: true, amountDue: true,
  issuedAt: true, dueAt: true, paidAt: true, createdAtJobber: true,
  customerId: true, customer: { select: { jobberClientId: true } }, lastSyncedAt: true,
} as const;
function digest(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function snapshot(prisma: PrismaClient, authNeeded: boolean) {
  budget.check();
  return prisma.$transaction(async tx => {
    // Database-enforced read-only, consistent cache snapshot. No raw user data in SQL.
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30000ms'");
    const count = await tx.invoiceRecord.count();
    if (count > LIMITS.maxRecords) throw new AuditFailure('CACHE_RECORD_LIMIT', { count });
    const rows = await tx.invoiceRecord.findMany({ select: invoiceSelect, orderBy: { jobberInvoiceId: 'asc' }, take: LIMITS.maxRecords + 1 });
    if (rows.length !== count) throw new AuditFailure('CACHE_COUNT_MISMATCH', { count, rows: rows.length });
    const auth = authNeeded ? await tx.jobberAuth.findFirst({ orderBy: { createdAt: 'desc' }, select: { accessToken: true, expiresAt: true } }) : null;
    return { rows: rows as CacheRow[], auth, capturedAt: new Date().toISOString() };
  }, { isolationLevel: 'RepeatableRead', maxWait: 10_000, timeout: 60_000 });
}
async function main() {
  if (process.argv[2] !== '--run-in-deployment' || process.argv.slice(3).some(a => !['--probe-capabilities', '--with-ghl-preview', '--with-invoice-evidence'].includes(a))) throw new AuditFailure('EXPLICIT_DEPLOYMENT_FLAG_REQUIRED');
  if (!process.env.RAILWAY_SERVICE_ID || !process.env.RAILWAY_ENVIRONMENT_ID || !process.env.RAILWAY_DEPLOYMENT_ID || !process.env.DATABASE_URL) throw new AuditFailure('EXISTING_RAILWAY_DEPLOYMENT_REQUIRED');
  if (process.env.RAILWAY_SERVICE_ID !== 'ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f' ||
      process.env.RAILWAY_ENVIRONMENT_ID !== 'bc72bc2d-9a4c-494d-8bee-9ca782db1240' ||
      (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_PROJECT_ID !== '5d7858db-0443-4891-8a95-1eb1261d3e61')) throw new AuditFailure('WRONG_RAILWAY_SERVICE_OR_ENVIRONMENT');
  // No environment values are printed, copied, or passed to another service.
  const prisma = new PrismaClient({ log: [], errorFormat: 'minimal' });
  try {
    stage = 'cache-snapshot-before';
    const before = await snapshot(prisma, true);
    if (!before.auth || !before.auth.accessToken) throw new AuditFailure('EXISTING_JOBBER_AUTH_MISSING');
    requireTokenRunCoverage(before.auth.expiresAt);
    const initialExpiryMinutes = expiryMinutes(before.auth.expiresAt);
    const reader = new JobberReader(before.auth.accessToken, before.auth.expiresAt, budget);
    const sourceStartedAt = new Date().toISOString();
    // THE SOURCE MOVES WHILE WE READ IT, AND THAT IS ORDINARY. Reading every
    // invoice takes about three minutes and 240 requests, so on any working day
    // something somewhere is likely to change in the middle of it. Re-reading
    // the first page afterwards is how this audit SAYS whether that happened;
    // it was never evidence about the code being deployed, and Jobber's
    // pagination is not an atomic snapshot in any case - the limitations below
    // have always said so.
    //
    // So: read it again while there is runtime budget for a whole further
    // attempt, and if the source is still moving, record that and carry on.
    // The comparison is still worth having, flagged as taken over a source
    // that moved.
    let result!: Awaited<ReturnType<typeof paginate>>;
    let firstPageUnchangedOnRecheck = false;
    let sourceReadAttempts = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      sourceReadAttempts = attempt;
      stage = 'jobber-invoice-pagination';
      result = await paginate(after => reader.page(after), { pause: () => budget.pause(LIMITS.pageDelayMs) });
      stage = 'jobber-first-page-recheck';
      const firstAgain = await reader.page(null);
      firstPageUnchangedOnRecheck = digest(result.firstPage) === digest(firstAgain);
      if (firstPageUnchangedOnRecheck || attempt === 2) break;
      // Only try again if another read of the same size can finish in budget.
      const elapsed = Date.now() - budget.startedAt;
      if (elapsed + (elapsed / attempt) * 1.25 > LIMITS.runMs) break;
    }
    const sourceFinishedAt = new Date().toISOString();
    stage = 'cache-snapshot-after';
    const after = await snapshot(prisma, false);
    // The cache moves too: the hourly sync writes it. Same reasoning.
    const cacheUnchangedDuringAudit = digest(before.rows) === digest(after.rows);
    stage = 'comparison';
    const report = compare(result.records, after.rows, deriveTargets(after.rows));
    stage = 'optional-capability-probe';
    const capabilities = process.argv.includes('--probe-capabilities') ? await capabilityProbe(reader) : { available: false, reason: 'NOT_REQUESTED', fields: [] };
    stage = 'optional-invoice-evidence';
    const invoiceEvidence = await runOptionalInvoiceEvidence(reader, result.records, after.rows, process.argv.includes('--with-invoice-evidence'));
    stage = 'optional-ghl-preview';
    const ghlPreview = await runOptionalGhlPreview(prisma, budget, result.records, after.rows, {
      enabled: process.argv.includes('--with-ghl-preview'), apiKey: process.env.GHL_API_KEY, locationId: process.env.GHL_LOCATION_ID,
    });
    budget.check();
    // "Complete" keeps its old strict meaning: every page read, and neither the
    // source nor the cache seen to move underneath it. When one of them did
    // move, the report is produced anyway and labelled for what it is.
    const movement = [
      ...(firstPageUnchangedOnRecheck ? [] : ['SOURCE_FIRST_PAGE_CHANGED_DURING_AUDIT']),
      ...(cacheUnchangedDuringAudit ? [] : ['CACHE_CHANGED_DURING_AUDIT']),
    ];
    const final = {
      audit: 'jobber-source-v1',
      outcome: movement.length ? 'complete_over_a_moving_source' : 'complete',
      movedDuringAudit: movement, deploymentBlocked: false,
      completedAt: new Date().toISOString(),
      runtime: { elapsedSeconds: Math.floor((Date.now() - budget.startedAt) / 1000), requests: budget.requests, retries: budget.retries, responseBytes: budget.bytes, sourceReadAttempts,
        existingTokenExpiryRemainingMinutesAtStart: initialExpiryMinutes, existingTokenExpiryRemainingMinutesAtEnd: expiryMinutes(before.auth.expiresAt) },
      sourceRead: { startedAt: sourceStartedAt, finishedAt: sourceFinishedAt, filters: null, queryIsUnfiltered: true, apiDefaultStatusScopeVerified: false, pages: result.pages, uniqueIds: result.uniqueIds, uniqueCursors: result.uniqueCursors, terminalPageObserved: true,
        firstPageUnchangedOnRecheck, sourceIsAtomicSnapshot: false, totalCountFieldAvailableInExistingQuery: false },
      cacheRead: { before: before.capturedAt, after: after.capturedAt, unchangedDuringAudit: cacheUnchangedDuringAudit, databaseEnforcedReadOnly: true },
      ...report, capabilities, invoiceEvidence, ghlPreview,
      limitations: [
        'Complete means every page returned by the query with no explicit filters was consumed with unique IDs/cursors and a terminal page. API default status filtering is unverified; it does not mean every account status is included, the records agree, or every field is known.',
        'Jobber pagination is not an atomic snapshot. The first page was checked again, and movedDuringAudit says whether it or the cache moved while this ran; a report over a moving source is still produced, and is not a reason to fail a deployment. Changes elsewhere during the read cannot be excluded. Cache/source snapshots are not transactional across systems; verify each differing invoice afresh before any later correction.',
        'All monetary numbers are integer cents of the source account currency. The existing invoice query does not expose currency.',
        'Positive balances and negative credits are separate. Credits do not offset paid-positive conflicts.',
        'A cache-only invoice is not proof of deletion, payment or void status. No business state was changed.',
        'Invoice number duplicates are retained. Matching and differences use only the stable opaque Jobber invoice ID.',
        'Source status is compared without inferring paid from zero, negative or missing balance.',
        'Total minus balance and stored amountPaid are not verified cash receipts. Actual payment dates are unavailable; issuedDate is never used as a payment date.',
        'Date-only issue/due fields are compared by calendar date; creation timestamps by instant. Numeric/object/unknown date scalars remain unverifiable.',
        'Core Jobber audit fetches no sent timestamp, payment transaction, line item/fee content, reminder messages or GHL evidence. Optional invoice evidence and GHL preview, when explicitly enabled, have separate outcomes and limitations.',
        'No OAuth refresh, auth row update, invoice write, sync trigger, workflow call, GHL mutation, service configuration change or new endpoint is performed.',
      ],
    };
    if (Buffer.byteLength(JSON.stringify(final)) > LIMITS.outputBytes && process.argv.includes('--with-ghl-preview')) {
      final.ghlPreview = { outcome: 'incomplete', code: 'GHL_COMBINED_REPORT_LIMIT', countsAreComplete: false, mutationAllowed: false };
    }
    if (Buffer.byteLength(JSON.stringify(final)) > LIMITS.outputBytes && process.argv.includes('--with-invoice-evidence')) {
      final.invoiceEvidence = { outcome: 'incomplete', code: 'EVIDENCE_COMBINED_REPORT_LIMIT', countsAreComplete: false, mutationAllowed: false };
    }
    stage = 'database-disconnect';
    await prisma.$disconnect();
    stage = 'output';
    const lines = reportLines(final);
    for (const line of lines) console.log(line);
    output({ audit: 'jobber-source-v1', event: 'summary', outcome: final.outcome, movedDuringAudit: movement, sourceCount: report.source.count, cacheCount: report.cache.count,
      sourceTotalCents: report.source.totalCents, cacheTotalCents: report.cache.totalCents,
      sourcePositiveBalanceCents: report.source.positiveBalanceCents, sourcePaidPositiveCount: report.source.paidPositiveCount,
      sourcePaidPositiveBalanceCents: report.source.paidPositiveBalanceCents, sourceNegativeBalanceCents: report.source.negativeBalanceCents,
      comparison: report.comparison, detailsTruncated: report.detailsTruncated, invoiceEvidenceOutcome: final.invoiceEvidence.outcome, ghlPreviewOutcome: final.ghlPreview.outcome });
    finished = true; process.exitCode = 0;
  } finally {
    // A hard watchdog remains active if disconnect itself stalls.
    if (!finished) await prisma.$disconnect();
  }
}
main().catch(error => failure(error)).finally(() => clearTimeout(watchdog));
