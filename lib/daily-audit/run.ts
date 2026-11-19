// Daily audit: read-only checks that the dashboard matches Jobber, and that
// every late invoice is getting its reminder texts (and emails, where GHL
// sends them) on the right day.
//
// What it reads: the dashboard's Postgres cache, Jobber (GraphQL, the app's
// existing connection) and GoHighLevel (GET requests only, lib/daily-audit/
// ghl-read.ts). What it writes: one DailyAuditReport row. It never writes to
// Jobber or GHL, never sends a message, and never changes cached records.

import { prisma } from "../prisma";
import { log, logError } from "../log";
import {
  concatJobNotes,
  fetchAllInvoices,
  fetchJobsInRange,
  jobberGraphQL,
  JobberInvoiceNode,
  JobberJobNode,
} from "../jobber";
import {
  addDays,
  azDate,
  CALL_PROMPT_DAY,
  daysBetween,
  JOBBER_EMAIL_DAYS,
  resolveServiceCategory,
  ServiceCategory,
  SHARED_STEPS,
  stepStatus,
  TEXT_LADDER,
} from "./calendar";
import {
  AuditContact,
  findContactIdsByEmail,
  getContact,
  getInvoicePipeline,
  getOutboundMessages,
  ghlConfigured,
  listOpportunities,
  OutboundMessage,
} from "./ghl-read";

// Same cutoff as the Collections tab and the GHL invoice sync.
const SINCE = new Date("2026-01-01T00:00:00Z");
// Fetch from slightly before the cutoff (Jobber's "after" filter is exclusive),
// then compare both sides on the same cutoff.
const FETCH_SINCE = new Date("2025-12-31T00:00:00Z");
// Only reminder steps scheduled within this many days are judged each day.
const LOOKBACK_DAYS = 21;
// Job parity window.
const JOB_WINDOW_DAYS = 14;
// The legacy GHL text ladder ("Fixed Automation") only enrolls contacts that
// carry this exact tag (confirmed in the GHL builder on 2026-11-17, per
// lib/reminder-native-sms-overlap.ts on the reminder branches).
const TEXT_GATE_TAG = "flex-native-paula-approved";
const MONEY_TOLERANCE = 0.01;
const CARD_TOLERANCE = 1;
const MAX_ROWS = 300;

export type CheckStatus = "pass" | "warn" | "fail" | "error";
export type Row = Record<string, string | number | null>;

export interface CheckResult {
  key: string;
  title: string;
  status: CheckStatus;
  summary: string;
  columns: string[];
  rows: Row[];
  totalRows: number;
  notes: string[];
}

function result(
  key: string,
  title: string,
  status: CheckStatus,
  summary: string,
  columns: string[] = [],
  rows: Row[] = [],
  notes: string[] = []
): CheckResult {
  return { key, title, status, summary, columns, rows: rows.slice(0, MAX_ROWS), totalRows: rows.length, notes };
}

function errorResult(key: string, title: string, err: unknown): CheckResult {
  const msg = err instanceof Error ? err.message : String(err);
  return result(key, title, "error", `Couldn't run this check: ${msg}`);
}

const money = (n: number | null | undefined) =>
  n == null ? null : `$${n.toFixed(2)}`;

function clientLabel(c: { name?: string | null; companyName?: string | null } | null | undefined) {
  return c?.companyName || c?.name || "Unknown client";
}

function isCompletedStatus(status: string | null | undefined) {
  if (!status) return false;
  const s = status.toLowerCase();
  return s.includes("complete") || s === "archived" || s === "invoiced" || s === "paid";
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
}

// --- 1. Sync freshness --------------------------------------------------------

async function checkSync(now: Date): Promise<CheckResult> {
  const key = "sync";
  const title = "Jobber sync is running";
  const latest = await prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } });
  const lastGood = await prisma.syncRun.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
  });
  const failed24h = await prisma.syncRun.findMany({
    where: { status: "failed", startedAt: { gte: new Date(now.getTime() - 86_400_000) } },
    orderBy: { startedAt: "desc" },
    take: 20,
  });
  const rows: Row[] = failed24h.map((r) => ({
    Started: r.startedAt.toISOString(),
    Trigger: r.triggeredBy,
    Error: (r.errorMessage ?? "").slice(0, 200),
  }));
  if (!lastGood?.completedAt) {
    return result(key, title, "fail", "No sync has ever finished.", ["Started", "Trigger", "Error"], rows);
  }
  const ageMin = Math.round((now.getTime() - lastGood.completedAt.getTime()) / 60_000);
  const lastLine = `Last finished sync: ${ageMin} minutes ago.`;
  if (ageMin > 120) {
    return result(key, title, "fail", `${lastLine} The hourly sync has stalled, so the dashboard is out of date.`, ["Started", "Trigger", "Error"], rows);
  }
  if (latest?.status === "failed") {
    return result(key, title, "fail", `${lastLine} The most recent run failed.`, ["Started", "Trigger", "Error"], rows);
  }
  if (failed24h.length > 0) {
    return result(key, title, "warn", `${lastLine} ${failed24h.length} run(s) failed in the last 24 hours.`, ["Started", "Trigger", "Error"], rows);
  }
  return result(key, title, "pass", lastLine);
}

// --- Shared Jobber/cache context --------------------------------------------

interface InvoiceContext {
  jobber: JobberInvoiceNode[]; // issued on/after SINCE
  cache: Awaited<ReturnType<typeof loadCacheInvoices>>;
}

async function loadCacheInvoices() {
  return prisma.invoiceRecord.findMany({
    where: { issuedAt: { gte: SINCE } },
    include: { customer: true },
  });
}

async function loadInvoices(): Promise<InvoiceContext> {
  const all = await fetchAllInvoices(null, FETCH_SINCE);
  const jobber = all.filter((i) => i.issuedDate && new Date(i.issuedDate) >= SINCE);
  const cache = await loadCacheInvoices();
  return { jobber, cache };
}

const balanceOf = (i: JobberInvoiceNode) => i.amounts?.invoiceBalance ?? 0;
const totalOf = (i: JobberInvoiceNode) => i.amounts?.total ?? 0;

// --- 2. Invoice parity --------------------------------------------------------

function checkInvoiceParity(ctx: InvoiceContext): CheckResult {
  const key = "invoices";
  const title = "Dashboard invoices match Jobber";
  const cacheById = new Map(ctx.cache.map((c) => [c.jobberInvoiceId, c]));
  const jobberIds = new Set(ctx.jobber.map((j) => j.id));
  const rows: Row[] = [];

  for (const j of ctx.jobber) {
    const c = cacheById.get(j.id);
    const base = { Invoice: j.invoiceNumber ?? j.id, Customer: clientLabel(j.client) };
    if (!c) {
      rows.push({ ...base, Problem: "Missing from the dashboard", Jobber: `${j.invoiceStatus} ${money(balanceOf(j))} owed`, Dashboard: null });
      continue;
    }
    const diffs: string[] = [];
    const jb: string[] = [];
    const db: string[] = [];
    if ((c.invoiceStatus ?? null) !== (j.invoiceStatus ?? null)) {
      diffs.push("status");
      jb.push(String(j.invoiceStatus));
      db.push(String(c.invoiceStatus));
    }
    if (Math.abs((c.amountDue ?? 0) - balanceOf(j)) > MONEY_TOLERANCE) {
      diffs.push("balance");
      jb.push(`${money(balanceOf(j))} owed`);
      db.push(`${money(c.amountDue)} owed`);
    }
    if (Math.abs((c.total ?? 0) - totalOf(j)) > MONEY_TOLERANCE) {
      diffs.push("total");
      jb.push(`${money(totalOf(j))} total`);
      db.push(`${money(c.total)} total`);
    }
    const jDue = j.dueDate ? new Date(j.dueDate).getTime() : null;
    const cDue = c.dueAt ? c.dueAt.getTime() : null;
    if (jDue !== cDue) {
      diffs.push("due date");
      jb.push(`due ${azDate(j.dueDate) ?? "none"}`);
      db.push(`due ${c.dueAt ? c.dueAt.toISOString().slice(0, 10) : "none"}`);
    }
    if (diffs.length) {
      rows.push({ ...base, Problem: `Different ${diffs.join(", ")}`, Jobber: jb.join("; "), Dashboard: db.join("; ") });
    }
  }
  for (const c of ctx.cache) {
    if (jobberIds.has(c.jobberInvoiceId)) continue;
    if ((c.invoiceStatus ?? "") === "void") continue;
    rows.push({
      Invoice: c.invoiceNumber ?? c.jobberInvoiceId,
      Customer: c.clientName ?? c.customer?.name ?? "Unknown client",
      Problem: "On the dashboard but not in Jobber (deleted?)",
      Jobber: null,
      Dashboard: `${c.invoiceStatus} ${money(c.amountDue)} owed`,
    });
  }
  const columns = ["Invoice", "Customer", "Problem", "Jobber", "Dashboard"];
  const summaryBase = `Compared ${ctx.jobber.length} Jobber invoices issued since Jan 1 with ${ctx.cache.length} on the dashboard.`;
  if (!rows.length) return result(key, title, "pass", `${summaryBase} All match.`);
  return result(key, title, "fail", `${summaryBase} ${rows.length} don't match.`, columns, rows, [
    "A change made in Jobber since the last hourly sync can show here until the next sync picks it up.",
  ]);
}

// --- 3. Job parity and uninvoiced work ---------------------------------------

async function checkJobs(now: Date): Promise<CheckResult> {
  const key = "jobs";
  const title = "Recent jobs match Jobber and are invoiced";
  const start = new Date(now.getTime() - JOB_WINDOW_DAYS * 86_400_000);
  const live: JobberJobNode[] = await fetchJobsInRange(start, now);
  const cache = await prisma.jobRecord.findMany({
    where: { jobberJobId: { in: live.map((j) => j.id) } },
  });
  const cacheById = new Map(cache.map((c) => [c.jobberJobId, c]));
  const rows: Row[] = [];
  for (const j of live) {
    const c = cacheById.get(j.id);
    const hasInvoice = (j.invoices?.nodes?.length ?? 0) > 0;
    const noInvoiceNote = concatJobNotes(j).toLowerCase().includes("no invoice");
    const completed = isCompletedStatus(j.jobStatus) || !!j.completedAt;
    const base = {
      Job: j.jobNumber != null ? `#${j.jobNumber}` : j.id,
      Customer: clientLabel(j.client),
      Completed: azDate(j.completedAt),
    };
    if (!c) {
      rows.push({ ...base, Problem: "Missing from the dashboard", Detail: `${j.jobStatus ?? "no status"}` });
    } else {
      const diffs: string[] = [];
      if ((c.jobStatus ?? null) !== (j.jobStatus ?? null)) diffs.push(`status: Jobber ${j.jobStatus}, dashboard ${c.jobStatus}`);
      if (c.hasInvoice !== hasInvoice) diffs.push(`invoice: Jobber ${hasInvoice ? "yes" : "no"}, dashboard ${c.hasInvoice ? "yes" : "no"}`);
      if (diffs.length) rows.push({ ...base, Problem: "Doesn't match Jobber", Detail: diffs.join("; ") });
    }
    if (completed && !hasInvoice && !noInvoiceNote) {
      rows.push({ ...base, Problem: "Completed with no invoice", Detail: `${money(j.total != null ? Number(j.total) : null) ?? "no total"}; no "No Invoice" note` });
    }
  }
  const columns = ["Job", "Customer", "Completed", "Problem", "Detail"];
  const summaryBase = `Checked ${live.length} jobs completed or ending in the last ${JOB_WINDOW_DAYS} days.`;
  if (!rows.length) return result(key, title, "pass", `${summaryBase} All match and are invoiced.`);
  const mismatches = rows.filter((r) => r.Problem !== "Completed with no invoice").length;
  return result(
    key,
    title,
    mismatches ? "fail" : "warn",
    `${summaryBase} ${mismatches} don't match the dashboard; ${rows.length - mismatches} completed with no invoice.`,
    columns,
    rows
  );
}

// --- 4. Headline totals -------------------------------------------------------

function checkTotals(ctx: InvoiceContext): CheckResult {
  const key = "totals";
  const title = "Dashboard overdue and open totals match Jobber";
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const jPast = ctx.jobber.filter((i) => i.invoiceStatus === "past_due");
  const jOpen = ctx.jobber.filter((i) => i.invoiceStatus === "past_due" || i.invoiceStatus === "awaiting_payment");
  // Dashboard side uses the same definition as the Collections tab.
  const cPast = ctx.cache.filter((i) => i.invoiceStatus === "past_due");
  const cOpen = ctx.cache.filter((i) => i.invoiceStatus === "past_due" || i.invoiceStatus === "awaiting_payment");

  const lines = [
    { name: "Overdue invoices", jc: jPast.length, js: sum(jPast.map(balanceOf)), cc: cPast.length, cs: sum(cPast.map((i) => i.amountDue ?? 0)) },
    { name: "Open invoices (sent + overdue)", jc: jOpen.length, js: sum(jOpen.map(balanceOf)), cc: cOpen.length, cs: sum(cOpen.map((i) => i.amountDue ?? 0)) },
  ];
  const rows: Row[] = lines.map((l) => ({
    Measure: l.name,
    Jobber: `${l.jc} / ${money(l.js)}`,
    Dashboard: `${l.cc} / ${money(l.cs)}`,
    Match: l.jc === l.cc && Math.abs(l.js - l.cs) <= CARD_TOLERANCE ? "yes" : "no",
  }));
  const bad = rows.filter((r) => r.Match === "no").length;
  return result(
    key,
    title,
    bad ? "fail" : "pass",
    bad ? `${bad} of 2 totals differ from Jobber.` : "Overdue and open totals match Jobber.",
    ["Measure", "Jobber", "Dashboard", "Match"],
    rows,
    ["Invoices issued since Jan 1, 2026, the same cutoff the Collections tab uses."]
  );
}

// --- Past-due customers with GHL evidence ------------------------------------

interface PastDueInvoice {
  node: JobberInvoiceNode;
  cacheId: string | null;
  dueOn: string;
  daysPastDue: number;
  category: ServiceCategory;
  categoryReason: string;
  jobberLabels: string[] | null;
}

interface PastDueCustomer {
  clientId: string;
  name: string;
  email: string | null;
  phone: string | null;
  invoices: PastDueInvoice[];
  owed: number;
  contactIds: string[];
  contacts: AuditContact[];
  messages: OutboundMessage[];
  historyComplete: boolean;
  ghlError: string | null;
}

const INVOICE_LABELS_QUERY = `query DailyAuditInvoiceLabels($id: EncodedId!) {
  invoice(id: $id) {
    id
    lineItems(first: 20) { nodes { name } }
    client { id tags { nodes { label } } }
  }
}`;

async function readInvoiceLabels(id: string): Promise<string[] | null> {
  try {
    const data: any = await jobberGraphQL(INVOICE_LABELS_QUERY, { id });
    const inv = data?.invoice;
    if (!inv) return null;
    const items = (inv.lineItems?.nodes ?? []).map((n: any) => n?.name).filter((s: any) => typeof s === "string");
    const tags = (inv.client?.tags?.nodes ?? []).map((n: any) => n?.label).filter((s: any) => typeof s === "string");
    return [...tags, ...items];
  } catch (err: any) {
    logError("[daily-audit] invoice labels read failed:", err?.message ?? err);
    return null;
  }
}

async function loadPastDue(ctx: InvoiceContext, today: string): Promise<PastDueCustomer[]> {
  const cacheByJobberId = new Map(ctx.cache.map((c) => [c.jobberInvoiceId, c]));
  const pastDue = ctx.jobber.filter((i) => i.invoiceStatus === "past_due" && balanceOf(i) > MONEY_TOLERANCE);

  const clientIds = Array.from(new Set(pastDue.map((i) => i.client?.id).filter((x): x is string => !!x)));
  const customers = await prisma.customer.findMany({ where: { jobberClientId: { in: clientIds } } });
  const customerByClient = new Map(customers.map((c) => [c.jobberClientId, c]));

  const labelsById = new Map<string, string[] | null>();
  await mapLimit(pastDue, 2, async (inv) => {
    labelsById.set(inv.id, await readInvoiceLabels(inv.id));
  });

  const byClient = new Map<string, PastDueCustomer>();
  for (const inv of pastDue) {
    const clientId = inv.client?.id ?? `unknown:${inv.id}`;
    const dueOn = azDate(inv.dueDate);
    if (!dueOn) continue;
    const cust = customerByClient.get(clientId);
    let entry = byClient.get(clientId);
    if (!entry) {
      entry = {
        clientId,
        name: clientLabel(inv.client),
        email: cust?.email?.trim() || null,
        phone: cust?.phone?.trim() || null,
        invoices: [],
        owed: 0,
        contactIds: [],
        contacts: [],
        messages: [],
        historyComplete: true,
        ghlError: null,
      };
      byClient.set(clientId, entry);
    }
    entry.invoices.push({
      node: inv,
      cacheId: cacheByJobberId.get(inv.id)?.id ?? null,
      dueOn,
      daysPastDue: daysBetween(dueOn, today),
      category: "unknown",
      categoryReason: "",
      jobberLabels: labelsById.get(inv.id) ?? null,
    });
    entry.owed += balanceOf(inv);
  }

  const list = Array.from(byClient.values());
  if (ghlConfigured()) {
    await mapLimit(list, 3, async (c) => {
      if (!c.email) return;
      try {
        c.contactIds = await findContactIdsByEmail(c.email);
        for (const id of c.contactIds) {
          c.contacts.push(await getContact(id));
          const h = await getOutboundMessages(id);
          c.messages.push(...h.messages);
          if (!h.complete) c.historyComplete = false;
        }
      } catch (err: any) {
        c.ghlError = err?.message ?? String(err);
      }
    });
  }

  for (const c of list) {
    const ghlTags = c.contacts.length ? c.contacts.flatMap((x) => x.tags) : null;
    for (const inv of c.invoices) {
      const r = resolveServiceCategory({ jobberLabels: inv.jobberLabels, ghlTags });
      inv.category = r.category;
      inv.categoryReason = r.reason;
    }
  }
  return list;
}

/** Why a customer can't be texted or emailed, if anything stands in the way. */
function reachProblems(c: PastDueCustomer): { text: string[]; email: string[]; other: string[] } {
  const text: string[] = [];
  const email: string[] = [];
  const other: string[] = [];
  if (!c.email) other.push("No email in Jobber, so no GHL contact can be matched");
  if (!c.phone) text.push("No phone in Jobber");
  if (c.ghlError) other.push(`GHL lookup failed: ${c.ghlError}`);
  if (c.email && !c.ghlError && c.contactIds.length === 0) other.push("No GHL contact with this email");
  if (c.contactIds.length > 1) other.push(`${c.contactIds.length} GHL contacts share this email`);
  if (c.contacts.length) {
    if (c.contacts.every((x) => x.smsBlocked)) text.push("Texts blocked (DND) in GHL");
    if (c.contacts.every((x) => x.emailBlocked)) email.push("Email blocked (DND) in GHL");
    if (!c.contacts.some((x) => x.tags.includes(TEXT_GATE_TAG))) {
      text.push(`Missing the "${TEXT_GATE_TAG}" tag, so the GHL text workflow can't enroll them`);
    }
    if (!c.contacts.some((x) => !!x.phone)) text.push("No phone on the GHL contact");
  }
  if (!c.historyComplete) other.push("Message history too long to read in full");
  return { text, email, other };
}

// --- 5. GHL Invoice Pipeline --------------------------------------------------

async function checkPipeline(customers: PastDueCustomer[], today: string): Promise<CheckResult> {
  const key = "pipeline";
  const title = "GHL Invoice Pipeline matches Jobber";
  if (!ghlConfigured()) return result(key, title, "error", "GHL_API_KEY / GHL_LOCATION_ID aren't set.");
  const pipe = await getInvoicePipeline();
  const overdueStage = pipe.stageIdByName.get("invoice overdue");
  if (!overdueStage) return result(key, title, "error", 'The "Invoice Overdue" stage wasn\'t found in the Invoice Pipeline.');
  const { complete, opps } = await listOpportunities(pipe.pipelineId);
  const open = opps.filter((o) => (o.status ?? "open") === "open");
  const byContact = new Map<string, typeof open>();
  for (const o of open) {
    if (!o.contactId) continue;
    const list = byContact.get(o.contactId) ?? [];
    list.push(o);
    byContact.set(o.contactId, list);
  }

  const rows: Row[] = [];
  const pastDueContacts = new Set<string>();
  for (const c of customers) {
    // Only customers past the first overdue day belong in Invoice Overdue.
    if (!c.invoices.some((i) => i.daysPastDue >= 1)) continue;
    if (c.contactIds.length !== 1) continue; // covered by the reach check
    const contactId = c.contactIds[0];
    pastDueContacts.add(contactId);
    const cards = byContact.get(contactId) ?? [];
    const inOverdue = cards.filter((o) => o.stageId === overdueStage);
    const base = { Customer: c.name, Owed: money(c.owed) };
    if (!cards.length) {
      rows.push({ ...base, Problem: "No open card in the Invoice Pipeline", Card: null });
    } else if (!inOverdue.length) {
      const stages = cards.map((o) => pipe.stageNameById.get(o.stageId ?? "") ?? "unknown stage").join(", ");
      rows.push({ ...base, Problem: "Card isn't in Invoice Overdue", Card: stages });
    } else {
      if (inOverdue.length > 1) rows.push({ ...base, Problem: `${inOverdue.length} open cards in Invoice Overdue`, Card: inOverdue.map((o) => o.name ?? o.id).join("; ") });
      const value = inOverdue[0].monetaryValue;
      if (value == null || Math.abs(value - c.owed) > CARD_TOLERANCE) {
        rows.push({ ...base, Problem: "Card value doesn't match what's owed", Card: `${money(value)} on the card` });
      }
    }
  }
  // Cards still in Invoice Overdue for customers with nothing past due.
  const staleCards = open.filter((o) => o.stageId === overdueStage && o.contactId && !pastDueContacts.has(o.contactId));
  const knownPastDueIds = new Set(customers.flatMap((c) => c.contactIds));
  for (const o of staleCards) {
    if (o.contactId && knownPastDueIds.has(o.contactId)) continue; // ambiguous contact, reported in reach
    let recentText = "";
    try {
      const h = await getOutboundMessages(o.contactId!);
      const last = h.messages.filter((m) => m.channel === "sms").map((m) => azDate(m.dateAdded)!).sort().pop();
      if (last && daysBetween(last, today) <= 3) recentText = ` Texted on ${last}.`;
    } catch {
      /* best effort */
    }
    rows.push({
      Customer: o.name ?? o.id,
      Owed: "$0.00",
      Problem: `In Invoice Overdue but nothing is past due in Jobber.${recentText}`,
      Card: `${money(o.monetaryValue)} on the card`,
    });
  }

  const columns = ["Customer", "Owed", "Problem", "Card"];
  const notes = complete ? [] : ["The pipeline has more cards than one run can read; some may be missing."];
  notes.push("Past-due customers whose GHL contact can't be matched by email are listed under contact problems instead.");
  if (!rows.length) return result(key, title, "pass", `${pastDueContacts.size} past-due customers all have the right card.`, columns, rows, notes);
  return result(key, title, "fail", `${rows.length} card problems.`, columns, rows, notes);
}

// --- 6. Reminder ladder -------------------------------------------------------

function checkReminders(customers: PastDueCustomer[], today: string): CheckResult {
  const key = "reminders";
  const title = "Late-invoice reminders went out on their day";
  const rows: Row[] = [];
  let sentCount = 0;
  let evaluated = 0;
  let emailCount = 0;
  let unknownType = 0;

  for (const c of customers) {
    // One ladder per customer, anchored on their oldest overdue invoice: GHL
    // keeps one card per contact, so the workflow runs once per customer.
    const oldest = c.invoices.slice().sort((a, b) => (a.dueOn < b.dueOn ? -1 : 1))[0];
    if (!oldest || oldest.daysPastDue < 1) continue;
    const cats = new Set(c.invoices.map((i) => i.category));
    const category: ServiceCategory = cats.size === 1 ? oldest.category : "unknown";
    if (category === "unknown") unknownType += 1;
    const steps = category === "unknown" ? SHARED_STEPS : TEXT_LADDER[category];
    const smsDates = c.messages.filter((m) => m.channel === "sms").map((m) => azDate(m.dateAdded)!);
    const emailDates = c.messages.filter((m) => m.channel === "email").map((m) => azDate(m.dateAdded)!);
    const reach = reachProblems(c);
    const why = [...reach.other, ...reach.text].join("; ") || null;

    for (const step of steps) {
      const scheduledOn = addDays(oldest.dueOn, step);
      const age = daysBetween(scheduledOn, today);
      if (age < 0 || age > LOOKBACK_DAYS) continue;
      evaluated += 1;
      const text = stepStatus(scheduledOn, today, smsDates);
      const email = stepStatus(scheduledOn, today, emailDates);
      if (email.status === "sent" || email.status === "late" || email.status === "early") emailCount += 1;
      if (text.status === "sent") {
        sentCount += 1;
        continue;
      }
      if (text.status === "due") continue;
      rows.push({
        Customer: c.name,
        Type: category === "unknown" ? `unknown (${oldest.categoryReason})` : category,
        Due: oldest.dueOn,
        Step: `Day ${step}`,
        Scheduled: scheduledOn,
        Text: text.status === "missed" ? "missed" : `${text.status} (${text.sentOn})`,
        Email: email.sentOn ? `sent ${email.sentOn}` : "none",
        Owed: money(c.owed),
        Why: why,
      });
    }
  }

  const missed = rows.filter((r) => r.Text === "missed").length;
  const offDay = rows.length - missed;
  const notes = [
    `Ladder: maintenance texts on days ${TEXT_LADDER.maintenance.join(", ")}; irrigation on days ${TEXT_LADDER.irrigation.join(", ")}. Day one is the due date.`,
    `Only steps scheduled in the last ${LOOKBACK_DAYS} days are judged. A text on the day or the day after counts as on time.`,
    `Jobber's own reminder emails (days ${JOBBER_EMAIL_DAYS.join(" and ")}) can't be confirmed: Jobber's API doesn't expose them.`,
    `GHL emails were found on ${emailCount} of ${evaluated} steps. No GHL reminder email is live yet, so a missing email isn't counted as a failure.`,
  ];
  if (unknownType) notes.push(`${unknownType} customers have no clear service type, so only days 10 and 15 were checked for them.`);
  const summary = `${evaluated} reminder steps were due recently: ${sentCount} texted on time, ${missed} missed, ${offDay} early or late.`;
  if (!ghlConfigured()) return result(key, title, "error", "GHL_API_KEY / GHL_LOCATION_ID aren't set, so texts can't be checked.");
  return result(
    key,
    title,
    missed ? "fail" : offDay ? "warn" : "pass",
    summary,
    ["Customer", "Type", "Due", "Step", "Scheduled", "Text", "Email", "Owed", "Why"],
    rows,
    notes
  );
}

// --- 7. Reach gaps ------------------------------------------------------------

function checkReach(customers: PastDueCustomer[]): CheckResult {
  const key = "reach";
  const title = "Past-due customers can be reached";
  const rows: Row[] = [];
  for (const c of customers) {
    const r = reachProblems(c);
    const all = [...r.other, ...r.text, ...r.email];
    if (!all.length) continue;
    rows.push({
      Customer: c.name,
      Owed: money(c.owed),
      "Days past due": Math.max(...c.invoices.map((i) => i.daysPastDue)),
      Problems: all.join("; "),
    });
  }
  rows.sort((a, b) => Number(b["Days past due"]) - Number(a["Days past due"]));
  if (!ghlConfigured()) return result(key, title, "error", "GHL_API_KEY / GHL_LOCATION_ID aren't set.");
  if (!rows.length) return result(key, title, "pass", `All ${customers.length} past-due customers can be texted and emailed.`);
  return result(key, title, "warn", `${rows.length} of ${customers.length} past-due customers can't get every reminder.`, ["Customer", "Owed", "Days past due", "Problems"], rows);
}

// --- 8. Day-21 calls ----------------------------------------------------------

async function checkCalls(customers: PastDueCustomer[]): Promise<CheckResult> {
  const key = "calls";
  const title = `Day-${CALL_PROMPT_DAY} calls are logged`;
  const due = customers.flatMap((c) =>
    c.invoices.filter((i) => i.daysPastDue >= CALL_PROMPT_DAY).map((i) => ({ c, i }))
  );
  const ids = due.map((d) => d.i.cacheId).filter((x): x is string => !!x);
  const calls = await prisma.lateInvoiceCall.findMany({ where: { invoiceId: { in: ids } } });
  const called = new Set(calls.filter((x) => x.calledAt).map((x) => x.invoiceId));
  const rows: Row[] = due
    .filter((d) => !d.i.cacheId || !called.has(d.i.cacheId))
    .map((d) => ({
      Customer: d.c.name,
      Invoice: d.i.node.invoiceNumber ?? d.i.node.id,
      "Days past due": d.i.daysPastDue,
      Owed: money(balanceOf(d.i.node)),
    }))
    .sort((a, b) => Number(b["Days past due"]) - Number(a["Days past due"]));
  if (!rows.length) return result(key, title, "pass", `All ${due.length} invoices past day ${CALL_PROMPT_DAY} are marked called.`);
  return result(
    key,
    title,
    "warn",
    `${rows.length} invoices past day ${CALL_PROMPT_DAY} aren't marked called on the Collections page.`,
    ["Customer", "Invoice", "Days past due", "Owed"],
    rows
  );
}

// --- Runner -------------------------------------------------------------------

export async function runDailyAudit(opts: { triggeredBy?: string } = {}) {
  const now = new Date();
  const today = azDate(now)!;
  const report = await prisma.dailyAuditReport.create({
    data: { runDate: today, triggeredBy: opts.triggeredBy ?? "cron" },
  });
  log(`[daily-audit] starting ${today} (${report.id})`);

  const checks: CheckResult[] = [];
  const safe = async (key: string, title: string, fn: () => Promise<CheckResult> | CheckResult) => {
    try {
      const r = await fn();
      checks.push(r);
      log(`[daily-audit] ${key}: ${r.status} — ${r.summary}`);
    } catch (err: any) {
      logError(`[daily-audit] ${key} failed:`, err?.message ?? err);
      checks.push(errorResult(key, title, err));
    }
  };

  try {
    await safe("sync", "Jobber sync is running", () => checkSync(now));

    let ctx: InvoiceContext | null = null;
    let ctxError: unknown = null;
    try {
      ctx = await loadInvoices();
    } catch (err) {
      ctxError = err;
    }
    const needCtx = (key: string, title: string, fn: (c: InvoiceContext) => Promise<CheckResult> | CheckResult) =>
      safe(key, title, () => {
        if (!ctx) throw ctxError ?? new Error("Jobber invoices couldn't be read");
        return fn(ctx);
      });

    await needCtx("invoices", "Dashboard invoices match Jobber", (c) => checkInvoiceParity(c));
    await safe("jobs", "Recent jobs match Jobber and are invoiced", () => checkJobs(now));
    await needCtx("totals", "Dashboard overdue and open totals match Jobber", (c) => checkTotals(c));

    let customers: PastDueCustomer[] | null = null;
    let custError: unknown = null;
    if (ctx) {
      try {
        customers = await loadPastDue(ctx, today);
      } catch (err) {
        custError = err;
      }
    }
    const needCust = (key: string, title: string, fn: (c: PastDueCustomer[]) => Promise<CheckResult> | CheckResult) =>
      safe(key, title, () => {
        if (!customers) throw custError ?? ctxError ?? new Error("Past-due customers couldn't be loaded");
        return fn(customers);
      });

    await needCust("pipeline", "GHL Invoice Pipeline matches Jobber", (c) => checkPipeline(c, today));
    await needCust("reminders", "Late-invoice reminders went out on their day", (c) => checkReminders(c, today));
    await needCust("reach", "Past-due customers can be reached", (c) => checkReach(c));
    await needCust("calls", `Day-${CALL_PROMPT_DAY} calls are logged`, (c) => checkCalls(c));

    const failCount = checks.filter((c) => c.status === "fail" || c.status === "error").length;
    const warnCount = checks.filter((c) => c.status === "warn").length;
    const saved = await prisma.dailyAuditReport.update({
      where: { id: report.id },
      data: {
        status: "complete",
        completedAt: new Date(),
        failCount,
        warnCount,
        checks: checks as any,
      },
    });
    log(`[daily-audit] done: ${failCount} failing, ${warnCount} warnings`);
    return saved;
  } catch (err: any) {
    await prisma.dailyAuditReport.update({
      where: { id: report.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: err?.message ?? String(err),
        checks: checks as any,
      },
    });
    throw err;
  }
}

// Exposed for local tests with synthetic data.
export const _pureChecks = { checkInvoiceParity, checkTotals, checkReminders, checkReach };
