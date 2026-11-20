import { jobberGraphQL } from "./jobber";
import { readLinkedJobText, type LinkedJobsResult } from "./reminder-job-notes-source";
import { priorSendRelevance } from "./reminder-prior-send-window";
import { findExactContactMatches, getInvoicePipelineRefs, getOutboundMessages, searchOpportunities } from "./ghl";
import type {
  DestinationCard, DestinationContact, PriorSend, ReminderCandidate,
  ReminderEvaluationReaders, SendHistory, SourceInvoice,
} from "./reminder-evaluation";

/** Read-only queries. No mutation is issued from this module to either provider. */
const INVOICE_QUERY = `query ReminderEvaluationInvoice($id: EncodedId!) {
  invoice(id: $id) {
    id invoiceStatus issuedDate dueDate
    amounts { total invoiceBalance }
    lineItems(first: 20) { nodes { name } }
    client { id tags { nodes { label } } emails { address }
      clientProperties(first: 25) { totalCount nodes { address { street1 city postalCode } } } }
  }
}`;

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 0.000001 ? rounded : null;
}
function labelList(nodes: unknown, key: string): string[] | null {
  if (!Array.isArray(nodes)) return null;
  return nodes
    .map(node => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : null))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function createReminderEvaluationReaders(): ReminderEvaluationReaders {
  // The pipeline/stage reference is read once per run, not per invoice.
  let refs: { pipelineId: string; nameByStageId: Map<string, string> } | null = null;
  const pipelineRefs = async () => {
    if (!refs) {
      const live = await getInvoicePipelineRefs();
      refs = {
        pipelineId: live.pipelineId,
        // stageIdByName is lowercased name -> id; invert it for display.
        nameByStageId: new Map(Object.entries(live.stageIdByName).map(([name, id]) => [id, name])),
      };
    }
    return refs;
  };

  return {
    async readInvoice(jobberInvoiceId: string): Promise<SourceInvoice | null> {
      const data = await jobberGraphQL<{ invoice: unknown }>(INVOICE_QUERY, { id: jobberInvoiceId });
      const invoice = (data as { invoice?: Record<string, any> } | null)?.invoice;
      // A null invoice is unreadable or deleted; the caller holds rather than guesses.
      if (!invoice || typeof invoice !== "object" || invoice.id !== jobberInvoiceId) return null;
      return {
        invoiceStatus: typeof invoice.invoiceStatus === "string" ? invoice.invoiceStatus : null,
        totalCents: cents(invoice.amounts?.total),
        balanceCents: cents(invoice.amounts?.invoiceBalance),
        issuedDate: typeof invoice.issuedDate === "string" ? invoice.issuedDate : null,
        dueDate: typeof invoice.dueDate === "string" ? invoice.dueDate : null,
        clientId: typeof invoice.client?.id === "string" ? invoice.client.id : null,
        clientTags: labelList(invoice.client?.tags?.nodes, "label"),
        lineItemNames: labelList(invoice.lineItems?.nodes, "name"),
        // null when Jobber returned no emails collection at all, so the caller
        // holds instead of treating "unreadable" as "no address on file".
        clientBillingEmails: Array.isArray(invoice.client?.emails)
          ? invoice.client.emails
              .map((entry: unknown) => (entry && typeof entry === "object"
                ? (entry as Record<string, unknown>).address : null))
              .filter((address: unknown): address is string =>
                typeof address === "string" && address.trim().length > 0)
              .map((address: string) => address.trim().toLowerCase())
          : null,
        // null when the collection is absent OR when Jobber holds more
        // properties than this page returned: a partial list could make a
        // contact look unmatched and send to the wrong record.
        clientPropertyAddresses: (() => {
          const properties = invoice.client?.clientProperties;
          const nodes = properties?.nodes;
          if (!Array.isArray(nodes)) return null;
          const total = properties?.totalCount;
          if (typeof total === "number" && total > nodes.length) return null;
          return nodes.map((node: any) => ({
            street1: typeof node?.address?.street1 === "string" ? node.address.street1 : null,
            city: typeof node?.address?.city === "string" ? node.address.city : null,
            postalCode: typeof node?.address?.postalCode === "string" ? node.address.postalCode : null,
          }));
        })(),
      };
    },

    async matchContacts(candidate: ReminderCandidate): Promise<DestinationContact[]> {
      const matches = await findExactContactMatches({ email: candidate.email, phone: candidate.phone });
      return matches.map(contact => ({
        id: contact.id,
        tags: Array.isArray(contact.tags) ? contact.tags.filter((t): t is string => typeof t === "string") : [],
        dnd: contact.dnd === true,
        emailDndStatus: (() => {
          const settings = contact.dndSettings;
          if (!settings || typeof settings !== "object") return null;
          if (!Object.prototype.hasOwnProperty.call(settings, "Email")) return null;
          const entry = (settings as Record<string, { status?: string | null } | null>).Email;
          return entry && typeof entry.status === "string" ? entry.status : null;
        })(),
        phone: contact.phone ?? null,
        email: contact.email ?? null,
        street1: contact.address1 ?? null,
        city: contact.city ?? null,
        postalCode: contact.postalCode ?? null,
      }));
    },

    /**
     * What GoHighLevel already sent this customer.
     *
     * Attribution is read off the message itself, never computed from the due
     * date: a reminder counts as THIS invoice's only when the body names this
     * invoice number. A body naming a different number is "other_invoice" and
     * suppresses nothing.
     *
     * An unnumbered message is "predates_invoice" ONLY when `context.issuedDate`
     * is known AND the message's own timestamp is known AND it is strictly
     * before the start of the invoice's issue day in Phoenix. That message
     * cannot be about an invoice that did not yet exist. Everything else —
     * including a message sent at any hour of the issue day itself, which is
     * exactly where a same-day legacy Day 15 SMS would land relative to a LATER
     * invoice — stays "ambiguous" and holds. Marking a message here does not
     * dismiss it; only `priorSendIgnoresPreIssueMessages` in the evaluator does.
     *
     * `milestoneDay` is left null because nothing in a GoHighLevel message says
     * which rung of the ladder it was. That is deliberate: a null milestone day
     * holds the row instead of letting a guess cancel a reminder.
     */
    async sendHistory(
      candidate: ReminderCandidate,
      context?: { issuedDate: string | null; contactId?: string | null },
    ): Promise<SendHistory | null> {
      const contacts = await findExactContactMatches({ email: candidate.email, phone: candidate.phone });
      // One exact contact, or the one the evaluation resolved by matching the
      // Jobber property address when several shared an email or phone. The id
      // is VERIFIED against the exact matches rather than trusted, so a stale
      // or foreign id reads no history instead of the wrong person's. Merging
      // several contacts' histories would invent an attribution, so it is never
      // done: without a resolved id, several contacts still hold.
      const resolved = typeof context?.contactId === "string" && context.contactId
        ? contacts.filter(contact => contact.id === context.contactId)
        : contacts;
      if (resolved.length !== 1) {
        return { complete: false, incompleteReason:
          `history needs exactly one exact contact; found ${contacts.length}` +
          (contacts.length > 1 && resolved.length !== 1 ? " and none was resolved by address" : ""),
          sends: [] };
      }
      const history = await getOutboundMessages(resolved[0].id);
      const mine = candidate.invoiceNumber?.trim() ?? "";
      const minePattern = mine ? new RegExp(`(?:^|[^0-9])${mine}(?:[^0-9]|$)`) : null;
      const anyInvoiceNumber = /#\s?\d{3,6}|invoice\s+#?\s?\d{3,6}/i;

      const issuedDate = context?.issuedDate ?? null;

      const sends: PriorSend[] = history.messages.map(message => {
        const namesMine = minePattern ? minePattern.test(message.body) : false;
        const namesSome = anyInvoiceNumber.test(message.body);
        // Only an UNNUMBERED message is ever dated against the invoice. A
        // message naming this invoice stays "exact" however old it is.
        const unnumbered = !namesMine && !namesSome;
        const predates = unnumbered &&
          priorSendRelevance(message.dateAdded, issuedDate) === "predates_invoice";
        const attribution: PriorSend["attribution"] =
          namesMine ? "exact"
          : namesSome ? "other_invoice"
          : predates ? "predates_invoice"
          : "ambiguous";
        return {
          messageId: message.id,
          channel: message.channel,
          milestoneDay: null,
          attribution,
          // A message present in the conversation log did go out. An attempt
          // that failed or is still queued does not appear as outbound here;
          // if that assumption ever breaks, the row must hold, not send.
          confirmed: true,
        };
      });
      return { complete: history.complete, incompleteReason: history.incompleteReason, sends };
    },

    /**
     * Every job Jobber links to this invoice, with each job's notes, read live.
     * Used by the Day 15 email path so the warranty / no-charge rule is applied
     * to the real linked job rather than to an invoice-number guess.
     */
    async linkedJobText(candidate: ReminderCandidate): Promise<LinkedJobsResult | null> {
      try { return await readLinkedJobText(candidate.jobberInvoiceId, jobberGraphQL); }
      catch { return null; }   // unreadable holds the row; it never passes
    },

    async cardsForContact(contactId: string): Promise<DestinationCard[]> {
      const { pipelineId, nameByStageId } = await pipelineRefs();
      const cards = await searchOpportunities(contactId, pipelineId);
      return cards.map(card => ({
        id: card.id,
        stage: card.pipelineStageId ? nameByStageId.get(card.pipelineStageId) ?? null : null,
        status: card.status ?? null,
      }));
    },
  };
}
