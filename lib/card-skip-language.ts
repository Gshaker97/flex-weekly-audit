/**
 * MACHINE REASONS, TURNED INTO SENTENCES A PERSON CAN ACT ON.
 *
 * The card writer's hold reasons are written for a log: `card_changed_since_the
 * _plan_was_made`. They are precise and they are not readable, and the point of
 * this file is that nobody should have to open a container log to find out why
 * their customer's card did not move.
 *
 * Every sentence says what happened and, where it matters, that nothing was
 * sent. It never says "error" about a deliberate hold: most of these are the
 * writer being careful, not something going wrong.
 *
 * An unknown reason is not hidden. It is de-underscored and passed through, so
 * a new hold reason shows up as readable-ish text on the dashboard rather than
 * silently becoming "unknown".
 */

const SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  // The write was refused before anything was sent. Today's outage.
  source_invoice_amounts_or_status_incoherent:
    "the card's write could not be recorded safely, so it was left exactly as it was. Nothing was sent to GoHighLevel.",

  // The world moved between planning and writing. All of these are the writer
  // refusing to act on a stale picture.
  card_changed_since_the_plan_was_made:
    "the card changed in GoHighLevel after this run planned its move, so the move was abandoned rather than applied to something that had already changed.",
  card_ownership_or_status_changed_before_write:
    "the card changed owner, pipeline or status just before the write, so it was left alone.",
  card_was_not_in_the_preflight_snapshot:
    "the card was not in the snapshot this run started from, so the run had nothing safe to compare it against.",
  invoice_balance_changed_since_the_plan_was_made:
    "the amount owed changed in Jobber while this run was working, so the card was left for the next run to price correctly.",
  write_approval_changed_before_write:
    "the card-write approval changed mid-run, so the write was not attempted.",

  // The card is not ours to touch.
  card_is_in_a_protected_or_unknown_stage:
    "the card sits in a stage this sync does not manage, so it was not moved.",
  card_no_longer_names_exactly_this_invoice:
    "the card's name no longer matches exactly this one invoice, so moving it could have moved the wrong customer's card.",
  card_names_an_invoice_this_write_does_not_cover:
    "the card names an invoice this write does not cover, so it was left alone.",
  only_a_card_that_names_every_invoice_it_covers_can_be_retired:
    "the card does not name every invoice it covers, so it was not retired to Paid.",

  // Money and status disagreements.
  invoice_is_no_longer_unpaid:
    "the invoice is no longer owing, so there was nothing to chase.",
  one_of_these_invoices_is_no_longer_unpaid:
    "one of the invoices on this combined card is no longer owing, so the card was left for the next run.",
  one_of_these_invoices_is_not_settled:
    "the card covers an invoice that still owes money, so it was NOT moved to Paid.",
  these_invoices_no_longer_add_up_to_the_amount_planned:
    "the invoices on this card no longer add up to the amount planned, so a stale total was refused rather than written.",

  run_write_budget_exhausted:
    "this run had already made as many card writes as it is allowed, so the rest were left for the next run.",

  // Duplicate protection working as intended.
  a_card_for_this_invoice_already_exists:
    "a card for this invoice already exists, so a second one was not created.",
  creation_already_claimed_for_this_invoice:
    "this invoice's card was already claimed earlier, so a duplicate was not created.",
  creation_target_is_not_the_sent_stage:
    "a new card may only be created in the Invoice Sent stage, and this one targeted a different stage.",

  // Evidence we could not read. Nothing sent in any of these.
  source_evidence_unavailable:
    "this run could not read the invoice's amounts strictly enough to act on them, so the card was left alone.",
  card_or_source_evidence_unavailable_or_would_rename:
    "the write would have renamed the card, or its evidence could not be read, so it was not attempted.",
});

const PREFIXES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["fresh_card_read_failed_",
    "the card could not be re-read from GoHighLevel just before the write, so it was left alone. Nothing was sent."],
  ["contact_card_read_failed_",
    "this customer's cards could not be read from GoHighLevel, so none of them was touched."],
]);

/** One readable sentence for one hold reason. Never throws, never empty. */
export function plainCardSkipReason(reason: string | null | undefined): string {
  const raw = typeof reason === "string" ? reason.trim() : "";
  if (!raw) return "it was held for a reason this run did not record.";
  if (SENTENCES[raw]) return SENTENCES[raw];
  for (const [prefix, sentence] of PREFIXES) if (raw.startsWith(prefix)) return sentence;
  // Already a sentence? Writers that build their own text end with a period or
  // contain spaces; pass those through untouched.
  if (/\s/.test(raw)) return raw;
  // An unknown machine code: make it as readable as it can be, and say so.
  return `${raw.replace(/_/g, " ")} (reason not yet translated)`;
}
