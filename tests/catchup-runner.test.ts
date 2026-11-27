import test from "node:test";
import assert from "node:assert/strict";
import { catchupRunnerReadiness, runCatchup, type CatchupRunnerDependencies } from "../lib/catchup-runner";
import { type CatchupRecipientInput } from "../lib/catchup-plan";
import { CATCHUP_PAY_LINK_HOST } from "../lib/catchup-copy";
import { parseGhlRecipient } from "../lib/notification-ghl-contract";

const ACCOUNT = "acct-1";
const LOCATION = "loc-1";
const CONTACT = "contact-abc123";
const PHONE = "+16025550100";
const EMAIL = "jessica@example.test";
const SEND_ON = "2026-11-24";
const LINK = `https://${CATCHUP_PAY_LINK_HOST}/client_hubs/abc123/invoices/def456`;
const VER = "2021-07-28";
/**
 * The provider's own shape, per channel. NOT interchangeable: the contract
 * accepts 201 for a text and only 200 for an email, and an email acceptance
 * carries its own individual id. A single fixture for both channels silently
 * fails the email half, which is exactly the half a person would not notice.
 */
const accepted = (descriptor: { serializedBody?: string } | undefined) => {
  const isEmail = /"type"\s*:\s*"Email"/i.test(descriptor?.serializedBody ?? "");
  return {
    version: VER,
    statusCode: isEmail ? 200 : 201,
    body: {
      messageId: "m-1", conversationId: "c-1",
      ...(isEmail ? { emailMessageId: "individual-1" } : {}),
    },
  };
};

const invoice = (over: Record<string, unknown> = {}) => ({
  invoiceId: "inv-7272", invoiceNumber: "7272", balanceMinor: 9000,
  dueOn: "2026-11-17", payLink: LINK, ...over,
});
const recipient = (over: Partial<CatchupRecipientInput> = {}): CatchupRecipientInput => ({
  accountId: ACCOUNT, jobberClientId: "client-1", clientName: "Jessica Noonan",
  contactId: CONTACT, exactContactMatches: 1, phone: PHONE, email: EMAIL,
  smsOptedOut: false, emailOptedOut: false, invoices: [invoice()], ...over,
});

const senderReview = (channel: "sms" | "email") => ({
  accountId: ACCOUNT, locationId: LOCATION, channel,
  sender: channel === "sms" ? "+16028548131" : "preston@flexxlandscaping.com",
  scope: "conversations/message.write" as const, approved: true as const, validated: true as const,
  evidenceRef: "sender-approved-ref",
});
const review = (channel: "sms" | "email") => ({
  mode: "reviewed-construction-only" as const, version: VER, evidenceRef: "construction-review-ref",
  accountId: ACCOUNT, locationId: LOCATION, channel, proposedStatus: "pending" as const,
});
const suffixPolicy = {
  mode: "reviewed-exact-native-sms-suffix" as const, version: VER, channel: "sms" as const,
  source: "app" as const, accountId: ACCOUNT, locationId: LOCATION, sender: "+16028548131",
  evidenceRef: "suffix-reviewed-ref", suffix: " Reply STOP to opt out.",
};
const senders = {
  accountId: ACCOUNT, locationId: LOCATION,
  sms: { senderReview: senderReview("sms"), review: review("sms"), smsReceiptSuffixPolicy: suffixPolicy },
  email: { senderReview: senderReview("email"), review: review("email") },
} as never;

function ledger() {
  const reserved: { invoiceId: string; channel: string; dayPastDue: number }[] = [];
  return {
    reserved,
    api: {
      async reserve(input: any) {
        reserved.push({ invoiceId: input.event.invoiceId, channel: input.channel,
          dayPastDue: input.event.dayPastDue });
        return { state: "reserved" as const, reservation: { id: `r${reserved.length}`, token: "t",
          eventHash: "e", bodyHash: "b", destinationHash: "d" } };
      },
      async assertReserved() { return true; },
      async markPending() { return true; },
      async markOutcome() { return true; },
    },
  };
}

type DueOverride = { stillOpen: boolean; balanceMinor: number; totalMinor?: number | null;
  dayPastDue: number; invoiceStatus?: string | null };

const deps = (over: Partial<CatchupRunnerDependencies>
  & { attempts?: unknown[]; due?: DueOverride } = {}): CatchupRunnerDependencies => {
  const led = ledger();
  // The live look must AGREE with the plan, because the dispatcher refuses when
  // it does not - that is the point of looking again. So a test whose invoice is
  // not $90.00 at day 7 has to say so here.
  const due: DueOverride = over.due ?? { stillOpen: true, balanceMinor: 9000, dayPastDue: 7 };
  // Unless a case says otherwise, the source still calls the invoice past due,
  // and the total is at least the balance so the invoice genuinely owes money.
  const confirmation = { invoiceStatus: "past_due", totalMinor: due.balanceMinor || 9000, ...due };
  return {
    io: {
      ledger: led.api as never,
      confirmStillDue: async () => confirmation,
      attemptSend: async (descriptor: { serializedBody?: string }) => {
        (over.attempts ?? []).push(descriptor);
        return accepted(descriptor) as never;
      },
    },
    readRecipient: async (contactId: string, channel: "sms" | "email") => parseGhlRecipient({
      version: VER,
      body: { contact: { id: contactId, locationId: LOCATION, phone: PHONE, email: EMAIL, dndSettings: {} } },
      expected: { accountId: ACCOUNT, locationId: LOCATION, contactId, channel,
        destination: channel === "sms" ? PHONE : EMAIL },
    }),
    senders,
    ...over,
  } as CatchupRunnerDependencies;
};

test("readiness names what is still missing, and claims no send capability", () => {
  const ready = catchupRunnerReadiness();
  assert.equal(ready.state, "plan-only");
  assert.equal(ready.productionSendCapability, false);
  assert.ok(ready.missing.includes("verified_email_sending_domain"));
  assert.ok(ready.missing.some(m => m.includes("reviewed_email_sender")));
});

test("PLAN IS THE DEFAULT AND TOUCHES NOTHING", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({ recipients: [recipient()], sendDate: SEND_ON });
  assert.equal(report.state, "planned");
  assert.equal(attempts.length, 0);
  assert.equal(report.summary.customers, 1);
  assert.equal(report.summary.texts, 1);
  assert.equal(report.summary.emails, 1);
  assert.equal(report.summary.sent, 0);
  assert.ok(report.reasons.includes("plan_mode"));
});

test("plan mode still produces the full plan, so a report can be read", async () => {
  const report = await runCatchup({ recipients: [recipient()], sendDate: SEND_ON });
  const send = report.plan.actions.find(a => a.state === "send");
  assert.ok(send);
  if (send?.state !== "send") return;
  assert.match(send.body, /invoice #7272 for \$90\.00 is 7 days past due/);
});

test("--SEND WITHOUT REVIEWED SENDERS HOLDS, IT DOES NOT SEND", async () => {
  // The whole point: asking to send is necessary, never sufficient.
  const noDeps = await runCatchup({ recipients: [recipient()], sendDate: SEND_ON, mode: "send" });
  assert.equal(noDeps.state, "held");
  assert.ok(noDeps.reasons.includes("trusted_dependencies_required"), noDeps.reasons.join(","));

  const noSenders = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ senders: undefined as never }),
  });
  assert.equal(noSenders.state, "held");
  assert.ok(noSenders.reasons.includes("reviewed_senders_required"), noSenders.reasons.join(","));
});

test("a held run still returns the plan, never a silent downgrade", async () => {
  const report = await runCatchup({ recipients: [recipient()], sendDate: SEND_ON, mode: "send" });
  assert.equal(report.state, "held");
  assert.equal(report.plan.summary.send, 1, "the plan is still there to read");
  assert.equal(report.summary.notAttempted, 1);
  assert.equal(report.summary.sent, 0);
});

test("an incomplete consent reader holds the run", async () => {
  const report = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ readRecipient: undefined as never }),
  });
  assert.equal(report.state, "held");
  assert.ok(report.reasons.includes("consent_reader_required"), report.reasons.join(","));
});

test("with everything injected, a clean recipient sends on both channels", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ attempts }),
  });
  assert.equal(report.state, "sent");
  assert.equal(attempts.length, 2, "one text and one email");
  assert.equal(report.summary.sent, 1);
  assert.equal(report.results[0].outcome.state, "sent");
});

test("THE SAME CONTACT TWICE IN ONE BATCH IS MESSAGED ONCE", async () => {
  // Two Jobber client records resolving to one GHL contact has already happened
  // on this board (both Sodalicious locations). The ledger would not stop it:
  // different invoices mean different keys.
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [
      recipient({ jobberClientId: "client-1", invoices: [invoice()] }),
      recipient({ jobberClientId: "client-2",
        invoices: [invoice({ invoiceId: "inv-9999", invoiceNumber: "9999", dueOn: "2026-11-18" })] }),
    ],
    sendDate: SEND_ON, mode: "send", dependencies: deps({ attempts }),
  });
  assert.equal(report.state, "sent");
  assert.equal(attempts.length, 2, "two messages in all, not four");
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].outcome.state, "sent");
  assert.equal(report.results[1].outcome.state, "not_attempted",
    "the second appearance of the contact must be refused");
});

test("a consent read that throws refuses that channel without sending", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ attempts, readRecipient: async () => { throw new Error("ghl down"); } }),
  });
  assert.equal(attempts.length, 0);
  assert.equal(report.results[0].outcome.state, "refused");
  if (report.results[0].outcome.state !== "refused") return;
  assert.ok(report.results[0].outcome.reasons.includes("consent_read_failed"));
});

test("a held customer never reaches the dispatcher", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient({ exactContactMatches: 2 })],
    sendDate: SEND_ON, mode: "send", dependencies: deps({ attempts }),
  });
  assert.equal(attempts.length, 0);
  assert.equal(report.plan.summary.hold, 1);
  assert.equal(report.results.length, 0, "a hold is not a result row");
});

test("an email-only exception sends one message, not a half pair", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient({
      clientName: "Joshua Heyrend", phone: null,
      invoices: [invoice({ invoiceNumber: "7259", balanceMinor: 6600, dueOn: "2026-11-14" })],
    })],
    sendDate: SEND_ON, mode: "send",
    dependencies: deps({ attempts, due: { stillOpen: true, balanceMinor: 6600, dayPastDue: 10 } }),
  });
  assert.equal(report.state, "sent");
  assert.equal(attempts.length, 1, "email only");
  assert.equal(report.summary.texts, 0);
  assert.equal(report.summary.emails, 1);
});

test("a live look that disagrees with the plan refuses, it does not send the stale figure", async () => {
  // Found by a fixture of mine being wrong, which is the best argument for it:
  // the plan said $90.00 at day 7, the live look said $66.00, and the dispatcher
  // refused rather than text a customer a number that had moved.
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ attempts, due: { stillOpen: true, balanceMinor: 6600, dayPastDue: 7 } }),
  });
  assert.equal(attempts.length, 0, "nothing reached the provider");
  assert.equal(report.summary.sent, 0);
  assert.equal(report.results[0].outcome.state, "refused");
  if (report.results[0].outcome.state !== "refused") return;
  assert.ok(report.results[0].outcome.reasons.includes("balance_changed_since_planning"),
    report.results[0].outcome.reasons.join(","));
});

test("an invoice paid between the plan and the send is not messaged about", async () => {
  const attempts: unknown[] = [];
  const report = await runCatchup({
    recipients: [recipient()], sendDate: SEND_ON, mode: "send",
    dependencies: deps({ attempts, due: { stillOpen: false, balanceMinor: 0, dayPastDue: 7 } }),
  });
  assert.equal(attempts.length, 0);
  assert.equal(report.results[0].outcome.state, "refused");
});
