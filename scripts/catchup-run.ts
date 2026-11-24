/**
 * THE CATCH-UP, AGAINST LIVE DATA. Plans by default. Sends nothing on its own.
 *
 *   npx tsx scripts/catchup-run.ts            plan and print the report
 *   npx tsx scripts/catchup-run.ts --send     attempt the send
 *
 * `--send` is necessary and NOT sufficient. The run still holds unless reviewed
 * senders are injected, and nothing in this repo can produce those from the
 * environment - see the note in `lib/catchup-runner.ts`. So on a normal
 * deployment `--send` prints a held run naming `reviewed_senders_required`,
 * which is the correct outcome rather than a bug.
 *
 * WHAT IT READS, AND WHY EACH READ IS LIVE.
 *   Jobber invoices    the local mirror, for the candidate set
 *   Jobber pay links   LIVE per invoice: `clientHubUri` is the customer's own
 *                      link and is never cached here
 *   GHL contacts       LIVE exact match, because a duplicate appearing since
 *                      the last sync must hold the customer, not reach a guess
 *   Jobber balances    LIVE again at send time, inside the dispatcher
 *
 * IT NEVER REFRESHES THE JOBBER TOKEN. It reads the stored access token and
 * stops if that token is close to expiry, because `getValidAccessToken()`
 * WRITES a refreshed token to the database and a reporting script has no
 * business doing that. The hourly sync owns the refresh.
 */
import { prisma } from "../lib/prisma";
import { findExactContactMatches } from "../lib/ghl";
import { COLLECTIONS_SINCE } from "../lib/lateInvoices";
import { invoiceCalendarDate } from "../lib/invoice-reminder-clock";
import { catchupRunnerReadiness, runCatchup } from "../lib/catchup-runner";
import { CATCHUP_EMAIL_SENDER, CATCHUP_SMS_SENDER } from "../lib/catchup-sender-policy";
import type { CatchupRecipientInput } from "../lib/catchup-plan";

const TAG = "[catchup]";
const WANTS_SEND = process.argv.includes("--send");

/** Excluded by the owner, by name. Written here so the list is auditable. */
const EXCLUDED_NAMES = ["Paula Rose", "Sherrie Woods"] as const;
/** Excluded by invoice: Jobber reports paid AND a balance, so it is unusable. */
const EXCLUDED_INVOICES = ["6830"] as const;

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

async function main(): Promise<void> {
  const now = new Date();
  const sendDate = invoiceCalendarDate(now);
  if (!sendDate) throw new Error("could not resolve the Phoenix calendar date");

  console.log(`${TAG} send date (Phoenix) = ${sendDate}`);
  console.log(`${TAG} readiness = ${JSON.stringify(catchupRunnerReadiness())}`);
  console.log(`${TAG} sms sender   = ${CATCHUP_SMS_SENDER.number}`);
  console.log(`${TAG} email sender = ${CATCHUP_EMAIL_SENDER.address} `
    + `(sending domain verified: ${CATCHUP_EMAIL_SENDER.sendingDomainVerified})`);

  const auth = await prisma.jobberAuth.findFirst({ orderBy: { createdAt: "desc" } });
  if (!auth) throw new Error("no Jobber authentication on record");
  const headroomMinutes = Math.round((auth.expiresAt.getTime() - now.getTime()) / 60_000);
  console.log(`${TAG} jobber token headroom = ${headroomMinutes} min`);
  if (headroomMinutes < 2) {
    // Deliberately a refusal, not a refresh. See the header note.
    console.log(`${TAG} HELD: the Jobber token is at or past expiry. The hourly sync refreshes `
      + `it; re-run after that. This script will not refresh it, because refreshing WRITES.`);
    return;
  }

  const jobberQuery = async <T>(query: string, variables: Record<string, unknown>): Promise<T | null> => {
    try {
      const response = await fetch("https://api.getjobber.com/api/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "X-JOBBER-GRAPHQL-VERSION": "2025-04-16",
        },
        body: JSON.stringify({ query, variables }),
      });
      const parsed = await response.json() as { data?: T; errors?: unknown };
      if (parsed.errors) return null;
      return parsed.data ?? null;
    } catch {
      return null;
    }
  };

  const invoices = await prisma.invoiceRecord.findMany({
    where: { amountDue: { gt: 0 }, issuedAt: { gte: COLLECTIONS_SINCE } },
    select: {
      jobberInvoiceId: true, invoiceNumber: true, clientName: true, amountDue: true, dueAt: true,
      customer: { select: { jobberClientId: true, email: true, phone: true } },
    },
  });

  const pastDue = invoices
    .map(row => ({ ...row, dueOn: invoiceCalendarDate(row.dueAt) }))
    .filter(row => row.dueOn !== null && dayNumber(sendDate) - dayNumber(row.dueOn) >= 1);

  const byCustomer = new Map<string, typeof pastDue>();
  for (const row of pastDue) {
    const key = row.customer?.jobberClientId ?? `name:${row.clientName}`;
    byCustomer.set(key, [...(byCustomer.get(key) ?? []), row]);
  }

  const recipients: CatchupRecipientInput[] = [];
  const dropped: string[] = [];

  for (const [, rows] of byCustomer) {
    const clientName = (rows[0].clientName ?? "").replace(/\s+/g, " ").trim();
    if (EXCLUDED_NAMES.some(name => clientName.toLowerCase().includes(name.toLowerCase()))) {
      dropped.push(`${clientName}: excluded by name`);
      continue;
    }
    const kept = rows.filter(row => !EXCLUDED_INVOICES.includes(String(row.invoiceNumber) as never));
    if (kept.length === 0) { dropped.push(`${clientName}: every invoice excluded`); continue; }

    const customer = rows[0].customer;
    // Live, so a duplicate created since the last sync holds this customer.
    const contacts = await findExactContactMatches({
      email: customer?.email ?? null, phone: customer?.phone ?? null,
    }).catch(() => null);
    const only = contacts && contacts.length === 1 ? contacts[0] as unknown as Record<string, unknown> : null;
    const dnd = only?.dnd === true;
    const dndSettings = (only?.dndSettings ?? {}) as Record<string, { status?: string } | undefined>;
    const held = (channel: "SMS" | "Email") => {
      const status = dndSettings?.[channel]?.status;
      // A BLANK setting is permission; only an explicit hold blocks.
      return dnd || Boolean(status && status !== "inactive");
    };

    const payLinks = new Map<string, string | null>();
    for (const row of kept) {
      const data = await jobberQuery<{ invoice?: { clientHubUri?: string | null } }>(
        "query($id:EncodedId!){ invoice(id:$id){ clientHubUri } }",
        { id: row.jobberInvoiceId });
      payLinks.set(row.jobberInvoiceId, data?.invoice?.clientHubUri ?? null);
    }

    recipients.push({
      accountId: "flexx",
      jobberClientId: customer?.jobberClientId ?? `name:${clientName}`,
      clientName,
      contactId: (only?.id as string | undefined) ?? null,
      exactContactMatches: contacts ? contacts.length : -1,
      phone: (only?.phone as string | undefined) ?? null,
      email: (only?.email as string | undefined) ?? null,
      smsOptedOut: held("SMS"),
      emailOptedOut: held("Email"),
      invoices: kept.map(row => ({
        invoiceId: row.jobberInvoiceId,
        invoiceNumber: String(row.invoiceNumber),
        balanceMinor: Math.round(Number(row.amountDue) * 100),
        dueOn: row.dueOn as string,
        payLink: payLinks.get(row.jobberInvoiceId) ?? null,
      })),
    });
  }

  // No dependencies are supplied, so `--send` holds rather than sends. Wiring a
  // real one means handing `runCatchup` reviewed senders, a consent reader and
  // a dispatch IO - deliberately a deployment's job, not this script's.
  const report = await runCatchup({
    recipients, sendDate, mode: WANTS_SEND ? "send" : "plan",
  });

  console.log(`\n${TAG} ===== plan =====`);
  console.log(`${TAG} ${JSON.stringify(report.summary)}`);
  for (const action of report.plan.actions) {
    if (action.state !== "send") continue;
    const channels = action.sends.map(send => send.channel).join("+");
    const rows = action.sends.reduce((total, send) => total + send.reservations.length, 0);
    console.log(`${TAG} SEND  ${String(action.clientName).padEnd(24)} #${action.covers.join(",#").padEnd(14)}`
      + ` ${channels.padEnd(9)} ledger rows=${rows}`
      + (action.emailOnly ? `  EMAIL ONLY [${action.emailOnlyReasons?.join(", ")}]` : ""));
  }
  for (const action of report.plan.actions) {
    if (action.state !== "hold") continue;
    console.log(`${TAG} HOLD  ${String(action.clientName).padEnd(24)}`
      + ` #${action.invoiceNumbers.join(",#").padEnd(14)} ${action.reasons.join("; ")}`);
  }
  for (const line of dropped) console.log(`${TAG} DROP  ${line}`);

  console.log(`\n${TAG} ===== outcome =====`);
  console.log(`${TAG} state = ${report.state}`
    + (report.reasons.length ? `  reasons = ${report.reasons.join(", ")}` : ""));
  for (const row of report.results) {
    if (row.outcome.state === "not_attempted" && report.state !== "sent") continue;
    console.log(`${TAG} ${String(row.clientName).padEnd(24)} #${row.invoiceNumbers.join(",#").padEnd(14)}`
      + ` ${row.outcome.state}`
      + ("reasons" in row.outcome && row.outcome.reasons.length ? `  [${row.outcome.reasons.join("; ")}]` : ""));
  }
  if (report.state !== "sent") {
    console.log(`${TAG} NOTHING WAS SENT.`);
  }
}

main()
  .catch(error => { console.error(`${TAG} failed: ${String(error?.message ?? error)}`); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
