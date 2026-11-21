/**
 * The one billing-SMS consent submission already matched to the pilot invoice.
 *
 * This module does NOT search for consent. The submission is pinned out of band by
 * location, form, submission id, contact and exact instant, and all a run does is
 * re-read that one submission and check it still says what the pin claims. A missing
 * submission, a different submission, a moved timestamp, a different contact or an
 * empty terms value is a HOLD - never a reason to go looking for another consenting
 * record. There is deliberately no "any consenting submission will do" path, and no
 * path from a DND reading to consent.
 *
 * Read-only by construction: GET only, one bounded path, redirects refused, response
 * size capped. Import is inert; nothing here reads env, files, a database or a clock
 * of its own.
 */
import type { Day15SmsConsent } from "./notification-day15-pilot";

export const DAY15_CONSENT_CONTRACT = Object.freeze({
  origin: "https://services.leadconnectorhq.com",
  path: "/forms/submissions",
  version: "2021-07-28",
  pageSize: 100,
  maxPages: 5,
  maxResponseBytes: 2_000_000,
  maxRequestMs: 5000,
  maxReadMs: 15_000,
  /** Only a key of this exact shape counts as the terms field. */
  termsKey: /^terms[_\s-]?and[_\s-]?conditions$/i,
  productionSendCapability: false,
} as const);
const C = DAY15_CONSENT_CONTRACT;

/** Pinned out of band, alongside the review hash. Never derived from a search. */
export type Day15ConsentPin = Readonly<{
  version: 1;
  locationId: string;
  formId: string;
  submissionId: string;
  contactId: string;
  /** The exact instant the submission carries, to the millisecond. */
  submittedAt: string;
  source: Day15SmsConsent["source"];
  /** Must equal the sender configuration's consent.evidenceRef. */
  evidenceRef: string;
}>;

export type Day15ConsentRequest = Readonly<{
  method: "GET";
  url: string;
  headers: Readonly<{ Version: typeof C.version; Accept: "application/json" }>;
  signal: AbortSignal;
}>;
/** Trusted IO boundary. The caller owns the credential; this module never sees env. */
export type Day15ConsentIO = Readonly<{
  get(request: Day15ConsentRequest): Promise<{ status: number; text: string }>;
}>;

export type Day15ConsentRead = Readonly<{
  state: "verified" | "held";
  reasons: readonly string[];
  submissionId: string | null;
  pagesRead: number;
  observedAt: string | null;
  productionSendCapability: false;
}>;

const text = (x: unknown): x is string =>
  typeof x === "string" && !!x && x.length <= 256 && x.trim() === x && !/[\x00-\x1f\x7f]/.test(x);
const instant = (x: unknown): number =>
  typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) && new Date(Date.parse(x)).toISOString() === x ? Date.parse(x) : NaN;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Structural validation only. Returns null rather than a partly trusted pin. */
export function parseDay15ConsentPin(raw: unknown): Day15ConsentPin | null {
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (!raw || Buffer.byteLength(raw, "utf8") > 8192) return null;
    try { value = JSON.parse(raw); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const expected = ["version", "locationId", "formId", "submissionId", "contactId", "submittedAt", "source", "evidenceRef"];
  const keys = Object.keys(value as object);
  if (keys.length !== expected.length || !keys.every(k => expected.includes(k))) return null;
  const p = value as Day15ConsentPin;
  if (p.version !== 1) return null;
  if (![p.locationId, p.formId, p.submissionId, p.contactId, p.evidenceRef].every(text)) return null;
  if (!["signed-agreement", "written-reply", "recorded-verbal"].includes(p.source)) return null;
  if (!Number.isFinite(instant(p.submittedAt))) return null;
  return Object.freeze({ ...p });
}

/**
 * The pin and the configuration's consent record must describe the SAME evidence.
 * Checked before any network read, so a mismatch costs no request.
 */
export function pinMatchesConfiguredConsent(pin: Day15ConsentPin, consent: Day15SmsConsent | null): readonly string[] {
  const reasons: string[] = [];
  if (!consent || typeof consent !== "object") return Object.freeze(["configured_consent_absent"]);
  if (consent.scope !== "billing-sms") reasons.push("configured_consent_scope_is_not_billing_sms");
  if (consent.contactId !== pin.contactId) reasons.push("pinned_contact_differs_from_configured_consent");
  if (consent.source !== pin.source) reasons.push("pinned_source_differs_from_configured_consent");
  if (consent.evidenceRef !== pin.evidenceRef) reasons.push("pinned_evidence_reference_differs_from_configured_consent");
  if (consent.recordedAt !== pin.submittedAt) reasons.push("pinned_instant_differs_from_configured_consent");
  return Object.freeze(reasons);
}

function termsValue(submission: Record<string, unknown>): string | null {
  const pools: unknown[] = [submission, (submission as any).others, (submission as any).customFields];
  for (const pool of pools) {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)) continue;
    for (const [key, raw] of Object.entries(pool as Record<string, unknown>)) {
      if (!C.termsKey.test(key)) continue;
      const value = typeof raw === "string" ? raw : null;
      if (value && value.trim() && Buffer.byteLength(value, "utf8") <= 8192) return value;
    }
  }
  return null;
}

/**
 * Re-reads the pinned submission and reports verified or held. Never throws for a
 * data problem: an unreadable or disagreeing submission is a hold with reasons.
 */
export async function readDay15ConsentEvidence(
  pin: Day15ConsentPin,
  consent: Day15SmsConsent | null,
  io: Day15ConsentIO,
  now: () => Date = () => new Date(Date.now()),
): Promise<Day15ConsentRead> {
  const held = (reasons: readonly string[], pagesRead = 0): Day15ConsentRead => Object.freeze({
    state: "held", reasons: Object.freeze([...reasons]), submissionId: null, pagesRead,
    observedAt: null, productionSendCapability: false,
  });
  const mismatch = pinMatchesConfiguredConsent(pin, consent);
  if (mismatch.length) return held(mismatch);

  const at = instant(pin.submittedAt);
  const date = day(at);
  const deadlineAt = now().getTime() + C.maxReadMs;
  let pagesRead = 0;

  try {
    for (let page = 1; page <= C.maxPages; page++) {
      if (now().getTime() >= deadlineAt) return held(["consent_read_deadline_exceeded"], pagesRead);
      const url = `${C.origin}${C.path}?locationId=${encodeURIComponent(pin.locationId)}` +
        `&formId=${encodeURIComponent(pin.formId)}&startAt=${date}&endAt=${date}` +
        `&limit=${C.pageSize}&page=${page}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), C.maxRequestMs);
      let response: { status: number; text: string };
      try {
        response = await io.get(Object.freeze({
          method: "GET", url,
          headers: Object.freeze({ Version: C.version, Accept: "application/json" as const }),
          signal: controller.signal,
        }));
      } finally { clearTimeout(timer); }
      pagesRead = page;
      if (response.status !== 200) return held([`consent_read_http_${response.status}`], pagesRead);
      if (typeof response.text !== "string" || Buffer.byteLength(response.text, "utf8") > C.maxResponseBytes)
        return held(["consent_read_response_unbounded"], pagesRead);
      let parsed: any;
      try { parsed = JSON.parse(response.text); } catch { return held(["consent_read_response_unparseable"], pagesRead); }
      const rows = parsed?.submissions;
      if (!Array.isArray(rows)) return held(["consent_read_response_shape_unverified"], pagesRead);

      const found = rows.find(row => row && typeof row === "object" && (row as any).id === pin.submissionId);
      if (found) {
        const reasons: string[] = [];
        const row = found as Record<string, unknown>;
        if (row.contactId !== pin.contactId) reasons.push("read_submission_contact_mismatch");
        if (row.formId !== undefined && row.formId !== pin.formId) reasons.push("read_submission_form_mismatch");
        const created = instant(row.createdAt) || Date.parse(String(row.createdAt ?? ""));
        if (!Number.isFinite(created) || created !== at) reasons.push("read_submission_instant_moved");
        if (!termsValue(row)) reasons.push("read_submission_has_no_terms_and_conditions_value");
        if (reasons.length) return held(reasons, pagesRead);
        return Object.freeze({ state: "verified", reasons: Object.freeze([]), submissionId: pin.submissionId,
          pagesRead, observedAt: now().toISOString(), productionSendCapability: false });
      }
      // Only continue while the source itself says there is another page.
      const next = parsed?.meta?.nextPage;
      if (next === null || next === undefined || next === false) break;
      if (rows.length === 0) break;
    }
  } catch { return held(["consent_read_unavailable"], pagesRead); }
  return held(["pinned_consent_submission_not_found"], pagesRead);
}
