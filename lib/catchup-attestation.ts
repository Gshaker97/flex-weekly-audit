/**
 * THE APPROVAL, MADE INTO SOMETHING A MACHINE CAN CHECK.
 *
 * The owner approving "send the catch-up to the 16" is a real decision, but it
 * is not a thing the send path can verify. This module turns it into one: a
 * manifest listing every message that would go out, each with the SHA-256 of
 * the byte-exact request that would be posted, and a single hash over the whole
 * set. The owner reads the manifest and approves it by naming that one hash.
 * The transport then sends only messages whose request hash appears in it.
 *
 * WHY A MANIFEST AND NOT A FLAG. A flag says "sending is allowed". It cannot
 * say "these 31 messages, in these words, to these people, for these amounts,
 * are allowed". The difference matters most when something changes between the
 * approval and the send: a flag keeps sending, a manifest stops. If a balance
 * moves, the words move with it, the request hash changes, and the new message
 * is simply not in the approved set.
 *
 * WHAT THIS DELIBERATELY IS NOT. It is not a substitute for the per-message
 * review that `lib/notification-ghl-transport.ts` demands for the LADDER. That
 * module also requires the notification gate to find the message eligible, and
 * the gate holds anything that is not a real milestone today inside the
 * 09:00-09:15 Phoenix window - its own hold reason is named
 * `outside_proposed_window_no_catch_up`. The catch-up is off-ladder by
 * definition: it replays day numbers like 1, 41 and 71, none of which is a
 * rung. So the catch-up cannot use that path, and relaxing the gate to let it
 * through would weaken the guard for every ordinary reminder. This is a
 * separate, narrower approval for a one-time batch, and it is written down here
 * rather than hidden in a script so that choice can be argued with.
 *
 * WHAT IT STILL DOES NOT GRANT. Consent, a reviewed sender, the live balance
 * check and the ledger fence all remain exactly where they were. An attested
 * message that a customer has opted out of, or whose invoice has been paid,
 * still does not go out: `catchup-plan.ts` and `catchup-dispatch.ts` decide
 * that, and this module never overrides them. It only ever subtracts.
 */
import { createHash } from "node:crypto";

export const CATCHUP_MANIFEST_VERSION = "catchup-approval-manifest-v1" as const;

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

/** The SHA-256 of the exact bytes that will be posted. The only identity that matters. */
export function catchupRequestSha256(serializedBody: string): string {
  if (typeof serializedBody !== "string") throw new Error("catchup_request_body_must_be_a_string");
  return sha256(serializedBody);
}

/**
 * One approved message.
 *
 * It carries the WORDS, not just the hash, because a hash nobody can read is
 * not an approval - it is a formality. The destination is reduced to its last
 * four characters: enough to tell two recipients apart when checking the list,
 * not enough to turn the manifest into a contact export.
 */
export type CatchupAttestation = Readonly<{
  requestSha256: string;
  channel: "sms" | "email";
  clientName: string | null;
  invoiceNumbers: readonly string[];
  balanceMinorTotal: number;
  daysPastDue: readonly number[];
  destinationLast4: string;
  subject: string | null;
  body: string;
}>;

export type CatchupApprovalManifest = Readonly<{
  version: typeof CATCHUP_MANIFEST_VERSION;
  preparedAt: string;
  sendDate: string;
  accountId: string;
  locationId: string;
  smsSender: string;
  emailSender: string;
  entries: readonly CatchupAttestation[];
  /** One hash over the whole set. Approving names THIS, so the set cannot grow. */
  manifestSha256: string;
}>;

/** Stable over the content that matters, independent of key order or formatting. */
export function catchupManifestSha256(
  input: Readonly<{ sendDate: string; accountId: string; locationId: string;
    smsSender: string; emailSender: string; entries: readonly CatchupAttestation[] }>,
): string {
  const canonical = JSON.stringify([
    CATCHUP_MANIFEST_VERSION, input.sendDate, input.accountId, input.locationId,
    input.smsSender, input.emailSender,
    [...input.entries]
      .map(entry => [entry.requestSha256, entry.channel, entry.destinationLast4,
        [...entry.invoiceNumbers].sort(), entry.balanceMinorTotal,
        [...entry.daysPastDue].sort((a, b) => a - b), entry.subject ?? "", entry.body])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
  return sha256(canonical);
}

export function buildCatchupManifest(
  input: Readonly<{ preparedAt: string; sendDate: string; accountId: string; locationId: string;
    smsSender: string; emailSender: string; entries: readonly CatchupAttestation[] }>,
): CatchupApprovalManifest {
  const entries = Object.freeze([...input.entries].map(entry => Object.freeze({ ...entry,
    invoiceNumbers: Object.freeze([...entry.invoiceNumbers]),
    daysPastDue: Object.freeze([...entry.daysPastDue]) })));
  return Object.freeze({
    version: CATCHUP_MANIFEST_VERSION,
    preparedAt: input.preparedAt, sendDate: input.sendDate,
    accountId: input.accountId, locationId: input.locationId,
    smsSender: input.smsSender, emailSender: input.emailSender,
    entries,
    manifestSha256: catchupManifestSha256({ ...input, entries }),
  });
}

/**
 * Reads a manifest back and RECOMPUTES its hash.
 *
 * A manifest edited after approval - one line added, one amount changed - fails
 * here rather than at the customer's phone.
 */
export function parseCatchupManifest(value: unknown): CatchupApprovalManifest | null {
  try {
    const m = value as CatchupApprovalManifest;
    if (!m || typeof m !== "object" || m.version !== CATCHUP_MANIFEST_VERSION) return null;
    if (![m.preparedAt, m.sendDate, m.accountId, m.locationId, m.smsSender, m.emailSender].every(text)) return null;
    if (!hex64(m.manifestSha256) || !Array.isArray(m.entries) || m.entries.length === 0) return null;
    for (const entry of m.entries) {
      if (!hex64(entry?.requestSha256)) return null;
      if (entry.channel !== "sms" && entry.channel !== "email") return null;
      if (!text(entry.body) || !Array.isArray(entry.invoiceNumbers) || entry.invoiceNumbers.length === 0) return null;
      if (!entry.invoiceNumbers.every(text)) return null;
      if (!Number.isSafeInteger(entry.balanceMinorTotal) || entry.balanceMinorTotal <= 0) return null;
      if (!Array.isArray(entry.daysPastDue) || !entry.daysPastDue.every(Number.isSafeInteger)) return null;
      if (typeof entry.destinationLast4 !== "string") return null;
      if (entry.subject !== null && !text(entry.subject)) return null;
      if (entry.channel === "email" && !text(entry.subject)) return null;
    }
    // One request hash may appear only once. A duplicate is a second message.
    const hashes = new Set(m.entries.map(entry => entry.requestSha256));
    if (hashes.size !== m.entries.length) return null;
    if (catchupManifestSha256(m) !== m.manifestSha256) return null;
    return buildCatchupManifest(m);
  } catch { return null; }
}

declare const approvalBrand: unique symbol;
/** Opaque on purpose: an object literal cannot stand in for an approval. */
export type CatchupApproval = Readonly<{ kind: "catchup-approved-manifest"; readonly [approvalBrand]: true }>;

const approved = new WeakMap<CatchupApproval, CatchupApprovalManifest>();
/** Consumed request hashes, so one approval cannot send one message twice. */
const spent = new WeakMap<CatchupApproval, Set<string>>();

export type CatchupApprovalResult = Readonly<{
  state: "approved" | "held";
  approval: CatchupApproval | null;
  reasons: readonly string[];
  messages: number;
}>;

/**
 * Turns a read manifest plus the owner's named hash into an approval.
 *
 * The hash is the whole point: it is the owner saying "this exact set". A
 * mismatch is not a typo to be forgiven, because the thing being approved is
 * which messages go to which customers.
 */
export function approveCatchupManifest(
  manifest: CatchupApprovalManifest | null, approvedSha256: unknown,
): CatchupApprovalResult {
  const reasons: string[] = [];
  if (!manifest) reasons.push("manifest_missing_or_unreadable");
  if (!hex64(approvedSha256)) reasons.push("approval_hash_missing_or_malformed");
  if (manifest && hex64(approvedSha256) && approvedSha256 !== manifest.manifestSha256) {
    reasons.push("approval_hash_does_not_match_this_manifest");
  }
  if (reasons.length || !manifest) {
    return Object.freeze({ state: "held", approval: null, reasons: Object.freeze([...reasons].sort()), messages: 0 });
  }
  const handle = Object.freeze({ kind: "catchup-approved-manifest" }) as CatchupApproval;
  approved.set(handle, manifest);
  spent.set(handle, new Set<string>());
  return Object.freeze({ state: "approved", approval: handle, reasons: Object.freeze([]), messages: manifest.entries.length });
}

/** The manifest behind an approval, for reporting. Null for a forged handle. */
export function catchupApprovedManifest(approval: CatchupApproval): CatchupApprovalManifest | null {
  return approved.get(approval) ?? null;
}

/** Is this exact request approved, and not already attempted? Does not consume. */
export function catchupApprovalCovers(approval: CatchupApproval, requestSha256: string): boolean {
  const manifest = approved.get(approval);
  if (!manifest || !hex64(requestSha256)) return false;
  if (spent.get(approval)?.has(requestSha256)) return false;
  return manifest.entries.some(entry => entry.requestSha256 === requestSha256);
}

/**
 * Claims this request for its ONE attempt.
 *
 * Consumes before the attempt, not after, so a crash mid-send cannot read as
 * "never tried" and send the customer a second copy.
 */
export function claimCatchupAttempt(approval: CatchupApproval, requestSha256: string): boolean {
  if (!catchupApprovalCovers(approval, requestSha256)) return false;
  spent.get(approval)!.add(requestSha256);
  return true;
}

/** The approved entry, for the run's own record. */
export function catchupAttestationFor(
  approval: CatchupApproval, requestSha256: string,
): CatchupAttestation | null {
  return approved.get(approval)?.entries.find(entry => entry.requestSha256 === requestSha256) ?? null;
}
