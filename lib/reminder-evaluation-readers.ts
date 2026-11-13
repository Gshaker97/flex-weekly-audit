import { jobberGraphQL } from "./jobber";
import { findExactContactMatches, getInvoicePipelineRefs, searchOpportunities } from "./ghl";
import type {
  DestinationCard, DestinationContact, ReminderCandidate,
  ReminderEvaluationReaders, SourceInvoice,
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
