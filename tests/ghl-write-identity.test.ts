import test from "node:test";
import assert from "node:assert/strict";
import { readFreshJobberIdentities, strictGhlIdentityHold, verifyFreshGhlIdentity } from "../lib/ghl-write-identity";
import { prisma } from "../lib/prisma";

const owner = { jobberClientId: "owner", email: "one@example.test", phone: "+16025550100" };
const contact = { id: "contact", email: owner.email, phone: owner.phone };
const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
(prisma.jobberAuth as any).findFirst = async () => ({ accessToken: "synthetic", expiresAt: new Date(Date.now() + 3600000) });

test("fresh primary and secondary fields are included, paginated and never incremental", async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init: any) => {
    const body = JSON.parse(init.body); assert.match(body.query, /emails \{ address primary \}/); assert.match(body.query, /phones \{ number primary \}/);
    assert.doesNotMatch(body.query, /filter|updatedAt|\bname\b/);
    if (++calls === 1) return Response.json({ data: { clients: { nodes: [fresh], pageInfo: { hasNextPage: true, endCursor: "next" } } } });
    assert.equal(body.variables.after, "next");
    return Response.json({ data: { clients: { nodes: [{ ...fresh, id: "other" }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  };
  assert.equal((await readFreshJobberIdentities()).length, 2); assert.equal(calls, 2);
});
for (const [label, connection] of Object.entries({
  "partial": { nodes: [fresh], pageInfo: { hasNextPage: true, endCursor: null } },
  "duplicate": { nodes: [fresh, fresh], pageInfo: { hasNextPage: false } },
  "missing emails": { nodes: [{ ...fresh, emails: undefined }], pageInfo: { hasNextPage: false } },
  "unknown secondary": { nodes: [{ ...fresh, phones: [{ number: null, primary: false }] }], pageInfo: { hasNextPage: false } },
  "ambiguous primary": { nodes: [{ ...fresh, emails: [...fresh.emails, { address: "second@example.test", primary: true }] }], pageInfo: { hasNextPage: false } },
  "repeated cursor": { nodes: [fresh], pageInfo: { hasNextPage: true, endCursor: "again" } },
})) test(`fresh identity snapshot holds ${label}`, async () => {
  globalThis.fetch = async () => Response.json({ data: { clients: connection } });
  await assert.rejects(readFreshJobberIdentities());
});
test("new source-only secondary identity conflicts hold even when cached owners look unique", () => {
  assert.equal(verifyFreshGhlIdentity(owner, [owner], [contact], contact.id, [fresh]), null);
  for (const other of [
    { id: "new", emails: [{ address: owner.email, primary: false }], phones: [] },
    { id: "new", emails: [], phones: [{ number: "6025550100", primary: false }] },
  ]) assert.match(verifyFreshGhlIdentity(owner, [owner], [contact], contact.id, [fresh, other])!, /ownership conflict/);
});
test("a fresh secondary source identifier selecting another GHL contact is held", () => {
  const source = [{ ...fresh, emails: [...fresh.emails, { address: "secondary@example.test", primary: false }] }];
  assert.match(verifyFreshGhlIdentity(owner, [owner], [contact, { id: "other", email: "secondary@example.test" }], contact.id, source)!, /another GHL contact/);
});
test("unknown GHL secondary arrays hold the complete snapshot", () => {
  assert.match(strictGhlIdentityHold(owner, [owner], [contact, { id: "other", additionalPhones: "unknown" as any }], contact.id)!, /shape is unverified/);
});

test("selected secondary seven-digit suffix never disappears from ownership checks", () => {
  const emailOwner = { ...owner, phone: null };
  const selected = { ...contact, phone: null, additionalPhones: [{ phone: "5550100" }] };
  const other = { jobberClientId: "other", email: "other@example.test", phone: "+16025550100" };
  const ownFresh = { ...fresh, phones: [] };
  const otherFresh = { id: "other", emails: [{ address: other.email, primary: true }], phones: [{ number: other.phone, primary: true }] };
  assert.notEqual(strictGhlIdentityHold(emailOwner, [emailOwner, other], [selected], selected.id), null);
  assert.notEqual(verifyFreshGhlIdentity(emailOwner, [emailOwner, other], [selected], selected.id, [ownFresh, otherFresh]), null);
});
test("absent and unsupported primary phones cannot compare equal through null canonical values", () => {
  const emailOwner = { ...owner, phone: null };
  const selected = { ...contact, phone: null };
  for (const number of ["unparsed phone", "5550100", "+16025550100 ext 2"]) {
    assert.notEqual(verifyFreshGhlIdentity(emailOwner, [emailOwner], [selected], selected.id,
      [{ ...fresh, phones: [{ number, primary: true }] }]), null);
  }
});
test("fresh secondary suffix collision and selected duplicate phone both hold", () => {
  const other = { id: "other", emails: [], phones: [{ number: "5550100", primary: false }] };
  assert.notEqual(verifyFreshGhlIdentity(owner, [owner], [contact], contact.id, [fresh, other]), null);
  const emailOwner = { ...owner, phone: null };
  assert.notEqual(strictGhlIdentityHold(emailOwner, [emailOwner], [contact, { id: "duplicate-phone", phone: contact.phone }], contact.id), null);
});
