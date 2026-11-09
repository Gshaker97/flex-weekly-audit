import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPhone, matchPhoneCustomer } from '../lib/ghl-phone-match';
import { canonicalPhone as previewCanonical } from '../scripts/ghl-preview/phone-match';
import { strictGhlIdentityHold, verifyFreshGhlIdentity } from '../lib/ghl-write-identity';
const owner={jobberClientId:'synthetic-owner',email:null,phone:': 602-555-0100'};
const contact={id:'synthetic-contact',email:null,phone:'+16025550100'};
test('exact colon-space valid US wrapper normalizes, malformed wrappers do not',()=>{
 for(const normalize of [canonicalPhone,previewCanonical]){
  assert.equal(normalize(owner.phone),contact.phone);
  for(const bad of [':602-555-0100',':: 602-555-0100',':  602-555-0100',': 602- 555-0100',': 6025550100',': +1 602-555-0100',': 555-0100',': 102-555-0100',': 602-155-0100',': 602-555-01000','phone: 602-555-0100','602:555:0100',': 602-555-0100 x2',': 602-555-0100 / 602-555-0101',': 602–555–0100','+11025550100'])assert.equal(normalize(bad),null,bad);
 }
});
test('normalization never overrides duplicate or malformed global identity holds',()=>{
 assert.equal(matchPhoneCustomer(owner,[owner],[contact]).contactId,contact.id);
 assert.equal(matchPhoneCustomer(owner,[owner],[contact,{...contact,id:'duplicate'}]).contactId,null);
 assert.match(strictGhlIdentityHold(owner,[owner],[contact,{id:'invalid',phone:'+11025550199'}],contact.id)!,/overlap/);
 assert.match(verifyFreshGhlIdentity(owner,[owner,{jobberClientId:'omitted',phone:null,email:null}],[contact],contact.id,[{id:owner.jobberClientId,emails:[],phones:[{number:owner.phone,primary:true}]}])!,/omits/);
});
test('preview and runtime matching helpers stay identical',async()=>{
 const fs=await import('node:fs/promises');assert.equal(await fs.readFile(new URL('../lib/ghl-phone-match.ts',import.meta.url),'utf8'),await fs.readFile(new URL('../scripts/ghl-preview/phone-match.ts',import.meta.url),'utf8'));
});
