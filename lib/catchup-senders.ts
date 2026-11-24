/**
 * WHERE THE REVIEWED SENDERS COME FROM, now that there is an approval.
 *
 * `lib/catchup-runner.ts` refuses to build a sender review from the
 * environment, and that stays true: a variable is not a person looking at a
 * sender and approving it. But a manifest IS. The owner reads a manifest that
 * states, in plain text at the top, which number the texts come from and which
 * address the emails come from, then approves it by naming its hash. That is a
 * person approving a sender for an exact set of messages, which is precisely
 * what the contract asks for and what an environment variable could never be.
 *
 * SO THE CHAIN IS: pinned policy -> manifest -> owner's hash -> sender review.
 * Both ends are checked. The manifest's senders must equal the addresses pinned
 * in `catchup-sender-policy.ts`, so an edited manifest cannot introduce a
 * sender nobody chose; and the approval must match the manifest, so the senders
 * cannot change after it is approved.
 *
 * WHAT IS STILL NOT PROVEN HERE. Whether `flexxlandscaping.com` is actually
 * verified for sending. No GoHighLevel endpoint reports it, so
 * `CATCHUP_EMAIL_SENDER.sendingDomainVerified` stays false and this module
 * reports it rather than deciding it. An unverified domain does not make a send
 * unsafe, it makes it likely to bounce or land in spam - a deliverability fact
 * the owner should know before approving, not a gate this code can close.
 */
import { CATCHUP_EMAIL_SENDER, CATCHUP_SMS_SENDER } from "./catchup-sender-policy";
import { CATCHUP_SMS_SUFFIX } from "./catchup-copy";
import { catchupApprovedManifest, type CatchupApproval } from "./catchup-attestation";
import { GHL_NOTIFICATION_CONTRACT } from "./notification-ghl-contract";
import type { CatchupReviewedSenders } from "./catchup-runner";

export type CatchupSenderAssembly = Readonly<{
  state: "assembled" | "held";
  senders: CatchupReviewedSenders | null;
  reasons: readonly string[];
  /** Reported, never enforced. See the note above. */
  emailSendingDomainVerified: boolean;
}>;

/**
 * Builds the reviewed sender objects for one approved manifest.
 *
 * `evidenceRef` on each review names the manifest hash, so an acceptance
 * recorded in the ledger can always be traced back to the exact approval it
 * came from.
 */
export function assembleCatchupSenders(
  approval: CatchupApproval,
  scope: Readonly<{ accountId: string; locationId: string }>,
): CatchupSenderAssembly {
  const reasons: string[] = [];
  const manifest = catchupApprovedManifest(approval);
  if (!manifest) reasons.push("approval_not_recognized");
  if (!scope?.accountId?.trim()) reasons.push("account_id_required");
  if (!scope?.locationId?.trim()) reasons.push("location_id_required");
  if (manifest && manifest.accountId !== scope?.accountId) reasons.push("manifest_account_mismatch");
  if (manifest && manifest.locationId !== scope?.locationId) reasons.push("manifest_location_mismatch");

  // The pinned policy is the other end of the chain. A manifest that names a
  // different sender is not a manifest for this batch.
  if (manifest && manifest.smsSender !== CATCHUP_SMS_SENDER.number) {
    reasons.push("manifest_sms_sender_is_not_the_pinned_sender");
  }
  if (manifest && manifest.emailSender !== CATCHUP_EMAIL_SENDER.address) {
    reasons.push("manifest_email_sender_is_not_the_pinned_sender");
  }

  if (reasons.length || !manifest) {
    return Object.freeze({ state: "held", senders: null,
      reasons: Object.freeze([...new Set(reasons)].sort()),
      emailSendingDomainVerified: CATCHUP_EMAIL_SENDER.sendingDomainVerified });
  }

  const ref = `catchup-manifest:${manifest.manifestSha256}`;
  const senderReview = (channel: "sms" | "email", sender: string) => Object.freeze({
    accountId: manifest.accountId, locationId: manifest.locationId, channel, sender,
    scope: GHL_NOTIFICATION_CONTRACT.writeScope,
    approved: true as const, validated: true as const, evidenceRef: ref,
  });
  const review = (channel: "sms" | "email") => Object.freeze({
    mode: "reviewed-construction-only" as const, version: GHL_NOTIFICATION_CONTRACT.version,
    accountId: manifest.accountId, locationId: manifest.locationId, channel,
    proposedStatus: "pending" as const, evidenceRef: ref,
  });

  return Object.freeze({
    state: "assembled",
    senders: Object.freeze({
      accountId: manifest.accountId, locationId: manifest.locationId,
      sms: Object.freeze({
        senderReview: senderReview("sms", manifest.smsSender),
        review: review("sms"),
        smsReceiptSuffixPolicy: Object.freeze({
          mode: "reviewed-exact-native-sms-suffix" as const,
          version: GHL_NOTIFICATION_CONTRACT.version, channel: "sms" as const, source: "app" as const,
          accountId: manifest.accountId, locationId: manifest.locationId,
          sender: manifest.smsSender, evidenceRef: ref,
          suffix: CATCHUP_SMS_SUFFIX,
        }),
      }),
      email: Object.freeze({
        senderReview: senderReview("email", manifest.emailSender),
        review: review("email"),
      }),
    }) as CatchupReviewedSenders,
    reasons: Object.freeze([]),
    emailSendingDomainVerified: CATCHUP_EMAIL_SENDER.sendingDomainVerified,
  });
}

/**
 * Sender objects for the PREPARE phase, built from the pinned policy alone.
 *
 * Preparation has to construct every request in order to hash it, but the
 * approval it will later be checked against does not exist yet. So this builds
 * the same senders with an evidence reference that says plainly what they are.
 *
 * THIS GRANTS NOTHING. `buildGhlMessageRequest` returns a descriptor with no
 * credential and nowhere to put one, and `lib/catchup-transport.ts` sends only
 * what an approved manifest names. Preparation can construct all day and reach
 * no customer.
 *
 * It is safe for the hash because the reviews are NOT part of the wire body -
 * only the provider's own fields are - so a request prepared with these senders
 * serializes to the same bytes as one sent with the approved senders. A test
 * asserts exactly that, because the whole design rests on it.
 */
export function catchupPreparationSenders(
  scope: Readonly<{ accountId: string; locationId: string }>,
): CatchupReviewedSenders {
  const ref = "catchup-preparation-only-constructs-nothing-sends";
  const senderReview = (channel: "sms" | "email", sender: string) => Object.freeze({
    accountId: scope.accountId, locationId: scope.locationId, channel, sender,
    scope: GHL_NOTIFICATION_CONTRACT.writeScope,
    approved: true as const, validated: true as const, evidenceRef: ref,
  });
  const review = (channel: "sms" | "email") => Object.freeze({
    mode: "reviewed-construction-only" as const, version: GHL_NOTIFICATION_CONTRACT.version,
    accountId: scope.accountId, locationId: scope.locationId, channel,
    proposedStatus: "pending" as const, evidenceRef: ref,
  });
  return Object.freeze({
    accountId: scope.accountId, locationId: scope.locationId,
    sms: Object.freeze({
      senderReview: senderReview("sms", CATCHUP_SMS_SENDER.number),
      review: review("sms"),
      smsReceiptSuffixPolicy: Object.freeze({
        mode: "reviewed-exact-native-sms-suffix" as const,
        version: GHL_NOTIFICATION_CONTRACT.version, channel: "sms" as const, source: "app" as const,
        accountId: scope.accountId, locationId: scope.locationId,
        sender: CATCHUP_SMS_SENDER.number, evidenceRef: ref, suffix: CATCHUP_SMS_SUFFIX,
      }),
    }),
    email: Object.freeze({
      senderReview: senderReview("email", CATCHUP_EMAIL_SENDER.address),
      review: review("email"),
    }),
  }) as CatchupReviewedSenders;
}
