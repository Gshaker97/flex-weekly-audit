/**
 * READ-ONLY review-mode preview of the one-card-per-customer board.
 *
 * Runs the real resolver and the real card planner against the real Jobber
 * snapshot and the real GoHighLevel board, and prints what WOULD happen. It
 * performs no write of any kind: no contact is created, no card is created or
 * moved, no environment variable is read for permission because none is
 * needed - the write path is simply never called.
 *
 * Usage:  tsx scripts/customer-card-preview.ts
 */
import {
  getInvoicePipelineRefs, listContactsForPhoneMatching, listPipelineOpportunities,
} from "../lib/ghl";
import { invoiceReminderClock } from "../lib/invoice-reminder-clock";
import { invoiceWindowStart, type ExistingCard, type InvoiceFact } from "../lib/ghl-invoice-card-plan";
import { planCustomerCard, type CustomerCardDecision } from "../lib/ghl-customer-card-plan";
import { resolvePayers, type ResolverCard, type ResolverCustomer } from "../lib/ghl-contact-resolution";
import { prisma } from "../lib/prisma";

const LOOKBACK_MONTHS = Number(process.env.GHL_INVOICE_LOOKBACK_MONTHS ?? 4) || 4;
const CHASEABLE = new Set(["awaiting_payment", "past_due"]);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

function bump(map: Map<string, number>, key: string) { map.set(key, (map.get(key) ?? 0) + 1); }
function example(map: Map<string, string[]>, key: string, who: string, cap = 3) {
  const list = map.get(key) ?? [];
  if (list.length < cap && !list.includes(who)) list.push(who);
  map.set(key, list);
}

async function main() {
  const now = new Date();
  const windowStart = invoiceWindowStart(now, LOOKBACK_MONTHS);
  console.log(`REVIEW-MODE PREVIEW. No writes. ${now.toISOString()}`);
  console.log(`lookback ${LOOKBACK_MONTHS} months, window starts ${windowStart}\n`);

  // --- Jobber side, from the synced snapshot -------------------------------
  const customers = await prisma.customer.findMany();
  const invoices = await prisma.invoiceRecord.findMany();

  const byCustomer = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    if (!inv.customerId) continue;
    const list = byCustomer.get(inv.customerId) ?? [];
    list.push(inv);
    byCustomer.set(inv.customerId, list);
  }

  const asResolver = (c: (typeof customers)[number]): ResolverCustomer => ({
    id: c.id,
    jobberClientId: c.jobberClientId,
    email: c.email,
    phone: c.phone,
    name: c.name ?? c.companyName ?? null,
    // Jobber's billing address, as the client sync stored it.
    address1: c.billingStreet,
    city: c.billingCity,
    state: c.billingState,
    postalCode: c.billingPostalCode,
  });

  const allCustomers = customers.map(asResolver);
  const wantedIds = new Set<string>();
  for (const c of customers) {
    const mine = byCustomer.get(c.id) ?? [];
    const chaseable = mine.some(i =>
      (i.amountDue ?? 0) > 0
      && CHASEABLE.has((i.invoiceStatus ?? "").toLowerCase())
      && (!i.issuedAt || (day(i.issuedAt) as string) >= windowStart));
    if (chaseable) wantedIds.add(c.id);
  }
  const wanted = allCustomers.filter(c => wantedIds.has(c.id));
  console.log(`Jobber: ${customers.length} customers, ${wanted.length} with a chaseable unpaid invoice in the window`);

  // --- GoHighLevel side, read only -----------------------------------------
  const contacts = await listContactsForPhoneMatching();
  const refs = await getInvoicePipelineRefs();
  const stageNameById = new Map<string, string>();
  for (const [name, id] of Object.entries(refs.stageIdByName)) stageNameById.set(id, name);
  const rawCards = await listPipelineOpportunities(refs.pipelineId);
  const cards: ResolverCard[] = rawCards.map(k => ({
    id: k.id,
    contactId: (k as any).contactId ?? (k as any).contact?.id ?? null,
    stageName: stageNameById.get((k as any).pipelineStageId ?? "") ?? null,
    status: (k as any).status ?? null,
    monetaryValue: (k as any).monetaryValue ?? null,
    name: (k as any).name ?? null,
  }));
  console.log(`GoHighLevel: ${contacts.length} contacts, ${cards.length} cards in the Invoice Pipeline\n`);

  // --- resolve -------------------------------------------------------------
  const { payers, holds, creations } = resolvePayers({
    customers: wanted, allCustomers, contacts, cards,
  });

  const factsFor = (customerIds: readonly string[]): InvoiceFact[] => {
    const out: InvoiceFact[] = [];
    for (const id of customerIds) {
      for (const i of byCustomer.get(id) ?? []) {
        out.push({
          invoiceId: i.jobberInvoiceId,
          invoiceNumber: i.invoiceNumber,
          status: i.invoiceStatus,
          totalDollars: i.total,
          balanceDollars: i.amountDue,
          issuedDate: day(i.issuedAt),
          dueDate: day(i.dueAt),
        });
      }
    }
    return out;
  };
  const clocksFor = (facts: readonly InvoiceFact[]) => {
    const out: Record<string, { daysPastDue: number; isOverdue: boolean; sentOn: string } | null> = {};
    for (const f of facts) {
      const c = invoiceReminderClock(f.issuedDate, f.dueDate, now);
      out[f.invoiceId] = c ? { daysPastDue: c.daysPastDue, isOverdue: c.isOverdue, sentOn: c.sentOn } : null;
    }
    return out;
  };
  const labelFor = (ids: readonly string[]) => {
    const names = ids.map(id => customers.find(c => c.id === id)?.name
      ?? customers.find(c => c.id === id)?.companyName ?? "").filter(Boolean);
    return [...new Set(names)].join(" + ") || "Customer";
  };

  const states = new Map<string, number>();
  const holdReasons = new Map<string, number>();
  const holdWho = new Map<string, string[]>();
  const createdCards: string[] = [];
  const updatedCards: string[] = [];
  const restarted: string[] = [];

  const run = (
    contactId: string, ids: readonly string[], open: readonly ResolverCard[],
    finished: readonly ResolverCard[],
  ): CustomerCardDecision => {
    const facts = factsFor(ids);
    return planCustomerCard({
      contactId,
      label: labelFor(ids),
      invoices: facts,
      cards: open.map((k): ExistingCard => ({
        id: k.id, name: k.name ?? null, stageName: k.stageName ?? null,
        status: k.status ?? null, monetaryValue: k.monetaryValue ?? null,
      })),
      finishedCardIds: finished.map(k => k.id),
      clocks: clocksFor(facts),
      windowStart,
      // No operator-recorded proof that the legacy workflow's sending is off,
      // so every Overdue move is withheld and new cards start in Invoice Sent.
      legacyWorkflowId: process.env.GHL_LEGACY_WORKFLOW_ID ?? "",
      legacySending: null,
      now,
    });
  };

  for (const p of payers) {
    const who = labelFor(p.customers.map(c => c.id));
    const d = run(p.contactId, p.customers.map(c => c.id), p.openCards, p.finishedCards);
    bump(states, d.state);
    if (d.state === "create") {
      createdCards.push(who);
      if (d.reasons.includes("started_a_new_card_because_the_previous_one_is_finished")) restarted.push(who);
    }
    if (d.state === "update") updatedCards.push(who);
    if (d.state === "hold") for (const r of d.reasons) { bump(holdReasons, `card: ${r}`); example(holdWho, `card: ${r}`, who); }
    if (d.state === "skip") for (const r of d.reasons) bump(holdReasons, `skip: ${r}`);
  }

  const newContactCards: string[] = [];
  for (const made of creations) {
    const who = made.name;
    const d = run(made.placeholderContactId, [made.customer.id], [], []);
    bump(states, `new-contact:${d.state}`);
    if (d.state === "create") newContactCards.push(who);
    if (d.state === "hold") for (const r of d.reasons) { bump(holdReasons, `card: ${r}`); example(holdWho, `card: ${r}`, who); }
  }

  for (const h of holds) {
    bump(holdReasons, `resolve: ${h.reason}`);
    example(holdWho, `resolve: ${h.reason}`, labelFor(h.customerIds));
  }

  // --- report ---------------------------------------------------------------
  console.log(`WOULD CREATE ${creations.length} GoHighLevel contact(s)`);
  const byVia = new Map<string, number>();
  for (const c of creations) bump(byVia, c.via);
  for (const [k, v] of byVia) console.log(`   ${v}  ${k}`);
  for (const c of creations.slice(0, 5)) {
    const where = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(", ");
    console.log(`   - ${c.name} | address: ${where || "(none on file in Jobber)"}`);
  }
  const withoutAddress = creations.filter(
    c => !c.address1 && !c.city && !c.state && !c.postalCode).length;
  console.log(`   ${creations.length - withoutAddress} would carry a billing address, ${withoutAddress} would not`);

  console.log(`\nWOULD CREATE ${createdCards.length + newContactCards.length} card(s)`);
  console.log(`   ${createdCards.length} on contacts that already exist`);
  console.log(`      of which ${restarted.length} restart a finished (won/lost) card`);
  console.log(`      examples: ${createdCards.slice(0, 5).join("; ") || "(none)"}`);
  console.log(`      restart examples: ${restarted.slice(0, 5).join("; ") || "(none)"}`);
  console.log(`   ${newContactCards.length} on the contacts above, once they exist`);
  console.log(`      examples: ${newContactCards.slice(0, 5).join("; ") || "(none)"}`);

  console.log(`\nWOULD UPDATE ${updatedCards.length} existing card(s)`);
  console.log(`   examples: ${updatedCards.slice(0, 5).join("; ") || "(none)"}`);

  console.log(`\nplan states: ${JSON.stringify(Object.fromEntries(states))}`);

  const held = [...holdReasons.entries()].sort((a, b) => b[1] - a[1]);
  const heldTotal = held.reduce((s, [, v]) => s + v, 0);
  console.log(`\nSTILL HELD: ${heldTotal}`);
  for (const [reason, count] of held) {
    console.log(`   ${String(count).padStart(4)}  ${reason}`);
    const who = holdWho.get(reason);
    if (who?.length) console.log(`         e.g. ${who.join("; ")}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("preview failed:", e?.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
