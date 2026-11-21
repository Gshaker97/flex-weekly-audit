import { analyzeSnapshot, PreviewInput, validateInput } from './analysis';
import { readAllContacts, readAllPipelineCards, readInvoicePipeline } from './snapshot';
import { GhlPreviewFailure, GhlReadonlyReader, GHL_LIMITS, GHL_VERSION, ReaderOptions } from './transport';
export type { PreviewInput, PreviewCustomer, PreviewCachedInvoice, PreviewFreshInvoice } from './analysis';
export type { ReaderOptions } from './transport';
export const CONTRACT_SOURCES = Object.freeze({
  contacts: 'https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/search-contacts-advanced/index.html',
  opportunities: 'https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/search-opportunity/index.html',
  pipelines: 'https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/opportunities/get-pipelines/index.html',
  dnd: 'https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/get-contact/index.html',
});
/** No logging, DB access, OAuth refresh, provider mutations, file writes or process exits. */
export async function runGhlReadonlyPreview(input: PreviewInput, options: ReaderOptions) {
  let reader: GhlReadonlyReader | undefined; let stage = 'configuration';
  try {
    validateInput(input);
    reader = new GhlReadonlyReader(options);
    stage = 'invoice-pipeline'; const pipeline = await readInvoicePipeline(reader);
    stage = 'complete-contacts'; const contacts = await readAllContacts(reader);
    stage = 'all-status-pipeline-cards'; const cards = await readAllPipelineCards(reader, pipeline);
    stage = 'identity-and-eligibility-analysis'; reader.check();
    const analysis = analyzeSnapshot(input, contacts.contacts, cards.cards, pipeline, () => reader!.check()); reader.check();
    const report = {
      audit: 'ghl-readonly-preview-v1', outcome: 'complete', mutationAllowed: false,
      runtime: { elapsedMs: Date.now() - reader.startedAt, requests: reader.requests, responseBytes: reader.bytes, maxRunMs: GHL_LIMITS.runMs, retries: 0 },
      contracts: { version: GHL_VERSION, officialOriginOnly: true, redirectsFollowed: false, totalValidated: true,
        contacts: { method: 'POST', path: '/contacts/search', totalLocation: 'top-level', cursor: 'last-contact-searchAfter', pages: contacts.pages, total: contacts.total, uniqueCursors: contacts.cursorCount },
        opportunities: { method: 'GET', path: '/opportunities/search', deprecated: true, status: 'all', totalLocation: 'meta.total', cursor: 'meta.startAfter-and-startAfterId', pages: cards.pages, total: cards.total, uniqueCursors: cards.cursorCount },
        requiredStagesPresent: pipeline.requiredStagesPresent, sources: CONTRACT_SOURCES },
      provenance: { customerEmailAndPhone: 'read-only cached Customer rows; not freshly verified against Jobber',
        customerSnapshotComplete: input.customerSnapshotComplete === true, freshInvoiceSnapshotComplete: input.freshInvoicesComplete === true, snapshotIsAtomic: false },
      ...analysis,
      limitations: [
        'Read-only preview. No source/provider writes, contact/card creation, sending, fees, workflow calls, authentication changes or new endpoints.',
        'The contact and opportunity reads are complete by the reported stable totals and unique IDs/cursors, but are not atomic snapshots. Records may change between reads. IDs identify review candidates, never permission to mutate.',
        'Jobber contact identities are cached. Exact matching normalizes email case/whitespace and US phone punctuation/country prefix, never names, fuzzy search, or suffixes. Domestic suffixes and additional contact fields can only create holds.',
        'DND evidence does not prove consent, a mobile number, deliverability, workflow enrollment or queued-message cancellation. Missing DND values remain unknown.',
        'Closed, won, lost, unknown, Late Fee, Closed Out and other special cards are protected. Duplicate identity/card candidates are never automatically selected, merged, deleted or reopened.',
        'Existing-card candidate means structural identity, pipeline and invoice evidence passed these conservative checks. It is not approval for messaging, a stage move or deployment; source due dates and workflow effects require separate review.',
        'The 316-card breakdown is a historical comparison only; a different current count is not automatically an error. No conversations/messages or workflow configuration were read.',
      ],
    };
    if (Buffer.byteLength(JSON.stringify(report)) > GHL_LIMITS.outputBytes) throw new GhlPreviewFailure('GHL_OUTPUT_BYTE_LIMIT');
    return report;
  } catch (error) {
    const failure = error instanceof GhlPreviewFailure ? error : new GhlPreviewFailure('GHL_UNEXPECTED_PREVIEW_ERROR');
    return { audit: 'ghl-readonly-preview-v1', outcome: 'incomplete', stage, code: failure.code, facts: failure.facts,
      mutationAllowed: false, countsAreComplete: false, runtime: { elapsedMs: reader ? Date.now() - reader.startedAt : 0,
        requests: reader?.requests ?? 0, responseBytes: reader?.bytes ?? 0, maxRunMs: GHL_LIMITS.runMs, retries: 0 } };
  }
}
