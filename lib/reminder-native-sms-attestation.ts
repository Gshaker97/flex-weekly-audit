/**
 * The dated human attestation the overlap guard needs, because GoHighLevel's
 * API cannot report whether a contact is enrolled in a workflow.
 *
 * READ THIS BEFORE CHANGING THE NUMBERS. Every field is something a person
 * looked at in the GoHighLevel builder on the date below. Do not carry a value
 * forward because it "was true last time" — the guard holds on a stale
 * attestation on purpose, and that hold is the whole point.
 *
 * ===================================================================
 * WORKFLOW AUDIT, 2026-11-17. Every published workflow, actions opened.
 * ===================================================================
 * 16 published workflows (the API's own list). Fixed Automation is one; the
 * other fifteen were opened in the builder and every action read, because step
 * names in this account have already proved untrustworthy.
 *
 * NO ACTION ANYWHERE ADDS THE GATE TAG. Exactly two workflows add tags at all:
 *   1.1 New Leads IRRIGATION OFFER  adds  irrigation, wbnk
 *   1.1 New Leads YARD BUNDLES      adds  wbnk, yard bundle
 * Neither writes flex-native-paula-approved.
 *
 * NO "ADD TO WORKFLOW" ACTION EXISTS IN THE ACCOUNT. The only workflow-targeting
 * actions found are two REMOVE-from-workflow steps, and both target a 2.1 Bad
 * Timing workflow, not Fixed Automation.
 *
 * ONLY ONE OTHER PUBLISHED WORKFLOW TOUCHES THE INVOICE PIPELINE. "Add
 * opportunity Value for new client" triggers on an opportunity created in
 * Invoice Pipeline and writes the stage "Invoice Sent" — never "Invoice
 * Overdue", so it cannot satisfy Fixed Automation's stage filter. Every other
 * opportunity write goes to Flexx Landscaping Leads, Joes Pipeline, WBNK Leads
 * or WBNK Packages.
 *
 * THE OVERDUE FOLDER HOLDS NOTHING ELSE LIVE. "Late Fee Text Notifications
 * Workflow" and "Late Fee Text Notifications - CLEAN REBUILD" are both DRAFT.
 *
 * NO NON-TRIGGER ENROLMENT HAS HAPPENED. Fixed Automation's enrolment history
 * filtered to eventType=added_to_workflow over the full 60-day window GoHighLevel
 * retains returns "No enrollments found".
 *
 * THE ONE BYPASS THAT CONFIGURATION CANNOT RULE OUT is a person adding a contact
 * to the workflow by hand in the GoHighLevel UI, and a contact enrolled while
 * tagged who is untagged afterwards — the trigger filters are read at entry
 * only. Neither is visible in any workflow's configuration. Both are visible in
 * Fixed Automation's per-contact enrolment panel, which is why `clearances`
 * below is per contact and must be read on the send day.
 */
import type { NativeSmsAttestation } from "./reminder-native-sms-overlap";

export const NATIVE_SMS_ATTESTATION_2026_11_17: NativeSmsAttestation = {
  reviewedOn: "2026-11-17",
  publishedWorkflowCount: 16,
  noOtherEnrolmentPath: true,
  // Filled on the send day, one entry per candidate contact, from the panel.
  clearances: [],
};
