/** Disabled-by-default, single exact date request inside an admitted cron run.
 * Not a general write endpoint or notification activation mechanism.
 */
import { createHash } from "node:crypto";
import { repairOpportunityDueDate, type DateRepairApproval } from "./ghl-opportunity-date-repair";
import { readVerifiedDateRepairSnapshot, verifyCurrentWorkflowPauses,
  type DateReadinessScope, type WorkflowPauseExpectation } from "./ghl-date-readiness";
import type { SyncEntrypoint, SyncRunWriter } from "./sync-writer-control";

export type ConfiguredDateRequest = { version: 1; scope: DateReadinessScope;
  approval: DateRepairApproval; workflows: WorkflowPauseExpectation[] };
const defaults = { repair: repairOpportunityDueDate, read: readVerifiedDateRepairSnapshot, effects: verifyCurrentWorkflowPauses };
export async function runConfiguredDateRepair(input: {
  entrypoint: SyncEntrypoint; writer: SyncRunWriter;
  env?: Record<string, string | undefined>; deps?: typeof defaults;
}) {
  const env = { ...(input.env ?? process.env) }, deps = input.deps ?? defaults;
  if (env.GHL_DUE_DATE_REPAIR_ENABLED !== "true") return { state: "disabled" as const };
  const held = (reason: string) => ({ state: "held" as const, reason });
  if (input.entrypoint !== "standalone_cron" || env.SYNC_ADMISSION_MODE !== "cron_only"
      || env.GHL_INVOICE_WRITE_MODE !== "review" || env.GHL_PHONE_WRITES_ENABLED !== "false") {
    return held("date_repair_requires_cron_only_and_other_GHL_writes_held");
  }
  const raw = env.GHL_DUE_DATE_REPAIR_REQUEST;
  if (!raw || Buffer.byteLength(raw, "utf8") > 16384
      || createHash("sha256").update(raw).digest("hex") !== env.GHL_DUE_DATE_REPAIR_REQUEST_SHA256) {
    return held("exact_reviewed_date_request_missing_or_changed");
  }
  let request: ConfiguredDateRequest;
  try { request = JSON.parse(raw); } catch { return held("date_request_invalid"); }
  if (request?.version !== 1 || !request.scope || !request.approval || !Array.isArray(request.workflows)
      || request.workflows.length < 2 || request.workflows.length > 100
      || request.scope.locationId !== env.GHL_LOCATION_ID) return held("date_request_scope_invalid");
  // No caller-supplied snapshot or identity flag. The trusted adapter establishes
  // all source/card/field evidence afresh and preserves existing identity holds.
  return deps.repair({ approval: request.approval, writer: input.writer, env,
    readFresh: () => deps.read(request.scope),
    verifyEffects: () => deps.effects(request.scope.locationId, request.workflows) });
}
