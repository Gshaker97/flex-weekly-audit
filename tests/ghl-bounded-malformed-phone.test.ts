import test from "node:test";
import assert from "node:assert/strict";
import { boundedMalformedUsPhoneDigits, canonicalPhone, matchPhoneCustomer, phoneMayShareOwner } from "../lib/ghl-phone-match";
import { strictGhlIdentityHold, verifyFreshGhlIdentity } from "../lib/ghl-write-identity";
const owner = { jobberClientId: "owner", email: "owner@example.test", phone: "+16025550100" };
const selected = { id: "selected", email: owner.email, phone: owner.phone };
const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
const disjoint = "+11025550199";
const overlapping = "+11025550100";

test("only observed invalid-area-code full form receives bounded classification, never canonical match", () => {
  assert.equal(boundedMalformedUsPhoneDigits(disjoint), "11025550199");
  assert.equal(canonicalPhone(disjoint), null);
  assert.equal(matchPhoneCustomer({ ...owner, phone: disjoint }, [owner], [{ id: "bad", phone: disjoint }]).contactId, null);
  for (const value of ["11025550199", "+1 1025550199", "+11021550199", "+1102555019", "+110255501999", "+11025550199 ext 1", "+11025550199x", "+44025550199", "unknown", ": 102-555-0199"]) {
    assert.equal(boundedMalformedUsPhoneDigits(value), null, value);
  }
  assert.equal(canonicalPhone(": 602-555-0100"), owner.phone);
});

test("bounded malformed numbers retain suffix conflicts but cannot select a contact", () => {
  assert.equal(phoneMayShareOwner(overlapping, owner.phone), true);
  assert.equal(phoneMayShareOwner(disjoint, owner.phone), false);
  assert.equal(matchPhoneCustomer(owner, [owner], [{ id: "bad", phone: overlapping }]).contactId, null);
  assert.equal(matchPhoneCustomer(owner, [owner], [selected, { id: "bad", phone: overlapping }]).contactId, null);
  assert.equal(matchPhoneCustomer(owner, [owner], [selected, { id: "bad", phone: disjoint }]).contactId, selected.id);
});

for (const [label, number, held] of [["disjoint", disjoint, false], ["suffix", overlapping, true], ["unknown", "unparsed phone", true]] as const) {
  test(`${label} competing primary/secondary phones are scoped consistently in all ownership branches`, () => {
    const otherOwner = { jobberClientId: "other", phone: number };
    const otherFresh = { id: "other", emails: [], phones: [{ number, primary: false }] };
    for (const otherContact of [{ id: "other", phone: number }, { id: "other", additionalPhones: [{ phone: number }] }]) {
      assert.equal(strictGhlIdentityHold(owner, [owner], [selected, otherContact], selected.id) !== null, held);
      assert.equal(verifyFreshGhlIdentity(owner, [owner], [selected, otherContact], selected.id, [fresh]) !== null, held);
    }
    assert.equal(strictGhlIdentityHold(owner, [owner, otherOwner], [selected], selected.id) !== null, held);
    assert.equal(verifyFreshGhlIdentity(owner, [owner], [selected], selected.id, [fresh, otherFresh]) !== null, held);
  });
}

test("selected/source malformed numbers and omitted owners remain held", () => {
  assert.notEqual(strictGhlIdentityHold(owner, [owner], [{ ...selected, phone: disjoint }], selected.id), null);
  assert.notEqual(strictGhlIdentityHold({ ...owner, phone: disjoint }, [owner], [selected], selected.id), null);
  assert.notEqual(verifyFreshGhlIdentity(owner, [owner], [selected], selected.id, [{ ...fresh, phones: [...fresh.phones, { number: disjoint, primary: false }] }]), null);
  assert.equal(verifyFreshGhlIdentity(owner, [owner, { jobberClientId: "omitted" }], [selected], selected.id, [fresh]), "Fresh Jobber identity snapshot omits a cached owner");
});

test("real email/secondary/canonical collisions and malformed field shapes remain held", () => {
  for (const other of [
    { id: "other", phone: disjoint, email: owner.email },
    { id: "other", phone: disjoint, additionalEmails: [{ email: owner.email }] },
    { id: "other", phone: disjoint, additionalPhones: [{ phone: owner.phone }] },
    { id: "other", additionalPhones: "unknown" as any },
  ]) assert.notEqual(strictGhlIdentityHold(owner, [owner], [selected, other], selected.id), null);
  assert.notEqual(strictGhlIdentityHold(owner, [owner, { jobberClientId: "other", email: owner.email, phone: disjoint }], [selected], selected.id), null);
});

test("independent email-only and phone-only identity checks remain usable", () => {
  assert.equal(strictGhlIdentityHold({ ...owner, phone: null }, [{ ...owner, phone: null }], [{ ...selected, phone: null }, { id: "bad", phone: disjoint }], selected.id), null);
  assert.equal(strictGhlIdentityHold({ ...owner, email: null }, [{ ...owner, email: null }], [{ ...selected, email: null }, { id: "bad", phone: disjoint }], selected.id), null);
});
