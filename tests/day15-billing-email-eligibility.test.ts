import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReminders } from "../lib/reminder-evaluation";
import { day15EmailHtmlFromPlain, PROPOSED_DAY15_EMAIL_BODY } from "../lib/notification-day15-email-copy";

/**
 * Jobber decides where the bill goes, not GoHighLevel.
 *
 * The destination contact is matched on a CACHED email or phone. A phone-only
 * match can therefore hand back a contact whose email address Jobber has never
 * held. These tests pin the rule that the address has to be one Jobber bills.
 */
const SOURCE = {
  invoiceStatus: "past_due", totalCents: 13700, balanceCents: 13700,
  issuedDate: "2026-10-20", dueDate: "2026-11-02",
  clientId: "cli-1", clientTags: ["Irrigation"], lineItemNames: ["Irrigation repair"],
  clientBillingEmails: ["a@example.com"],
};
const CANDIDATE = { jobberInvoiceId: "inv-1", invoiceNumber: "7207", clientName: "A",
  jobberClientId: "cli-1", email: "a@example.com", phone: "+16025550100" };
const CONTACT = { id: "c1", tags: ["Irrigation"], dnd: false, emailDndStatus: "inactive",
  phone: "+16025550100", email: "a@example.com" };
const AT_DAY_15 = new Date("2026-11-17T16:05:00.000Z");

const holdsFor = async (source: Record<string, unknown>, contact: Record<string, unknown>) => {
  const result = await evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => source,
      matchContacts: async () => [contact],
      cardsForContact: async () => [{ id: "o1", stage: "invoice overdue", status: "open" }],
      sendHistory: async () => ({ complete: true, sends: [] }),
    } as any,
    now: AT_DAY_15, verifiedExclusions: ["cli-x"], ignoreWindow: true,
    milestoneChannels: () => ["email"], feeClaimFreeDay15: true, jobberOnlyDay15Email: true,
  } as any);
  return result.rows[0].holds.filter(hold =>
    hold.startsWith("destination_contact_has_no_email") ||
    hold.startsWith("jobber_billing_emails_unreadable") ||
    hold.startsWith("jobber_holds_no_billing_email") ||
    hold.startsWith("destination_email_not_a_jobber_billing_email"));
};

test("an address Jobber bills is eligible", async () => {
  assert.deepEqual(await holdsFor(SOURCE, CONTACT), []);
});

test("case and surrounding space do not make a match into a mismatch", async () => {
  assert.deepEqual(await holdsFor(
    { ...SOURCE, clientBillingEmails: ["  A@Example.COM  "] },
    { ...CONTACT, email: "a@EXAMPLE.com" }), []);
});

test("a contact with no email at all holds, and is named as that", async () => {
  assert.deepEqual(await holdsFor(SOURCE, { ...CONTACT, email: null }),
    ["destination_contact_has_no_email"]);
  assert.deepEqual(await holdsFor(SOURCE, { ...CONTACT, email: "   " }),
    ["destination_contact_has_no_email"]);
});

test("something that is not an address holds rather than being posted", async () => {
  for (const bad of ["nate", "nate@localhost", "a@b", "a b@example.com"]) {
    assert.deepEqual(await holdsFor(SOURCE, { ...CONTACT, email: bad }),
      ["destination_contact_has_no_email"], bad);
  }
});

test("an unreadable Jobber email list holds; unreadable is not 'no address'", async () => {
  assert.deepEqual(await holdsFor({ ...SOURCE, clientBillingEmails: null }, CONTACT),
    ["jobber_billing_emails_unreadable"]);
  const { clientBillingEmails, ...withoutTheField } = SOURCE;
  assert.deepEqual(await holdsFor(withoutTheField, CONTACT),
    ["jobber_billing_emails_unreadable"]);
});

test("a client Jobber holds no email for holds, separately named", async () => {
  assert.deepEqual(await holdsFor({ ...SOURCE, clientBillingEmails: [] }, CONTACT),
    ["jobber_holds_no_billing_email"]);
});

test("a GoHighLevel address Jobber does not bill holds", async () => {
  assert.deepEqual(await holdsFor(SOURCE, { ...CONTACT, email: "someone-else@example.com" }),
    ["destination_email_not_a_jobber_billing_email"]);
});

test("one of several Jobber addresses is enough", async () => {
  assert.deepEqual(await holdsFor(
    { ...SOURCE, clientBillingEmails: ["billing@example.com", "a@example.com"] }, CONTACT), []);
});

test("the check is email-path only: the SMS path is untouched by it", async () => {
  const result = await evaluateReminders({
    candidates: [CANDIDATE],
    readers: {
      readInvoice: async () => ({ ...SOURCE, clientBillingEmails: null }),
      matchContacts: async () => [{ ...CONTACT, email: null }],
      cardsForContact: async () => [{ id: "o1", stage: "invoice overdue", status: "open" }],
      sendHistory: async () => ({ complete: true, sends: [] }),
    } as any,
    now: AT_DAY_15, verifiedExclusions: ["cli-x"], ignoreWindow: true,
    milestoneChannels: () => ["sms"],
  } as any);
  for (const hold of result.rows[0].holds) {
    assert.ok(!hold.includes("billing_email") && !hold.includes("has_no_email"), hold);
  }
});

/**
 * GoHighLevel answers 422 CONVERSATIONS_MSG_NO_CONTENT to an Email whose only
 * content is `message`. The wire body is therefore the HTML form of the same
 * approved words, and this is the only transformation allowed on the way there.
 */
test("the HTML body adds no words and keeps every line", () => {
  const plain = "Hello,\n\nA line.\nAnother line.";
  const html = day15EmailHtmlFromPlain(plain);
  assert.equal(html.replace(/<br>/g, "").replace(/\n/g, "\n"), plain.replace(/\n/g, "\n"));
  assert.equal(html.split("<br>").length - 1, plain.split("\n").length - 1);
});

test("the HTML body escapes metacharacters so nothing is injectable", () => {
  const html = day15EmailHtmlFromPlain(`a & b < c > d " e ' f`);
  assert.ok(html.includes("&amp;") && html.includes("&lt;") && html.includes("&gt;"));
  assert.ok(html.includes("&quot;") && html.includes("&#39;"));
  assert.ok(!/[<>](?!br>)/.test(html.replace(/<br>/g, "")));
});

test("the HTML body is deterministic, so pre-send drift is still detectable", () => {
  assert.equal(day15EmailHtmlFromPlain(PROPOSED_DAY15_EMAIL_BODY),
    day15EmailHtmlFromPlain(PROPOSED_DAY15_EMAIL_BODY));
});

test("the HTML conversion refuses a body that claims a fee, like the plain one", () => {
  assert.throws(() => day15EmailHtmlFromPlain("We have added a 3% late fee to your invoice."),
    /claims_a_fee/);
  assert.throws(() => day15EmailHtmlFromPlain(""), /requires_a_body/);
});
