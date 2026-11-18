/**
 * Does the job behind this invoice look like work we should not be chasing?
 *
 * Approved rule: exclude CONFIRMED warranty, callback or no-charge rework. A
 * word on its own does not confirm anything — "redoing", "callback" and
 * "courtesy" are all ordinary scheduling or sales language in these notes. Real
 * examples measured on 2026-11-17:
 *
 *   #7334 "Send out quote to client for redoing backyard drip ..." — a QUOTE for
 *         future work, beside a note saying "We are good to invoice client".
 *   #6872 "... Also need to complete fertilization service and re-do of tree" —
 *         work still to be done, with no suggestion it is free.
 *
 * Both would have been wrongly excluded by matching the bare word. So a bare
 * rework word now HOLDS for a person to read, and only a phrase that asserts the
 * work was under warranty or carried no charge excludes. Pairing is judged
 * WITHIN ONE NOTE: "quote for redoing" in one note and "no charge" in another
 * note must not combine into a false confirmation.
 *
 * Three outcomes, and nothing else:
 *   "excluded"  one note asserts warranty or no-charge work -> never email
 *   "hold"      unknown, unreadable or ambiguous            -> a person decides
 *   "clear"     text was read and asserts nothing of the kind -> may proceed
 *
 * `evidence` is the matched phrase only. Job notes are customer and crew text,
 * so no surrounding words are returned and nothing here is written to a log.
 */
export type ReworkVerdict = "excluded" | "hold" | "clear";
export interface ReworkClassification {
  verdict: ReworkVerdict;
  /** Stable machine reason. Safe to log. */
  reason: string;
  /** The matched phrase, lowercased. Null when nothing matched. */
  evidence: string | null;
}

/**
 * Checked FIRST, because "out of warranty" means the customer owes us. Letting a
 * warranty phrase match first would exclude exactly the wrong invoices. It still
 * holds rather than clears: a person should read a negated warranty.
 */
const NEGATED_WARRANTY: readonly RegExp[] = [
  /\bout\s+of\s+warranty\b/i,
  /\bnot\s+(?:under\s+)?(?:a\s+)?warranty\b/i,
  /\bno\s+longer\s+under\s+warranty\b/i,
  /\bnon[-\s]?warranty\b/i,
  /\bno\s+warranty\b/i,
  /\bwarranty\s+(?:has\s+)?(?:expired|ended|lapsed)\b/i,
];

/**
 * Asserts the work itself was under warranty or carried no charge. These are the
 * only phrases that exclude. Each one names the arrangement, not just the task.
 */
const CONFIRMED: readonly RegExp[] = [
  /\bunder\s+warranty\b/i,
  /\bwarranty\s+(?:work|repair|replacement|service|call|claim|visit|job|item)s?\b/i,
  /\bwarrantied\b/i,
  /\bat\s+no\s+charge\b/i,
  /\bno\s+charge\s+(?:to|for)\b/i,
  /\bfree\s+of\s+charge\b/i,
  /\bat\s+no\s+cost\b/i,
  /\bat\s+our\s+(?:cost|expense)\b/i,
  /\bon\s+our\s+dime\b/i,
  /\bwe(?:'ll|\s+will)?\s+(?:cover|eat)\s+(?:the|this|that|it)\b/i,
];

/**
 * A rework word. On its own it holds. It only excludes when the SAME note also
 * says the work was free or under warranty.
 */
const REWORK_WORD: readonly RegExp[] = [
  /\bre[-\s]?work(?:ed|ing)?\b/i,
  /\bre[-\s]?do(?:ne|ing)?\b/i,
  /\bredo(?:ne|ing)?\b/i,
  /\bcallbacks?\b/i,
  /\bcall[-]backs?\b/i,
];

/** A free-work signal loose enough that it only confirms beside a rework word. */
const FREE_SIGNAL: readonly RegExp[] = [
  /\bno[-\s]?charge\b/i,
  /\bnocharge\b/i,
  /\bno\s+cost\b/i,
  /\bcomp(?:'?d|ed|limentary)\b/i,
  /\bcourtesy\b/i,
  /\bwarranty\b/i,
  /\bgood\s*will\b/i,
  /\bon\s+us\b/i,
];

/**
 * Ambiguous on its own: it might mean we did the work for nothing, or it might
 * be ordinary wording. Held for a person. "call back" as two words lives here
 * because in these notes it is usually "call the customer back to schedule".
 */
const AMBIGUOUS: readonly RegExp[] = [
  ...REWORK_WORD,
  /\bwarranty\b/i,
  /\bcourtesy\b/i,
  /\bcomplimentary\b/i,
  /\bcomp(?:'?d|ed)\b/i,
  /\bgoodwill\b/i,
  /\bgood\s+will\b/i,
  /\bno[-\s]?charge\b/i,
  /\bnocharge\b/i,
  /\bcall\s+back\b/i,
  /\bcalled\s+back\b/i,
  /\bon\s+us\b/i,
  /\bwrote\s+(?:it\s+)?off\b/i,
  /\bwrite[-\s]?off\b/i,
];

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const found = pattern.exec(text);
    if (found) return found[0].toLowerCase().replace(/\s+/g, " ");
  }
  return null;
}

function unreadable(text: string): boolean {
  return text.includes("\u0000") || text.includes("�");
}

/**
 * Classify ONE note. Exported because the per-note boundary is the rule, not an
 * implementation detail: a confirmation must come from a single note.
 */
export function classifyOneNote(note: string): ReworkClassification {
  if (typeof note !== "string" || unreadable(note)) {
    return { verdict: "hold", reason: "job_notes_unreadable", evidence: null };
  }
  const text = note.trim();
  if (!text) return { verdict: "hold", reason: "job_notes_missing", evidence: null };

  const negated = firstMatch(text, NEGATED_WARRANTY);
  if (negated) return { verdict: "hold", reason: "warranty_mentioned_but_negated", evidence: negated };

  const confirmed = firstMatch(text, CONFIRMED);
  if (confirmed) return { verdict: "excluded", reason: "confirmed_warranty_or_no_charge", evidence: confirmed };

  const rework = firstMatch(text, REWORK_WORD);
  if (rework) {
    const free = firstMatch(text, FREE_SIGNAL);
    if (free) {
      return { verdict: "excluded", reason: "rework_with_free_or_warranty_signal_in_the_same_note",
        evidence: `${rework} + ${free}` };
    }
    return { verdict: "hold", reason: "rework_word_without_proof_it_was_free", evidence: rework };
  }

  const ambiguous = firstMatch(text, AMBIGUOUS);
  if (ambiguous) return { verdict: "hold", reason: "ambiguous_rework_phrase", evidence: ambiguous };

  return { verdict: "clear", reason: "notes_read_no_rework_phrase", evidence: null };
}

/** Worst outcome wins: excluded beats hold, hold beats clear. */
function worst(a: ReworkClassification, b: ReworkClassification): ReworkClassification {
  const rank = (v: ReworkVerdict) => (v === "excluded" ? 2 : v === "hold" ? 1 : 0);
  return rank(b.verdict) > rank(a.verdict) ? b : a;
}

/**
 * Classify every note belonging to one job. A job with no readable text at all
 * holds: measured example #7207, whose single linked job carries 26 notes that
 * are all empty strings (photo-only notes).
 */
export function classifyJobText(input: {
  title: string | null; instructions: string | null; jobNoteMessages: readonly string[];
}): ReworkClassification {
  const pieces = [
    ...(input.jobNoteMessages ?? []),
    ...(typeof input.instructions === "string" ? [input.instructions] : []),
    ...(typeof input.title === "string" ? [input.title] : []),
  ].filter(piece => typeof piece === "string" && piece.trim().length > 0);

  if (pieces.length === 0) {
    return { verdict: "hold", reason: "job_has_no_readable_text", evidence: null };
  }
  let decision: ReworkClassification = { verdict: "clear", reason: "notes_read_no_rework_phrase", evidence: null };
  for (const piece of pieces) decision = worst(decision, classifyOneNote(piece));
  return decision;
}

/**
 * The invoice-level verdict, over every job Jobber links to it.
 *
 * Anything that could not be read in full holds. No linked job holds. One job
 * asserting warranty or no charge excludes the invoice even if another job is
 * clean, because we must not chase an invoice that covers free work.
 */
export function classifyLinkedJobRework(result: {
  complete: boolean; reason: string | null;
  jobs: readonly { notesComplete: boolean; title: string | null; instructions: string | null;
    jobNoteMessages: readonly string[] }[];
}): ReworkClassification {
  if (!result || result.complete !== true) {
    return { verdict: "hold", reason: `linked_jobs_read_incomplete: ${result?.reason ?? "unknown"}`, evidence: null };
  }
  if (!result.jobs.length) return { verdict: "hold", reason: "no_linked_job_in_jobber", evidence: null };
  if (result.jobs.some(job => job.notesComplete !== true)) {
    return { verdict: "hold", reason: "job_notes_read_incomplete", evidence: null };
  }
  let decision: ReworkClassification = { verdict: "clear", reason: "notes_read_no_rework_phrase", evidence: null };
  for (const job of result.jobs) decision = worst(decision, classifyJobText(job));
  return decision;
}

/**
 * Cache-based fallback, kept only for the invoice-number join. It is strictly
 * weaker than `classifyLinkedJobRework` and must not be used when Jobber can be
 * asked: the cache join misses recurring work entirely.
 */
export function classifyReworkNotes(
  matchedJob: boolean,
  notes: string | null | undefined,
): ReworkClassification {
  if (!matchedJob) return { verdict: "hold", reason: "job_not_matched_to_invoice", evidence: null };
  if (typeof notes !== "string") return { verdict: "hold", reason: "job_notes_missing", evidence: null };
  return classifyJobText({ title: null, instructions: null, jobNoteMessages: [notes] });
}
