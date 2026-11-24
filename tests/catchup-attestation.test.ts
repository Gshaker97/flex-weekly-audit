import test from "node:test";
import assert from "node:assert/strict";
import {
  approveCatchupManifest, buildCatchupManifest, catchupApprovalCovers, catchupApprovedManifest,
  catchupAttestationFor, catchupManifestSha256, catchupRequestSha256, claimCatchupAttempt,
  parseCatchupManifest, CATCHUP_MANIFEST_VERSION,
  type CatchupApproval, type CatchupAttestation,
} from "../lib/catchup-attestation";

const SMS_BODY = "Hi Jessica, this is Flexx Landscaping. Our records show invoice #7272 is past due.";
const EMAIL_BODY = "Hi Jessica, invoice #7272 is past due. You can pay it here: https://example.test/x";

const entry = (over: Partial<CatchupAttestation> = {}): CatchupAttestation => ({
  requestSha256: catchupRequestSha256(JSON.stringify({ type: "SMS", message: SMS_BODY })),
  channel: "sms", clientName: "Jessica Noonan", invoiceNumbers: ["7272"],
  balanceMinorTotal: 9000, daysPastDue: [8], destinationLast4: "0100",
  subject: null, body: SMS_BODY, ...over,
});
const emailEntry = (over: Partial<CatchupAttestation> = {}): CatchupAttestation => entry({
  requestSha256: catchupRequestSha256(JSON.stringify({ type: "Email", html: EMAIL_BODY })),
  channel: "email", subject: "Invoice #7272 is 8 days past due", body: EMAIL_BODY, ...over,
});

const base = {
  preparedAt: "2026-11-24T16:45:00.000Z", sendDate: "2026-11-24",
  accountId: "flexx", locationId: "loc-1",
  smsSender: "+16028548131", emailSender: "preston@flexxlandscaping.com",
};
const manifest = (entries: CatchupAttestation[] = [entry(), emailEntry()]) =>
  buildCatchupManifest({ ...base, entries });

test("a built manifest hashes its own content and names its version", () => {
  const m = manifest();
  assert.equal(m.version, CATCHUP_MANIFEST_VERSION);
  assert.match(m.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(m.entries.length, 2);
  assert.equal(m.manifestSha256, catchupManifestSha256(m));
});

test("THE HASH DOES NOT DEPEND ON ENTRY ORDER", () => {
  // Otherwise the owner approves a hash and a reordered read of the same set
  // fails for no reason a person could explain.
  const a = manifest([entry(), emailEntry()]);
  const b = manifest([emailEntry(), entry()]);
  assert.equal(a.manifestSha256, b.manifestSha256);
});

test("the hash changes when the WORDS change", () => {
  const a = manifest([entry()]);
  const b = manifest([entry({ body: `${SMS_BODY} Call us.` })]);
  assert.notEqual(a.manifestSha256, b.manifestSha256);
});

test("the hash changes when the AMOUNT changes", () => {
  const a = manifest([entry()]);
  const b = manifest([entry({ balanceMinorTotal: 9900 })]);
  assert.notEqual(a.manifestSha256, b.manifestSha256);
});

test("A MANIFEST EDITED AFTER APPROVAL FAILS TO PARSE", () => {
  // The whole reason the hash is stored: one line changed, and the read refuses.
  const m = manifest();
  const tampered = { ...m, entries: [{ ...m.entries[0], balanceMinorTotal: 50_000 }, m.entries[1]] };
  assert.equal(parseCatchupManifest(tampered), null);
});

test("an extra message appended after approval fails to parse", () => {
  const m = manifest();
  const grown = { ...m, entries: [...m.entries, emailEntry({ requestSha256: "f".repeat(64), clientName: "Someone Else" })] };
  assert.equal(parseCatchupManifest(grown), null);
});

test("a manifest round-trips through JSON", () => {
  const m = manifest();
  const back = parseCatchupManifest(JSON.parse(JSON.stringify(m)));
  assert.ok(back);
  assert.equal(back?.manifestSha256, m.manifestSha256);
  assert.equal(back?.entries.length, 2);
});

test("a wrong version, an empty set, and a bad hash are all refused", () => {
  const m = manifest();
  assert.equal(parseCatchupManifest({ ...m, version: "something-else" }), null);
  assert.equal(parseCatchupManifest({ ...m, entries: [] }), null);
  assert.equal(parseCatchupManifest({ ...m, manifestSha256: "nope" }), null);
  assert.equal(parseCatchupManifest(null), null);
  assert.equal(parseCatchupManifest("a string"), null);
});

test("the same request hash twice is refused, because that is two messages", () => {
  const duplicated = manifest([entry(), entry()]);
  assert.equal(parseCatchupManifest(JSON.parse(JSON.stringify(duplicated))), null);
});

test("an email entry with no subject is refused", () => {
  const m = manifest([emailEntry({ subject: null })]);
  assert.equal(parseCatchupManifest(JSON.parse(JSON.stringify(m))), null);
});

test("APPROVAL REQUIRES THE EXACT HASH, and says so when it does not match", () => {
  const m = manifest();
  const wrong = approveCatchupManifest(m, "a".repeat(64));
  assert.equal(wrong.state, "held");
  assert.equal(wrong.approval, null);
  assert.ok(wrong.reasons.includes("approval_hash_does_not_match_this_manifest"), wrong.reasons.join(","));

  const malformed = approveCatchupManifest(m, "not-a-hash");
  assert.equal(malformed.state, "held");
  assert.ok(malformed.reasons.includes("approval_hash_missing_or_malformed"));

  const missing = approveCatchupManifest(null, m.manifestSha256);
  assert.equal(missing.state, "held");
  assert.ok(missing.reasons.includes("manifest_missing_or_unreadable"));

  const ok = approveCatchupManifest(m, m.manifestSha256);
  assert.equal(ok.state, "approved");
  assert.ok(ok.approval);
  assert.equal(ok.messages, 2);
  assert.deepEqual([...ok.reasons], []);
});

test("an approval covers exactly its own messages and nothing else", () => {
  const m = manifest();
  const approval = approveCatchupManifest(m, m.manifestSha256).approval!;
  assert.equal(catchupApprovalCovers(approval, m.entries[0].requestSha256), true);
  assert.equal(catchupApprovalCovers(approval, m.entries[1].requestSha256), true);
  assert.equal(catchupApprovalCovers(approval, "b".repeat(64)), false);
  assert.equal(catchupApprovalCovers(approval, "not-a-hash"), false);
});

test("ONE APPROVED MESSAGE MAY BE CLAIMED ONCE", () => {
  const m = manifest();
  const approval = approveCatchupManifest(m, m.manifestSha256).approval!;
  const hash = m.entries[0].requestSha256;
  assert.equal(claimCatchupAttempt(approval, hash), true, "first claim");
  assert.equal(claimCatchupAttempt(approval, hash), false, "a second claim is a second message");
  assert.equal(catchupApprovalCovers(approval, hash), false, "and it no longer reads as covered");
  // The other message is untouched.
  assert.equal(catchupApprovalCovers(approval, m.entries[1].requestSha256), true);
});

test("A FORGED APPROVAL COVERS NOTHING", () => {
  const m = manifest();
  const forged = Object.freeze({ kind: "catchup-approved-manifest" }) as unknown as CatchupApproval;
  assert.equal(catchupApprovedManifest(forged), null);
  assert.equal(catchupApprovalCovers(forged, m.entries[0].requestSha256), false);
  assert.equal(claimCatchupAttempt(forged, m.entries[0].requestSha256), false);
});

test("the approved entry is readable, so a run can report what it sent", () => {
  const m = manifest();
  const approval = approveCatchupManifest(m, m.manifestSha256).approval!;
  const found = catchupAttestationFor(approval, m.entries[0].requestSha256);
  assert.ok(found);
  assert.equal(found?.body, m.entries[0].body);
  assert.equal(catchupAttestationFor(approval, "c".repeat(64)), null);
});

test("the manifest carries only the last four of a destination", () => {
  const m = manifest();
  const serialized = JSON.stringify(m);
  assert.ok(!serialized.includes("+16025550100"), "no full phone number");
  assert.ok(!serialized.includes("@example.test"), "no full email address");
  assert.equal(m.entries[0].destinationLast4, "0100");
});
