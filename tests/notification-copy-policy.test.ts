import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ORIGINAL_DAY10_SMS_BODY, permitsUnknownCurrency } from "../lib/notification-copy-policy";
import { planNotification, type Request } from "../lib/notification-gate";
import { fixture, NOW } from "./fixtures/notification-fixture.mjs";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");
function staticRequest(): Request {
  const request = structuredClone(fixture()) as any;
  request.event.currency = null; request.event.bodyDigest = digest(ORIGINAL_DAY10_SMS_BODY);
  for (const evidence of [request.preflight, request.final]) {
    evidence.source.currency = null; evidence.template.bodyDigest = request.event.bodyDigest;
  }
  return request;
}
test("unknown currency is represented as null only for exact original non-monetary Day10 SMS", () => {
  const request = staticRequest(); assert.equal(permitsUnknownCurrency(request.event), true);
  assert.equal(planNotification(request, NOW).designStatus, "eligible_in_proposal");
});
for (const kind of ["altered digest", "day15", "email", "internal", "claimed fee", "undefined currency", "empty currency"])
  test(`the unknown-currency exception does not generalize to ${kind}`, () => {
    const request = structuredClone(staticRequest()) as any;
    if (kind === "altered digest") request.event.bodyDigest = digest(ORIGINAL_DAY10_SMS_BODY + " ");
    if (kind === "day15") request.event.dayPastDue = 15;
    if (kind === "email") request.event.channel = "email";
    if (kind === "internal") request.event.audience = "internal";
    if (kind === "claimed fee") request.event.claimedFacts = ["three_percent_fee_applied"];
    if (kind === "undefined currency") delete request.event.currency;
    if (kind === "empty currency") request.event.currency = "";
    const plan = planNotification(request, NOW);
    assert.equal(plan.designStatus, "hold"); assert.ok(plan.reasons.includes("invalid_event_binding"));
  });
test("static copy grants no template approval or positive-balance exemption", () => {
  const request = structuredClone(staticRequest()) as any; request.final.template.approved = false;
  assert.ok(planNotification(request, NOW).reasons.includes("final:template_not_exact_approved"));
  request.final.template.approved = true; request.final.source.balanceMinor = 0;
  const reasons = planNotification(request, NOW).reasons;
  assert.ok(reasons.includes("final:not_open_positive_balance")); assert.ok(reasons.includes("final:source_event_drift"));
});
