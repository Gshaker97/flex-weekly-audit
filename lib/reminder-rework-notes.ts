/**
 * Does the job behind this invoice look like work we should not be chasing?
 *
 * Approved rule: exclude CONFIRMED warranty, callback or no-charge rework.
 * "courtesy" on its own is NOT a confirmed exclusion. If the job cannot be
 * matched, or its notes are missing, unreadable or ambiguous, the invoice is
 * HELD for a person to read — never silently sent and never silently excluded.
 *
 * Three outcomes, and nothing else:
 *   "excluded"  a confirmed rework phrase is present -> do not email, ever
 *   "hold"      unknown, unreadable or ambiguous     -> a person decides
 *   "clear"     notes were read and say nothing of the kind -> may proceed
 *
 * `evidence` is the matched phrase only. Job notes are customer text, so no
 * surrounding words are returned and nothing here is written to a log.
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
 * Checked FIRST, because "out of warranty" means the customer owes us. Letting
 * the warranty term match first would exclude exactly the wrong invoices.
 * It still holds rather than clears: a person should read a negated warranty.
 */
const NEGATED_WARRANTY: readonly RegExp[] = [
  /\bout\s+of\s+warranty\b/i,
  /\bnot\s+(?:under\s+)?(?:a\s+)?warranty\b/i,
  /\bno\s+longer\s+under\s+warranty\b/i,
  /\bnon[-\s]?warranty\b/i,
  /\bno\s+warranty\b/i,
  /\bwarranty\s+(?:has\s+)?(?:expired|ended|lapsed)\b/i,
];

/** A confirmed exclusion. Each phrase names the work, not a scheduling action. */
const CONFIRMED_REWORK: readonly RegExp[] = [
  /\bwarranty\b/i,
  /\bwarrantied\b/i,
  /\bcallbacks?\b/i,
  /\bcall[-]backs?\b/i,
  /\bno[-\s]?charge\b/i,
  /\bnocharge\b/i,
  /\bfree\s+of\s+charge\b/i,
  /\bat\s+no\s+cost\b/i,
  /\bre[-\s]?work(?:ed|ing)?\b/i,
  /\bre[-\s]?do(?:ne|ing)?\b/i,
  /\bredo(?:ne|ing)?\b/i,
];

/**
 * Ambiguous: it might mean we did the work for nothing, or it might be ordinary
 * wording. Held for a person. "call back" as two words lives here on purpose —
 * in these notes it is usually "call the customer back to schedule", which is
 * not rework, but it is not safe to assume either way.
 */
const AMBIGUOUS: readonly RegExp[] = [
  /\bcourtesy\b/i,
  /\bcomplimentary\b/i,
  /\bgoodwill\b/i,
  /\bgood\s+will\b/i,
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

/**
 * @param matchedJob false when no job could be tied to the invoice at all.
 * @param notes      the job's notes exactly as cached from Jobber.
 */
export function classifyReworkNotes(
  matchedJob: boolean,
  notes: string | null | undefined,
): ReworkClassification {
  if (!matchedJob) return { verdict: "hold", reason: "job_not_matched_to_invoice", evidence: null };
  if (notes === null || notes === undefined) return { verdict: "hold", reason: "job_notes_missing", evidence: null };
  if (typeof notes !== "string") return { verdict: "hold", reason: "job_notes_unreadable", evidence: null };
  // Replacement characters mean the text did not survive its round trip.
  if (notes.includes("\u0000") || notes.includes("�")) {
    return { verdict: "hold", reason: "job_notes_unreadable", evidence: null };
  }
  const text = notes.trim();
  if (!text) return { verdict: "hold", reason: "job_notes_missing", evidence: null };

  const negated = firstMatch(text, NEGATED_WARRANTY);
  if (negated) return { verdict: "hold", reason: "warranty_mentioned_but_negated", evidence: negated };

  const confirmed = firstMatch(text, CONFIRMED_REWORK);
  if (confirmed) return { verdict: "excluded", reason: "confirmed_rework_phrase", evidence: confirmed };

  const ambiguous = firstMatch(text, AMBIGUOUS);
  if (ambiguous) return { verdict: "hold", reason: "ambiguous_rework_phrase", evidence: ambiguous };

  return { verdict: "clear", reason: "notes_read_no_rework_phrase", evidence: null };
}
