/**
 * WHO GETS THE ONE-TIME CATCH-UP, and what each of them is sent.
 *
 * Pure. Decides; never acts. `catchup-dispatch.ts` is the half that acts.
 *
 * ONE MESSAGE PER CUSTOMER, NOT PER INVOICE. A customer with two past-due
 * invoices gets one text and one email naming both, because two texts in the
 * same minute reads as a malfunction. That is why this planner groups before it
 * decides anything.
 *
 * BUT THE LEDGER IS PER INVOICE. So one message yields ONE RESERVATION PER
 * INVOICE PER CHANNEL - two invoices on two channels is four rows, all carrying
 * the same body. Each invoice's own history then shows it was chased, which is
 * what the next audit reads. The dispatcher must take every one of those
 * reservations BEFORE it sends anything; see the note on partial reservation
 * there.
 *
 * EVERY DAY COUNT IS THE REAL ONE. The ledger refuses a row whose day number
 * is not the true calendar gap between that invoice's due date and the send
 * date, so there is no way to file this message under a ladder rung it did not
 * go out on. Each invoice is therefore recorded at its own actual day count,
 * and the two invoices in one message routinely differ.
 *
 * WHAT IT WILL NOT DO. It refuses a recipient rather than guessing: no exact
 * contact, more than one exact contact, an opted-out channel, a missing
 * destination, an unrenderable body. A refusal names its reasons and sends
 * nothing on either channel - never a text with no email, because half a pair
 * is not what was approved.
 */
import { catchupBody, type CatchupInvoice } from "./catchup-copy";
import { catchupEmailOnlyReasons, catchupIsEmailOnly } from "./catchup-sender-policy";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import { eventKey } from "./notification-gate";

/** Both channels, in a fixed order. A rung that cannot do both does neither. */
export const CATCHUP_CHANNELS = Object.freeze(["sms", "email"] as const);
export type CatchupChannel = (typeof CATCHUP_CHANNELS)[number];

/** One past-due invoice as the caller reads it from the source. */
export type CatchupInvoiceInput = Readonly<{
  invoiceId: string;
  invoiceNumber: string;
  balanceMinor: number;
  /** Phoenix calendar date the invoice fell due. */
  dueOn: string;
  payLink: string | null;
}>;

/** One customer, their invoices, and the destination read for them. */
export type CatchupRecipientInput = Readonly<{
  accountId: string;
  jobberClientId: string;
  clientName: string | null;
  contactId: string | null;
  /** Exact-match contact count. Anything but 1 is a refusal. */
  exactContactMatches: number;
  phone: string | null;
  email: string | null;
  /** True only for an EXPLICIT opt-out. A blank setting is permission. */
  smsOptedOut: boolean;
  emailOptedOut: boolean;
  invoices: readonly CatchupInvoiceInput[];
}>;

export type CatchupSend = Readonly<{
  channel: CatchupChannel;
  destination: string;
  /** One per invoice. All carry this message's body. */
  reservations: readonly Readonly<{
    invoiceId: string;
    invoiceNumber: string;
    dayPastDue: number;
    dueOn: string;
    eventKey: string;
  }>[];
}>;

export type CatchupAction =
  | Readonly<{
      state: "send";
      jobberClientId: string;
      clientName: string | null;
      contactId: string;
      body: string;
      subject: string;
      covers: readonly string[];
      sends: readonly CatchupSend[];
      /** Present only for a named exception, with its reason. */
      emailOnly?: true;
      emailOnlyReasons?: readonly string[];
    }>
  | Readonly<{
      state: "hold";
      jobberClientId: string;
      clientName: string | null;
      invoiceNumbers: readonly string[];
      reasons: readonly string[];
    }>;

export type CatchupPlan = Readonly<{
  actions: readonly CatchupAction[];
  summary: Readonly<{ send: number; hold: number; texts: number; emails: number; invoices: number }>;
}>;

const sorted = (values: readonly string[]) => Object.freeze([...new Set(values)].sort());
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
/** GHL contact ids are opaque; reject anything that is not a plain token. */
const validContactId = (value: unknown): value is string =>
  text(value) && value.trim() === value && /^[A-Za-z0-9_-]{6,64}$/.test(value);

/**
 * The true day count for this invoice on this send date, or null when the
 * dates cannot produce one. Computed the same way the ledger verifies it, so a
 * row this planner builds cannot be rejected for a mismatch.
 */
export function catchupDayPastDue(dueOn: string, sendOn: string): number | null {
  if (invoiceCalendarDate(dueOn) !== dueOn || invoiceCalendarDate(sendOn) !== sendOn) return null;
  for (let day = 1; day <= 3660; day += 1) {
    if (addInvoiceCalendarDays(dueOn, day) === sendOn) return day;
  }
  return null;
}

/** Plans one customer. `sendOn` is the Phoenix calendar date of the run. */
export function planCatchupRecipient(
  input: CatchupRecipientInput, sendOn: string,
): CatchupAction {
  const numbers = Object.freeze((input?.invoices ?? []).map(i => String(i?.invoiceNumber ?? "?")));
  const hold = (...reasons: string[]): CatchupAction => Object.freeze({
    state: "hold" as const, jobberClientId: input?.jobberClientId ?? "",
    clientName: input?.clientName ?? null, invoiceNumbers: numbers, reasons: sorted(reasons),
  });

  if (!input || typeof input !== "object") return hold("recipient_input_malformed");
  if (!text(input.accountId)) return hold("account_id_missing");
  if (invoiceCalendarDate(sendOn) !== sendOn) return hold("send_date_is_not_a_phoenix_calendar_date");
  if (!Array.isArray(input.invoices) || input.invoices.length === 0) return hold("no_invoices");

  if (input.exactContactMatches !== 1) {
    return hold(input.exactContactMatches === 0
      ? "no_exact_ghl_contact"
      : "ambiguous_destination_contacts");
  }
  if (!validContactId(input.contactId)) return hold("no_usable_contact_id");

  // Both channels, or neither. An opt-out on either one holds the whole pair:
  // the approved message is a text AND an email, and silently sending half of
  // it would be a different thing from what was approved.
  if (input.smsOptedOut) return hold("contact_opted_out_of_sms");
  if (input.emailOptedOut) return hold("contact_opted_out_of_email");
  // An email is required of everyone: it is the half both exceptions keep.
  if (!text(input.email)) return hold("no_email_on_contact");

  // A missing phone holds EXCEPT for the two invoices named in the policy, who
  // were checked against Jobber and approved one by one. The exception is read
  // from the pinned list rather than inferred from the absence of a phone, so a
  // contact record that merely happens to be thin still holds.
  // `numbers` is the list built at the top of this function.
  const emailOnly = !text(input.phone) && catchupIsEmailOnly(numbers);
  if (!text(input.phone) && !emailOnly) return hold("no_phone_on_contact");

  const reasons: string[] = [];
  const invoices: CatchupInvoice[] = [];
  const days = new Map<string, Readonly<{ dayPastDue: number; dueOn: string }>>();
  for (const invoice of input.invoices) {
    if (!text(invoice?.invoiceId)) { reasons.push("invoice_id_missing"); continue; }
    if (!text(invoice?.invoiceNumber)) { reasons.push("invoice_number_missing"); continue; }
    const day = catchupDayPastDue(invoice.dueOn, sendOn);
    if (day === null) { reasons.push("day_past_due_unresolvable"); continue; }
    // Not past due today is not a catch-up candidate at all.
    if (day < 1) { reasons.push("invoice_is_not_past_due"); continue; }
    days.set(invoice.invoiceId, Object.freeze({ dayPastDue: day, dueOn: invoice.dueOn }));
    invoices.push(Object.freeze({
      invoiceNumber: invoice.invoiceNumber,
      balanceMinor: invoice.balanceMinor,
      dayPastDue: day,
      payLink: invoice.payLink,
    }));
  }
  if (reasons.length) return hold(...reasons);

  // The copy module refuses a body it cannot render completely, and a missing
  // or off-host payment link is one of the things it refuses on.
  const copy = catchupBody({ clientName: input.clientName, invoices });
  if (!copy) return hold("message_could_not_be_rendered_completely");

  const destinations: Record<CatchupChannel, string | null> = { sms: input.phone, email: input.email };
  // Email only for a named exception; otherwise both halves, or nothing.
  const channels = emailOnly ? (["email"] as const) : CATCHUP_CHANNELS;
  const sends = channels.map(channel => Object.freeze({
    channel,
    destination: destinations[channel] as string,
    reservations: Object.freeze(input.invoices.map(invoice => {
      const when = days.get(invoice.invoiceId)!;
      return Object.freeze({
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.invoiceNumber,
        dayPastDue: when.dayPastDue,
        dueOn: when.dueOn,
        eventKey: eventKey({
          accountId: input.accountId, invoiceId: invoice.invoiceId,
          dayPastDue: when.dayPastDue, audience: "homeowner", channel,
        }),
      });
    })),
  }));

  return Object.freeze({
    state: "send", jobberClientId: input.jobberClientId, clientName: input.clientName,
    contactId: input.contactId, body: copy.body, subject: copy.subject,
    covers: copy.covers, sends: Object.freeze(sends),
    ...(emailOnly ? { emailOnly: true as const, emailOnlyReasons: catchupEmailOnlyReasons(numbers) } : {}),
  });
}

/** Plans the whole batch. Order in, order out. */
export function planCatchupBatch(
  recipients: readonly CatchupRecipientInput[], sendOn: string,
): CatchupPlan {
  const actions = (Array.isArray(recipients) ? recipients : [])
    .map(recipient => planCatchupRecipient(recipient, sendOn));
  let send = 0, hold = 0, texts = 0, emails = 0, invoices = 0;
  for (const action of actions) {
    if (action.state === "send") {
      send += 1;
      invoices += action.covers.length;
      for (const one of action.sends) {
        if (one.channel === "sms") texts += 1; else emails += 1;
      }
    } else hold += 1;
  }
  return Object.freeze({
    actions: Object.freeze(actions),
    summary: Object.freeze({ send, hold, texts, emails, invoices }),
  });
}
