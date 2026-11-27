/**
 * THE CATCH-UP, AGAINST LIVE DATA. Plans by default. Sends nothing on its own.
 *
 *   npx tsx scripts/catchup-run.ts                         plan and print
 *   npx tsx scripts/catchup-run.ts --prepare out.json      write the manifest
 *   npx tsx scripts/catchup-run.ts --send \
 *       --manifest out.json --approve <manifestSha256>     send the approved set
 *
 * THREE PHASES, BECAUSE AN APPROVAL HAS TO BE READABLE BEFORE IT IS GIVEN.
 *
 *   plan      what would go out, in counts and hold reasons. Touches nothing.
 *   prepare   constructs every message and writes a manifest: the exact words,
 *             the amount, the day, the last four of each destination, and the
 *             SHA-256 of the byte-exact request that would be posted. Sends
 *             nothing. Reads consent live, because a manifest built from a
 *             stale opt-out is worthless.
 *   send      takes that manifest back plus its hash, named explicitly on the
 *             command line. The hash IS the approval: it says "this exact set,
 *             these words, these people". Only messages whose request hash is
 *             in the approved manifest can be posted, each once.
 *
 * `--send` alone is still not enough and never will be. Without a manifest and
 * a matching hash the run holds, because there is nothing authorizing it.
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
import { catchupRunnerReadiness, planCatchupRun, runCatchup } from "../lib/catchup-runner";
import { CATCHUP_EMAIL_SENDER, CATCHUP_SMS_SENDER } from "../lib/catchup-sender-policy";
import type { CatchupRecipientInput } from "../lib/catchup-plan";
import { readFileSync, writeFileSync } from "node:fs";
import { constructCatchupRequest } from "../lib/catchup-dispatch";
import { isOwing } from "../lib/invoice-settlement";
import { assembleCatchupSenders, catchupPreparationSenders } from "../lib/catchup-senders";
import {
  approveCatchupManifest, buildCatchupManifest, catchupRequestSha256, parseCatchupManifest,
  type CatchupAttestation,
} from "../lib/catchup-attestation";
import { catchupTransportReadiness, createCatchupTransport, CATCHUP_TRANSPORT_MODE } from "../lib/catchup-transport";
import { createPrismaNotificationLedger } from "../lib/notification-ledger";
import { GHL_NOTIFICATION_CONTRACT, parseGhlRecipient } from "../lib/notification-ghl-contract";

const TAG = "[catchup]";
const WANTS_SEND = process.argv.includes("--send");
const argOf = (flag: string): string | null => {
  const at = process.argv.indexOf(flag);
  return at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--") ? process.argv[at + 1] : null;
};
const PREPARE_TO = argOf("--prepare");
const MANIFEST_FROM = argOf("--manifest");
const APPROVE_SHA = argOf("--approve");
const ACCOUNT_ID = "flexx";
const last4 = (value: string) => value.replace(/[^A-Za-z0-9]/g, "").slice(-4);

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

  const locationId = process.env.GHL_LOCATION_ID?.trim();
  const credential = process.env.GHL_API_KEY?.trim();
  const scope = { accountId: ACCOUNT_ID, locationId: locationId ?? "" };

  /** Consent, read LIVE per contact and channel. Never cached across phases. */
  const readRecipient = async (contactId: string, channel: "sms" | "email") => {
    const response = await fetch(`${GHL_NOTIFICATION_CONTRACT.baseUrl}/contacts/${encodeURIComponent(contactId)}`, {
      headers: {
        Authorization: `Bearer ${credential}`, Version: GHL_NOTIFICATION_CONTRACT.version,
        Accept: "application/json",
      },
      redirect: "error",
    });
    const body = await response.json() as { contact?: { phone?: string; email?: string } };
    const destination = channel === "sms" ? body?.contact?.phone : body?.contact?.email;
    return parseGhlRecipient({
      version: GHL_NOTIFICATION_CONTRACT.version, body,
      expected: {
        accountId: ACCOUNT_ID, locationId: locationId as string, contactId, channel,
        destination: destination ?? "",
      },
    });
  };

  const senderContext = (
    senders: ReturnType<typeof catchupPreparationSenders>,
    channel: "sms" | "email",
    recipient: Awaited<ReturnType<typeof readRecipient>>,
  ) => ({
    accountId: ACCOUNT_ID, locationId,
    senderReview: channel === "sms" ? senders.sms.senderReview : senders.email.senderReview,
    review: channel === "sms" ? senders.sms.review : senders.email.review,
    recipient, scheduledOn: sendDate,
    ...(channel === "sms" ? { smsReceiptSuffixPolicy: senders.sms.smsReceiptSuffixPolicy } : {}),
  });

  // ============================ PREPARE ============================
  if (PREPARE_TO) {
    if (!locationId || !credential) throw new Error("GHL_LOCATION_ID and GHL_API_KEY are required to read consent");
    const plan = planCatchupRun(recipients, sendDate);
    const prep = catchupPreparationSenders(scope);
    const entries: CatchupAttestation[] = [];
    const skipped: string[] = [];

    for (const action of plan.actions) {
      if (action.state !== "send") continue;
      for (const send of action.sends) {
        const channel = send.channel as "sms" | "email";
        let recipient: Awaited<ReturnType<typeof readRecipient>>;
        try { recipient = await readRecipient(action.contactId, channel); }
        catch { skipped.push(`${action.clientName} ${channel}: consent read failed`); continue; }
        const constructed = constructCatchupRequest(action, send, senderContext(prep, channel, recipient) as never);
        if (!constructed.request) {
          skipped.push(`${action.clientName} ${channel}: ${constructed.reasons.join("; ")}`);
          continue;
        }
        entries.push({
          requestSha256: catchupRequestSha256(constructed.request.serializedBody),
          channel, clientName: action.clientName,
          invoiceNumbers: action.covers,
          balanceMinorTotal: send.reservations.reduce((total, row) => total + row.balanceMinor, 0),
          daysPastDue: send.reservations.map(row => row.dayPastDue),
          destinationLast4: last4(send.destination),
          subject: channel === "email" ? action.subject : null,
          body: action.body,
        });
      }
    }

    const manifest = buildCatchupManifest({
      preparedAt: new Date().toISOString(), sendDate,
      accountId: ACCOUNT_ID, locationId,
      smsSender: CATCHUP_SMS_SENDER.number, emailSender: CATCHUP_EMAIL_SENDER.address,
      entries,
    });
    writeFileSync(PREPARE_TO, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const totalMinor = entries.reduce((total, row) => total + row.balanceMinorTotal, 0);
    console.log(`\n${TAG} ===== manifest written =====`);
    console.log(`${TAG} file     = ${PREPARE_TO}`);
    console.log(`${TAG} messages = ${manifest.entries.length}`);
    console.log(`${TAG} total    = $${(totalMinor / 100).toFixed(2)}`
      + ` across ${new Set(entries.flatMap(row => row.invoiceNumbers)).size} invoices`);
    console.log(`${TAG} texts    = ${entries.filter(row => row.channel === "sms").length}`);
    console.log(`${TAG} emails   = ${entries.filter(row => row.channel === "email").length}`);
    for (const line of skipped) console.log(`${TAG} SKIP  ${line}`);
    console.log(`\n${TAG} READ THE FILE, THEN APPROVE IT BY NAMING THIS HASH:`);
    console.log(`${TAG}   ${manifest.manifestSha256}`);
    console.log(`${TAG} nothing has been sent.`);
    return;
  }

  // ============================ SEND ============================
  if (WANTS_SEND) {
    if (!MANIFEST_FROM || !APPROVE_SHA) {
      console.log(`${TAG} HELD: --send needs --manifest <file> and --approve <manifestSha256>.`);
      console.log(`${TAG} Run --prepare first, read the file, then approve its hash. Nothing sent.`);
      return;
    }
    if (!locationId || !credential) throw new Error("GHL_LOCATION_ID and GHL_API_KEY are required to send");

    const manifest = parseCatchupManifest(JSON.parse(readFileSync(MANIFEST_FROM, "utf8")));
    const approval = approveCatchupManifest(manifest, APPROVE_SHA);
    if (approval.state !== "approved" || !approval.approval) {
      console.log(`${TAG} HELD: ${approval.reasons.join(", ")}. Nothing sent.`);
      return;
    }
    const assembled = assembleCatchupSenders(approval.approval, scope);
    if (assembled.state !== "assembled" || !assembled.senders) {
      console.log(`${TAG} HELD: ${assembled.reasons.join(", ")}. Nothing sent.`);
      return;
    }
    if (!assembled.emailSendingDomainVerified) {
      console.log(`${TAG} NOTE: ${CATCHUP_EMAIL_SENDER.address} has no API-provable verified`);
      console.log(`${TAG}       sending domain. Emails may bounce or land in spam. Texts unaffected.`);
    }

    const transportOptions = {
      mode: CATCHUP_TRANSPORT_MODE, fetch: fetch as never, credential,
      accountId: ACCOUNT_ID, locationId, scopes: [GHL_NOTIFICATION_CONTRACT.writeScope],
      approval: approval.approval, now: () => new Date(),
    };
    const ready = catchupTransportReadiness(transportOptions);
    if (!ready.ready) {
      console.log(`${TAG} HELD: transport not ready - ${ready.missing.join(", ")}. Nothing sent.`);
      return;
    }
    const transport = createCatchupTransport(transportOptions);

    // ONCE PER CONTACT, FOR GOOD. The catch-up is a one-off sweep, not a
    // recurring sender, and after it has reached somebody they belong to the
    // normal ladder from then on.
    //
    // The ledger's own unique indexes do not settle this on their own. The
    // per-day index is keyed on the send date, so a second run on a LATER day
    // does not collide with it, and the per-milestone index is keyed on
    // dayPastDue, which has moved on by then too. So a re-run days later could
    // legitimately take fresh rows and message the same people a second time.
    // This closes that: any contact with ANY catch-up row already in the
    // ledger - whatever its day, milestone, channel or outcome - is dropped
    // here, before a plan is made or a row is taken.
    //
    // `state` is deliberately not filtered. A row left `reserved`, `pending` or
    // `unknown` means a message may well have gone out and the outcome was
    // never confirmed, and "we are not sure" must not read as "safe to send
    // again".
    const { prisma: guardDb } = await import("../lib/prisma");
    const alreadyReached = new Set<string>(
      (await guardDb.notificationLedger.findMany({
        where: { accountId: ACCOUNT_ID }, select: { contactId: true }, distinct: ["contactId"],
      })).map(row => row.contactId));
    const repeats = recipients.filter(r => r.contactId && alreadyReached.has(r.contactId));
    if (repeats.length) {
      console.log(`${TAG} ${repeats.length} contact(s) already reached by an earlier catch-up:`);
      for (const r of repeats) console.log(`${TAG}   skipping ${r.clientName} - on the normal ladder now`);
    }
    const firstTime = recipients.filter(r => !r.contactId || !alreadyReached.has(r.contactId));
    if (!firstTime.length) {
      console.log(`${TAG} every planned recipient has already had a catch-up. NOTHING SENT.`);
      return;
    }

    // PRE-FLIGHT, BEFORE ANY LEDGER ROW IS TAKEN. The ledger has no release, so
    // a row reserved for a message the transport would then refuse is stuck for
    // good. Every planned message must already be covered, or nothing runs.
    const plan = planCatchupRun(firstTime, sendDate);
    const uncovered: string[] = [];
    for (const action of plan.actions) {
      if (action.state !== "send") continue;
      for (const send of action.sends) {
        const channel = send.channel as "sms" | "email";
        const recipient = await readRecipient(action.contactId, channel);
        const constructed = constructCatchupRequest(
          action, send, senderContext(assembled.senders, channel, recipient) as never);
        if (!constructed.request || !transport.covers(constructed.request)) {
          uncovered.push(`${action.clientName} ${channel}`
            + (constructed.request ? " (not in the approved manifest)" : ` (${constructed.reasons.join("; ")})`));
        }
      }
    }
    if (uncovered.length) {
      console.log(`${TAG} HELD: ${uncovered.length} planned message(s) are not covered by the approval:`);
      for (const line of uncovered) console.log(`${TAG}   ${line}`);
      console.log(`${TAG} The data moved since the manifest was prepared. Re-run --prepare,`);
      console.log(`${TAG} read the new file and approve the new hash. NOTHING WAS SENT.`);
      return;
    }

    const { prisma: db } = await import("../lib/prisma");
    const sent = await runCatchup({
      recipients: firstTime, sendDate, mode: "send",
      dependencies: {
        io: {
          ledger: createPrismaNotificationLedger(db as never),
          confirmStillDue: async (invoiceId: string) => {
            // The total is fetched alongside the balance because owing is
            // decided from the two together, not from the status.
            const data = await jobberQuery<{ invoice?: { invoiceStatus?: string;
              amounts?: { total?: number; invoiceBalance?: number }; dueDate?: string } }>(
              "query($id:EncodedId!){ invoice(id:$id){ invoiceStatus dueDate amounts { total invoiceBalance } } }",
              { id: invoiceId });
            const invoice = data?.invoice;
            const minor = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : null;
            const balanceMinor = minor(invoice?.amounts?.invoiceBalance);
            const totalMinor = minor(invoice?.amounts?.total);
            const dueOn = invoice?.dueDate ? invoiceCalendarDate(new Date(invoice.dueDate)) : null;
            // A positive balance on its own does not mean an invoice is
            // chaseable - `void`, `draft` and `bad_debt` invoices carry one too,
            // and those are excluded by status. But `paid` no longer excludes
            // it: Jobber leaves that label on refunded and deposit-only
            // invoices that genuinely still owe money, and treating the label as
            // the answer is what hid them. lib/invoice-settlement.ts holds the
            // single definition, shared with the dispatcher's own re-check.
            const invoiceStatus = typeof invoice?.invoiceStatus === "string" ? invoice.invoiceStatus : null;
            return {
              stillOpen: Boolean(invoice) && isOwing(invoiceStatus, totalMinor, balanceMinor),
              balanceMinor,
              totalMinor,
              dayPastDue: dueOn ? dayNumber(sendDate) - dayNumber(dueOn) : null,
              invoiceStatus,
            };
          },
          attemptSend: transport.attemptSend,
        },
        readRecipient,
        senders: assembled.senders,
      },
    });

    console.log(`\n${TAG} ===== outcome =====`);
    console.log(`${TAG} state = ${sent.state}`
      + (sent.reasons.length ? `  reasons = ${sent.reasons.join(", ")}` : ""));
    console.log(`${TAG} ${JSON.stringify(sent.summary)}`);
    for (const row of sent.results) {
      console.log(`${TAG} ${String(row.clientName).padEnd(24)} #${row.invoiceNumbers.join(",#").padEnd(14)}`
        + ` ${row.outcome.state}`
        + ("reasons" in row.outcome && row.outcome.reasons.length ? `  [${row.outcome.reasons.join("; ")}]` : ""));
    }
    console.log(`${TAG} attempted = ${transport.attempted.length}`);
    for (const row of transport.refused) console.log(`${TAG} REFUSED ${row.reason}`);
    return;
  }

  // ============================ PLAN ============================
  const report = await runCatchup({ recipients, sendDate, mode: "plan" });

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
