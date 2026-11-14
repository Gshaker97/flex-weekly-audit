import { jobberGraphQL } from "./jobber";
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
    client { id tags { nodes { label } } }
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
      };
    },

    async matchContacts(candidate: ReminderCandidate): Promise<DestinationContact[]> {
      const matches = await findExactContactMatches({ email: candidate.email, phone: candidate.phone });
      return matches.map(contact => ({
        id: contact.id,
        tags: Array.isArray(contact.tags) ? contact.tags.filter((t): t is string => typeof t === "string") : [],
        dnd: contact.dnd === true,
        phone: contact.phone ?? null,
        email: contact.email ?? null,
      }));
    },

    /**
     * What GoHighLevel already sent this customer.
     *
     * Attribution is read off the message itself, never computed from the due
     * date: a reminder counts as THIS invoice's only when the body names this
     * invoice number. A body naming a different number is "other_invoice" and
     * suppresses nothing. Anything else is "ambiguous" and holds.
     *
     * `milestoneDay` is left null because nothing in a GoHighLevel message says
     * which rung of the ladder it was. That is deliberate: a null milestone day
     * holds the row instead of letting a guess cancel a reminder.
     */
    async sendHistory(candidate: ReminderCandidate): Promise<SendHistory | null> {
      const contacts = await findExactContactMatches({ email: candidate.email, phone: candidate.phone });
      // One exact contact or no history at all. Several already holds upstream,
      // and merging their histories would invent an attribution.
      if (contacts.length !== 1) {
        return { complete: false, incompleteReason:
          `history needs exactly one exact contact; found ${contacts.length}`, sends: [] };
      }
      const history = await getOutboundMessages(contacts[0].id);
      const mine = candidate.invoiceNumber?.trim() ?? "";
      const minePattern = mine ? new RegExp(`(?:^|[^0-9])${mine}(?:[^0-9]|$)`) : null;
      const anyInvoiceNumber = /#\s?\d{3,6}|invoice\s+#?\s?\d{3,6}/i;

      const sends: PriorSend[] = history.messages.map(message => {
        const namesMine = minePattern ? minePattern.test(message.body) : false;
        const namesSome = anyInvoiceNumber.test(message.body);
        const attribution: PriorSend["attribution"] =
          namesMine ? "exact" : namesSome ? "other_invoice" : "ambiguous";
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
