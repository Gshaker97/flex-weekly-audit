/**
 * The dated human attestation the overlap guard needs, because GoHighLevel's
 * API cannot report whether a contact is enrolled in a workflow.
 *
 * READ THIS BEFORE CHANGING THE NUMBERS. Every field is something a person
 * looked at in the GoHighLevel builder on the date below. Do not carry a value
 * forward because it "was true last time" — the guard holds on a stale
 * attestation on purpose, and that hold is the whole point.
 *
 * Verified 2026-11-17, in the Flexx location:
 *  - 16 published workflows (the API's own list).
 *  - The folder "Overdue Automations" holds three workflows. Fixed Automation
 *    is the only PUBLISHED one; "Late Fee Text Notifications Workflow" and
 *    "Late Fee Text Notifications - CLEAN REBUILD" are both DRAFT and therefore
 *    cannot run.
 *  - Fixed Automation's trigger stats panel states the entry condition in
 *    GoHighLevel's own words: In pipeline is "invoice pipeline" AND Pipeline
 *    stage is "invoice overdue" AND Tag is "flex-native-paula-approved".
 *    That is one trigger with three required filters, so the tag is an
 *    allow-list on the only entry point, for BOTH the irrigation and the
 *    maintenance branch. Neither branch has an entry point of its own.
 *
 * NOT ESTABLISHED, AND DELIBERATELY NOT ASSERTED HERE:
 *  - activeEnrolments. Fixed Automation's enrolment history is capped at the
 *    last 60 days by GoHighLevel, and the workflow-wide "currently active"
 *    figure could not be read reliably in the available viewport. It is left
 *    unread, which HOLDS, and must be read on the send day.
 *  - noOtherEnrolmentPath. Confirming that none of the other 15 published
 *    workflows adds the gate tag or pushes a contact straight into Fixed
 *    Automation would mean opening every action in all of them, and step names
 *    in this account have already proved untrustworthy (four steps labelled
 *    "Sarah - Day 21 ..." are internal notifications to a different person).
 *    So it is left false, which HOLDS.
 */
import type { NativeSmsAttestation } from "./reminder-native-sms-overlap";

export const NATIVE_SMS_ATTESTATION_2026_11_17: NativeSmsAttestation = {
  reviewedOn: "2026-11-17",
  publishedWorkflowCount: 16,
  activeEnrolments: -1,
  noOtherEnrolmentPath: false,
};
