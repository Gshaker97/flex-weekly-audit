import test from "node:test";
import assert from "node:assert/strict";
import { planOpportunityDueDate } from "../lib/invoice-workflow-binding";
import { readDueDateField, repairOpportunityDueDate, dateRepairIntentHash, type DateRepairSnapshot } from "../lib/ghl-opportunity-date-repair";
import { readOpportunity, setOpportunityDueDate } from "../lib/ghl";
import { writerFixture } from "./helpers/sync-writer-fixture";

const NOW = "2026-11-09T18:00:00.000Z";
function fixture(): DateRepairSnapshot {
  return { now: NOW, source: { observedAt: NOW, complete: true, invoices: [{ id: "invoice-1", jobberClientId: "owner-1",
    status: "past_due", totalCents: 9800, balanceCents: 9800, issuedDate: "2026-10-26T23:03:18Z", dueDate: "2026-11-02T07:00:00Z", category: "maintenance" }] },
    card: { id: "opp-1", locationId: "loc-1", contactId: "contact-1", pipelineId: "pipe-1", stageId: "overdue", status: "open", amountCents: 9800, observedAt: NOW },
    binding: { locationId: "loc-1", contactId: "contact-1", opportunityId: "opp-1", pipelineId: "pipe-1", jobberClientId: "owner-1", invoiceId: "invoice-1",
      method: "unique_unpaid_invoice", evidenceRef: "synthetic-independent-evidence", identityVerified: true, uniqueInvoiceCardVerified: true },
    stageIds: { sent: "sent", overdue: "overdue" },
    field: { id: "date-1", locationId: "loc-1", model: "opportunity", key: "opportunity.due_date", type: "DATE", currentValueKnown: true, currentValue: "" },
    currentCard: { id: "opp-1", locationId: "loc-1", contactId: "contact-1", pipelineId: "pipe-1", pipelineStageId: "overdue", status: "open",
      monetaryValue: 98, name: "Synthetic", customFields: [{ id: "date-1", fieldValue: "" }, { id: "untouched", fieldValue: "unchanged" }] } };
}
function harness() {
  const snapshot = fixture(), f = writerFixture(), calls: string[] = [];
  const plan = planOpportunityDueDate(snapshot);
  const input = { approval: { approvalId: "synthetic-date-review", intentSha256: dateRepairIntentHash(plan.intent),
    expiresAt: "2026-11-09T18:30:00Z", effectsReviewedAt: NOW, workflowsRemainDraft: true, fieldUpdateEffectsReviewed: true },
    writer: f.writer, env: { GHL_WRITE_APPROVAL_ID: "synthetic-date-review", GHL_DUE_DATE_REPAIR_ENABLED: "true", GHL_APPROVED_OPPORTUNITY_IDS: '["opp-1"]' },
    now: () => new Date(NOW), verifyEffects: async () => true,
    readFresh: async () => { calls.push("fresh"); return structuredClone(snapshot); },
    transport: { update: async (_id:string,_field:string,_date:string) => { calls.push("PUT"); assert.equal(f.rows[0].status, "running"); assert.match(f.rows[0].errorMessage, /"state":"pending"/); },
      read: async () => { calls.push("readback"); const c=structuredClone(snapshot.currentCard);c.customFields![0].fieldValue="2026-11-02";return c; } } };
  return { input, snapshot, f, calls };
}
test("exact blank-date repair uses durable intent, two fresh reads, one PUT and verified readback", async () => {
  const h=harness();const result=await repairOpportunityDueDate(h.input);
  assert.equal(result.state,"applied");assert.deepEqual(h.calls,["fresh","fresh","PUT","readback"]);
  assert.match(h.f.rows[0].errorMessage,/"dateField"/);assert.match(h.f.rows[0].errorMessage,/"state":"confirmed"/);
  await h.f.writer.finish("complete");
});
for (const [name, edit] of [
  ["stage mutation", (j:any)=>{j.target.stageId="paid"}],
  ["status mutation", (j:any)=>{j.target.status="won"}],
  ["money mutation", (j:any)=>{j.target.amountCents=0}],
  ["name mutation", (j:any)=>{j.target.updateName=true}],
  ["wrong invoice due date", (j:any)=>{j.dateField.targetValue="2026-11-03"}],
  ["contact date key", (j:any)=>{j.dateField.key="contact.due_date"}],
  ["nonblank overwrite", (j:any)=>{j.dateField.expectedValue="2026-11-01"}],
  ["other source invoice", (j:any)=>{j.dateField.invoiceId="missing"}],
] as const) test(`durable field journal rejects ${name}`,async()=>{
  const h=harness();await repairOpportunityDueDate(h.input);
  const journal=JSON.parse(h.f.rows[0].errorMessage.slice("FLEX_GHL_WRITE_JOURNAL_V1:".length));
  const intent=journal.writes[0].intent;edit(intent);const fresh=writerFixture();
  await assert.rejects(fresh.writer.prepare(intent));assert.equal(fresh.rows[0].status,"blocked");assert.equal(fresh.rows[0].errorMessage,null);
});
for (const [name, change] of [
  ["disabled",(h:ReturnType<typeof harness>)=>{h.input.env.GHL_DUE_DATE_REPAIR_ENABLED="false"}],
  ["wrong approval",(h:ReturnType<typeof harness>)=>{h.input.approval.approvalId="other"}],
  ["expired",(h:ReturnType<typeof harness>)=>{h.input.approval.expiresAt=NOW}],
  ["old effect review",(h:ReturnType<typeof harness>)=>{h.input.approval.effectsReviewedAt="2026-11-09T17:00:00Z"}],
  ["workflow active",(h:ReturnType<typeof harness>)=>{h.input.approval.workflowsRemainDraft=false}],
  ["unreviewed side effects",(h:ReturnType<typeof harness>)=>{h.input.approval.fieldUpdateEffectsReviewed=false}],
] as const) test(`${name}: no read or write`,async()=>{const h=harness();change(h);assert.equal((await repairOpportunityDueDate(h.input)).state,"held");assert.deepEqual(h.calls,[]);assert.equal(h.f.rows[0].errorMessage,null);});
test("cohort cannot be broadened by an intent hash",async()=>{const h=harness();h.input.env.GHL_APPROVED_OPPORTUNITY_IDS='["different"]';assert.equal((await repairOpportunityDueDate(h.input)).state,"held");assert.ok(!h.calls.includes("PUT"));});
test("a changed due date cannot reuse approval",async()=>{const h=harness();h.snapshot.source.invoices[0].dueDate="2026-11-03";assert.equal((await repairOpportunityDueDate(h.input)).state,"held");assert.equal(h.f.rows[0].errorMessage,null);});
test("missing provider field cannot be turned into a different explicit representation by the caller",async()=>{const h=harness();delete h.snapshot.currentCard.customFields;assert.equal((await repairOpportunityDueDate(h.input)).state,"held");assert.ok(!h.calls.includes("PUT"));});
test("saved Draft evidence cannot replace a current workflow read",async()=>{const h=harness();h.input.verifyEffects=async()=>false;assert.equal((await repairOpportunityDueDate(h.input)).state,"held");assert.deepEqual(h.calls,[]);});
test("workflow resumed after claim prevents field PUT and leaves operator hold",async()=>{const h=harness();let reads=0;h.input.verifyEffects=async()=>++reads===1;await assert.rejects(repairOpportunityDueDate(h.input));assert.ok(!h.calls.includes("PUT"));assert.equal(h.f.rows[0].status,"blocked");});
test("durable ownership is reasserted immediately before PUT",async()=>{const h=harness();let checks=0;const assertPending=h.input.writer.assertPending.bind(h.input.writer);h.input.writer.assertPending=async(id)=>{if(++checks===2)h.f.rows[0].status="blocked";return assertPending(id);};await assert.rejects(repairOpportunityDueDate(h.input));assert.equal(checks,2);assert.ok(!h.calls.includes("PUT"));});
test("loss of prepare commit acknowledgment never reaches provider",async()=>{const h=harness();h.f.loseNextCommit();await assert.rejects(repairOpportunityDueDate(h.input));assert.ok(!h.calls.includes("PUT"));assert.equal(h.f.rows[0].status,"blocked");assert.match(h.f.rows[0].errorMessage,/"dateField"/);});
test("source changes after durable claim block without PUT",async()=>{const h=harness();let n=0;h.input.readFresh=async()=>{const s=structuredClone(h.snapshot);if(n++)s.source.invoices[0].dueDate="2026-11-03";return s;};await assert.rejects(repairOpportunityDueDate(h.input));assert.ok(!h.calls.includes("PUT"));assert.equal(h.f.rows[0].status,"blocked");});
test("unknown PUT result is never retried or released",async()=>{const h=harness();h.input.transport.update=async()=>{h.calls.push("PUT");throw new Error("unknown timeout");};await assert.rejects(repairOpportunityDueDate(h.input));assert.equal(h.calls.filter(v=>v==="PUT").length,1);assert.equal(h.f.rows[0].status,"blocked");await assert.rejects(h.f.writer.finish("complete"));});
for(const kind of ["wrong_date","wrong_card","changed_stage","changed_money","changed_other_field"]){test(`post-write ${kind} remains unconfirmed`,async()=>{const h=harness();const read=h.input.transport.read;h.input.transport.read=async()=>{const c=await read();if(kind==="wrong_date")c.customFields![0].fieldValue="2026-11-03";if(kind==="wrong_card")c.id="other";if(kind==="changed_stage")c.pipelineStageId="paid";if(kind==="changed_money")c.monetaryValue=0;if(kind==="changed_other_field")c.customFields![1].fieldValue="changed";return c;};await assert.rejects(repairOpportunityDueDate(h.input));assert.equal(h.f.rows[0].status,"blocked");assert.match(h.f.rows[0].errorMessage,/"state":"pending"/);});}
test("complete field metadata validates model, location and response spelling",()=>{
  const s=fixture();const meta={customFields:[{id:"date-1",fieldKey:"opportunity.due_date",dataType:"DATE",model:"opportunity",locationId:"loc-1"}]};
  assert.equal(readDueDateField(meta,s.currentCard,"loc-1")?.currentValueKnown,true);
  s.currentCard.customFields=[];assert.equal(readDueDateField(meta,s.currentCard,"loc-1")?.currentValue,null);
  delete s.currentCard.customFields;assert.equal(readDueDateField(meta,s.currentCard,"loc-1")?.currentValue,null);
  s.currentCard.customFields=null as any;assert.equal(readDueDateField(meta,s.currentCard,"loc-1"),null);
  s.currentCard.customFields=[{id:"date-1",field_value:""} as any];assert.equal(readDueDateField(meta,s.currentCard,"loc-1"),null);
  s.currentCard=fixture().currentCard;meta.customFields[0].model="contact";assert.equal(readDueDateField(meta,s.currentCard,"loc-1"),null);
});
test("real HTTP adapter pins existing API and sends only one field, never status/stage/money",async()=>{
  process.env.GHL_API_KEY="synthetic";process.env.GHL_LOCATION_ID="loc-1";let calls=0;
  globalThis.fetch=async (url,init)=>{calls++;assert.equal(url,"https://services.leadconnectorhq.com/opportunities/opp-1");
    assert.equal((init?.headers as any).Version,"2021-07-28");assert.equal(init?.method,"PUT");
    assert.deepEqual(JSON.parse(String(init?.body)),{customFields:[{id:"date-1",field_value:"2026-11-02"}]});return new Response("{}",{status:200});};
  await setOpportunityDueDate("opp-1","date-1","2026-11-02");assert.equal(calls,1);
  for(const date of ["2026-02-29","not-date","2026-11-02T00:00:00Z"])await assert.rejects(setOpportunityDueDate("opp-1","date-1",date));
  assert.equal(calls,1);
});
test("field mutation 429 is not automatically replayed",async()=>{process.env.GHL_API_KEY="synthetic";let count=0;globalThis.fetch=async()=>{count++;return new Response("{}",{status:429});};await assert.rejects(setOpportunityDueDate("opp-1","date-1","2026-11-02"),/review outcome/);assert.equal(count,1);});
test("full opportunity GET retains fieldValue contract and exact ID",async()=>{process.env.GHL_API_KEY="synthetic";globalThis.fetch=async()=>new Response(JSON.stringify({opportunity:fixture().currentCard}),{status:200});assert.deepEqual((await readOpportunity("opp-1")).customFields,fixture().currentCard.customFields);await assert.rejects(readOpportunity("other"),/readback/);});
test("verified sparse full-card date contract journals null and preserves omitted other fields",async()=>{const h=harness();delete h.snapshot.currentCard.customFields;h.snapshot.field.currentValue=null;h.input.approval.intentSha256=dateRepairIntentHash(planOpportunityDueDate(h.snapshot).intent);h.input.transport.read=async()=>({...h.snapshot.currentCard,customFields:[{id:"date-1",fieldValue:"2026-11-02"}]});assert.equal((await repairOpportunityDueDate(h.input)).state,"applied");assert.match(h.f.rows[0].errorMessage,/"expectedValue":null/);});
test("unavailable fresh identity before admission holds repair without blocking cache sync",async()=>{const h=harness();h.input.readFresh=async()=>{throw new Error("identity unavailable")};const r=await repairOpportunityDueDate(h.input);assert.equal(r.state,"held");assert.equal(h.f.rows[0].status,"running");assert.equal(h.f.rows[0].errorMessage,null);assert.ok(!h.calls.includes("PUT"));});
