/**
 * The deliberate "code elsewhere" that `notification-internal-task.ts` names:
 * the one place where an internal task actually reaches GoHighLevel.
 *
 * That module builds and validates the request and cannot send it. This module
 * is the write, kept apart on purpose so that reading the builder never leaves
 * any doubt about whether importing it can create something in a colleague's
 * task list. Importing THIS file is still inert; only calling bootstrap and then
 * `create` under the "one-attempt" action performs a write.
 *
 * It follows the Day 15 sender's discipline exactly, for the same reasons:
 *
 *   ONE ATTEMPT, NEVER A RETRY. A task has no idempotency key, so a replayed
 *   POST is a second task in someone's list. A 429, a timeout and a 500 are all
 *   final here; an uncertain attempt is reported as uncertain and left for a
 *   person, never resolved by trying again.
 *
 *   THE BOUNDARY IS NARROWED BEFORE THE CALL. `action: "read-only"` means no
 *   POST leaves this process at all, whatever it is asked to do. Under
 *   "one-attempt" the only POST allowed is to this contact's own tasks route.
 *
 *   CONFIRMATION COMES FROM A READ, NOT FROM THE 201. The same rule the texts
 *   follow: our own success response is evidence that GoHighLevel accepted the
 *   request, not that the task exists. `created_and_confirmed` is only returned
 *   when a separate GET finds the task by id on the contact.
 *
 * Nothing here refreshes a token, writes to Jobber, touches the ledger, changes
 * a setting, runs a migration, or edits a workflow.
 */
import { verifyDay10DeploymentHolds } from "./notification-day10-runtime";
import {
  constructInternalTask, INTERNAL_TASK_CONTRACT,
  type InternalTaskRequest, type InternalTaskDescriptor,
} from "./notification-internal-task";

const TIMEOUT_MS = 10_000;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export type InternalTaskRuntimeScope = Readonly<{
  /** Must match the deployed GHL_LOCATION_ID, or the holds check refuses. */
  locationId: string;
  /** "read-only" cannot write at all. "one-attempt" permits exactly one POST per call. */
  action: "read-only" | "one-attempt";
  /** ISO instant after which this runtime refuses everything. */
  expiresAt: string;
  service?: "pilot" | "recurring-cron";
}>;

export type InternalTaskOutcome = Readonly<{
  /**
   * held                   nothing was contacted.
   * attempted_unconfirmed  a POST went out and we cannot prove the result. A
   *                        person must look; this is never retried.
   * created_and_confirmed  the task was read back from GoHighLevel by id.
   */
  state: "held" | "attempted_unconfirmed" | "created_and_confirmed";
  reasons: readonly string[];
  httpStatus: number | null;
  taskId: string | null;
  /** What was sent, for the audit trail. Never carries the credential. */
  descriptor: InternalTaskDescriptor | null;
}>;

export type InternalTaskRuntime = Readonly<{
  create(request: InternalTaskRequest): Promise<InternalTaskOutcome>;
  /** Read-only: the tasks currently on a contact, for verification. */
  list(contactId: string): Promise<readonly { id: string; title: string; completed: boolean }[]>;
}>;

const outcome = (
  state: InternalTaskOutcome["state"], reasons: readonly string[],
  httpStatus: number | null = null, taskId: string | null = null,
  descriptor: InternalTaskDescriptor | null = null,
): InternalTaskOutcome =>
  Object.freeze({ state, reasons: Object.freeze([...new Set(reasons)].sort()), httpStatus, taskId, descriptor });

/** One request. No retry on any status, including 429, and no redirect followed. */
async function onceOnly(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    if (response.redirected || response.url !== url) throw new Error("internal_task_redirect_or_url_mismatch");
    return { status: response.status, text: (await response.text()).slice(0, 20_000) };
  } finally {
    clearTimeout(timer);
  }
}

/** GoHighLevel has returned the task under several envelopes; accept only a usable id. */
function taskIdFrom(text: string): string | null {
  let body: any;
  try { body = JSON.parse(text); } catch { return null; }
  const id = body?.id ?? body?.task?.id ?? body?.data?.id ?? null;
  return typeof id === "string" && ID.test(id) ? id : null;
}

export function bootstrapInternalTaskRuntime(scope: InternalTaskRuntimeScope): InternalTaskRuntime {
  if (!["read-only", "one-attempt"].includes(scope?.action) || !scope?.locationId)
    throw new Error("explicit_exact_runtime_scope_required");
  const service = scope.service ?? "pilot";
  if (!["pilot", "recurring-cron"].includes(service)) throw new Error("explicit_exact_runtime_scope_required");
  verifyDay10DeploymentHolds(process.env, scope.locationId, service);

  // Pin the configuration this runtime was authorized against. If any of it
  // changes underneath us mid-run, every later call refuses.
  const pinned = Object.fromEntries(["RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_DEPLOYMENT_ID",
    "GHL_LOCATION_ID", "GHL_API_KEY"].map(key => [key, process.env[key]]));
  const credential = process.env.GHL_API_KEY as string;

  const verify = () => {
    verifyDay10DeploymentHolds(process.env, scope.locationId, service);
    if (!Number.isFinite(Date.parse(scope.expiresAt)) || Date.now() >= Date.parse(scope.expiresAt) ||
        Object.entries(pinned).some(([key, value]) => process.env[key] !== value))
      throw new Error("internal_task_runtime_configuration_changed_or_expired");
  };
  verify();

  const auth = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${credential}`,
    Version: INTERNAL_TASK_CONTRACT.version,
    Accept: "application/json",
    ...extra,
  });

  const tasksUrl = (contactId: string) =>
    INTERNAL_TASK_CONTRACT.baseUrl +
    INTERNAL_TASK_CONTRACT.pathTemplate.replace("{contactId}", encodeURIComponent(contactId));

  const list: InternalTaskRuntime["list"] = async contactId => {
    verify();
    if (typeof contactId !== "string" || !ID.test(contactId)) throw new Error("contact_id_unusable");
    const { status, text } = await onceOnly(tasksUrl(contactId), { method: "GET", headers: auth() });
    if (status !== 200) throw new Error(`internal_task_list_http_${status}`);
    let body: any;
    try { body = JSON.parse(text); } catch { throw new Error("internal_task_list_unreadable"); }
    const rows: any[] = Array.isArray(body) ? body : Array.isArray(body?.tasks) ? body.tasks : [];
    return Object.freeze(rows
      .filter(row => typeof row?.id === "string")
      .map(row => Object.freeze({
        id: row.id as string,
        title: typeof row.title === "string" ? row.title : "",
        completed: row.completed === true,
      })));
  };

  const create: InternalTaskRuntime["create"] = async request => {
    verify();
    if (scope.action !== "one-attempt") return outcome("held", ["runtime_is_read_only"]);

    // The builder is the only thing that decides what a task says and who owns
    // it. Nothing here can fill in a missing assignee or reword a task.
    const built = constructInternalTask(request);
    if (built.state !== "constructed_disabled" || !built.descriptor)
      return outcome("held", built.reasons.length ? built.reasons : ["task_request_not_constructible"]);

    const descriptor = built.descriptor;
    if (descriptor.method !== "POST" || descriptor.url !== tasksUrl(request.contactId))
      return outcome("held", ["internal_task_route_not_allowed"]);

    verify();
    let status: number, text: string;
    try {
      ({ status, text } = await onceOnly(descriptor.url, {
        method: "POST",
        headers: auth({ "Content-Type": "application/json" }),
        body: descriptor.serializedBody,
      }));
    } catch (error: any) {
      // A timeout or an aborted socket means the task may or may not exist.
      // Say so and stop: a second POST would risk a duplicate in her list.
      return outcome("attempted_unconfirmed",
        ["internal_task_attempt_outcome_unknown", String(error?.name ?? "error")], null, null, descriptor);
    }

    if (status < 200 || status >= 300)
      return outcome("attempted_unconfirmed", [`internal_task_http_${status}`], status, null, descriptor);

    const taskId = taskIdFrom(text);
    if (!taskId)
      return outcome("attempted_unconfirmed", ["internal_task_accepted_without_a_readable_id"], status, null, descriptor);

    // The 201 is not the proof. Go and look.
    try {
      verify();
      const found = (await list(request.contactId)).some(row => row.id === taskId);
      return found
        ? outcome("created_and_confirmed", [], status, taskId, descriptor)
        : outcome("attempted_unconfirmed", ["internal_task_not_found_on_read_back"], status, taskId, descriptor);
    } catch (error: any) {
      return outcome("attempted_unconfirmed",
        ["internal_task_read_back_failed", String(error?.message ?? "error").slice(0, 120)], status, taskId, descriptor);
    }
  };

  return Object.freeze({ create, list });
}
