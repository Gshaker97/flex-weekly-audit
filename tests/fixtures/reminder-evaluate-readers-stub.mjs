/**
 * Fixture readers for the evaluate-only entrypoint harness.
 *
 * Substituted for lib/reminder-evaluation-readers.ts by a resolve hook, so the
 * real entrypoint runs unmodified while every source read is answered from
 * memory. Nothing here opens a socket; the harness has already made that
 * impossible.
 */
export function createReminderEvaluationReaders() {
  const log = globalThis.__HARNESS__;
  const fx = globalThis.__HARNESS_FIXTURES__;
  const note = (method, id) => log.readers.push(`${method}:${id}`);
  return {
    async readInvoice(jobberInvoiceId) {
      note("readInvoice", jobberInvoiceId);
      return fx.source[jobberInvoiceId] ?? null;
    },
    async matchContacts(candidate) {
      note("matchContacts", candidate.jobberInvoiceId);
      return fx.contacts[candidate.jobberInvoiceId] ?? [];
    },
    async cardsForContact(contactId) {
      note("cardsForContact", contactId);
      return fx.cards[contactId] ?? [];
    },
    async sendHistory(candidate) {
      note("sendHistory", candidate.jobberInvoiceId);
      return fx.history[candidate.jobberInvoiceId] ?? null;
    },
  };
}
