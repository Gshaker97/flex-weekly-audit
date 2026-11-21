/**
 * The ladder's two INTERNAL steps: a task for a named member of staff, not a
 * message to a customer.
 *
 *   day 21  call the customer about the past-due invoice
 *   day 35  take the invoice to collections
 *
 * ANGIE HAS THIS ROLE. The written policy says "Sarah calls at 21 days" and the
 * existing Fixed Automation workflow still labels its four Day 21 steps
 * "Sarah - Day 21", but those steps all notify ANGIE, and there is no Sarah in
 * this GoHighLevel account at all (the users are Angie Wiggins, Danny Petrik,
 * Joe B, Matthew Flex and Preston Johnson). The account owner confirmed on
 * 2026-11-18: Angie replaced Sarah in the role. So "Sarah" in the policy and in
 * those step labels means whoever holds this role, which is Angie — it is a
 * stale name, not a second person, and nothing here should be read as having
 * reassigned anyone's work.
 *
 * DISABLED BY CONSTRUCTION, exactly like `notification-ghl-contract.ts`.
 * This module builds and validates the request; it holds no credential, has no
 * place to put one, and its descriptor carries no Authorization header. Calling
 * it cannot create a task. Making it create one would mean adding code
 * elsewhere, deliberately, which is the point: a task written into a real
 * colleague's list is an outward-facing act and should not be reachable by
 * accident.
 *
 * THAT DELIBERATE ELSEWHERE NOW EXISTS. `notification-internal-task-runtime.ts`
 * is the single place a task actually reaches GoHighLevel, and it keeps the same
 * discipline: it refuses to bootstrap outside the real deployment, sends no POST
 * at all under its "read-only" action, makes exactly one attempt and never
 * retries (a task has no idempotency key, so a replay is a second task in her
 * list), and reports success only after reading the task back by id. Proven
 * against the live account on 2026-11-19 with a task titled TEST-IGNORE: HTTP
 * 201, found on read-back. The write scope is real, so day 21 is no longer
 * blocked on whether GoHighLevel will accept a task from us.
 *
 * WHY A TASK AND NOT A NOTIFICATION
 *   The legacy workflow sends Angie an internal notification, which is a thing
 *   that arrives and can be missed. A task is a thing that stays until someone
 *   closes it, which is what "nothing slips through the cracks" needs.
 *
 * THIS TASK REPLACES THOSE FOUR NOTIFICATIONS. Decided by the account owner
 * 2026-11-18, superseding the earlier instruction to preserve all four Day 21
 * actions exactly. It is a replacement, not an addition: Angie should be told
 * once about one call, not five times.
 *
 * BUT THE ORDER OF THAT CUTOVER IS NOT OPTIONAL, and this module cannot do it.
 *   The write itself is proven (2026-11-19), but a working API call is not a
 *   working day 21: nothing of ours is deployed, nothing is scheduled, and no
 *   invoice has ever reached day 21 through this code. So removing the four
 *   workflow notifications NOW would leave day 21 doing nothing at all, which
 *   is worse than the duplication it fixes and is exactly the silent gap the
 *   audit exists to catch.
 *   The only safe order is:
 *     1. this module can really create tasks, and is deployed and scheduled;
 *     2. a day 21 task is observed to appear for a real invoice;
 *     3. THEN the four workflow notifications are switched off.
 *   Until step 2 has actually been seen, the four notifications stay exactly as
 *   configured. Nothing in this file touches the workflow either way.
 */
export const INTERNAL_TASK_CONTRACT = Object.freeze({
  baseUrl: "https://services.leadconnectorhq.com",
  version: "2021-07-28",
  /** POST /contacts/{contactId}/tasks */
  pathTemplate: "/contacts/{contactId}/tasks",
  writeScope: "contacts.write",
  productionWriteCapability: false,
  automaticRetry: false,
  maximumAttempts: 1,
} as const);

export type InternalTaskKind = "day21-call" | "day35-collections";

/**
 * The staff member a task is assigned to. The id is a GoHighLevel user id and
 * must be supplied by the caller from a read of the account; there is no
 * default and no name-to-id lookup here, so a typo cannot silently assign the
 * work to nobody or to the wrong person.
 */
export type InternalAssignee = Readonly<{
  /** GoHighLevel user id. */
  userId: string;
  /** For the audit trail and the task body only. Never used to resolve the id. */
  displayName: string;
  approvalRef: string;
}>;

export type InternalTaskRequest = Readonly<{
  kind: InternalTaskKind;
  assignee: InternalAssignee;
  /** The GoHighLevel contact the task hangs off. */
  contactId: string;
  /** Label only, for the title. Never a name or an address. */
  invoiceNumber: string;
  invoiceId: string;
  /** Phoenix calendar date the task is due, i.e. the milestone date. */
  dueOn: string;
  /** Minor units, for the title. */
  balanceMinor: number;
  currency: string;
}>;

export type InternalTaskDescriptor = Readonly<{
  method: "POST";
  url: string;
  /** Deliberately no Authorization header and no place to supply credentials. */
  headers: Readonly<{ Version: "2021-07-28"; "Content-Type": "application/json" }>;
  body: Readonly<{ title: string; body: string; dueDate: string; assignedTo: string; completed: false }>;
  serializedBody: string;
  maximumAttempts: 1;
  automaticRetry: false;
  productionWriteCapability: false;
}>;

export type InternalTaskResult = Readonly<{
  state: "held" | "constructed_disabled";
  reasons: readonly string[];
  descriptor: InternalTaskDescriptor | null;
  productionWriteCapability: false;
}>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const money = (minor: number, currency: string) =>
  `${currency} ${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, "0")}`;

/**
 * The exact words of each task. Pinned, because a task is read by a colleague
 * who has to know what is being asked of them and on whose authority.
 *
 * Each one states the policy day it comes from and says plainly that the
 * decision is theirs. Neither task performs the action it describes: this
 * system does not call anyone and does not refer anything to collections.
 */
const TASKS: Readonly<Record<InternalTaskKind, Readonly<{ day: number; title: string; lines: readonly string[] }>>> =
  Object.freeze({
    "day21-call": Object.freeze({
      day: 21,
      title: "Call about past-due invoice",
      lines: Object.freeze([
        "Day 21 of the past-due ladder: a phone call to the customer.",
        "Texts were sent at days 10, 15 and 20. The invoice is still unpaid.",
        "Please call and record the outcome on this task.",
      ]),
    }),
    "day35-collections": Object.freeze({
      day: 35,
      title: "Decide on collections for past-due invoice",
      lines: Object.freeze([
        "Day 35 of the past-due ladder: the policy says an unpaid invoice is sent to collections.",
        "The full ladder has run and the invoice is still unpaid.",
        "This is a DECISION for you to make, not something the system has done.",
        "Nothing has been referred to collections automatically.",
      ]),
    }),
  });

/** The day each internal task belongs to, so a caller cannot schedule it wrong. */
export function internalTaskDay(kind: InternalTaskKind): number {
  return TASKS[kind].day;
}

/**
 * Build the request for one internal task. Validates everything it is given and
 * returns reasons rather than a half-formed descriptor.
 *
 * `state` is never "sent" and never can be: the strongest result is
 * "constructed_disabled", meaning the request is well-formed and nothing was
 * contacted.
 */
export function constructInternalTask(request: InternalTaskRequest): InternalTaskResult {
  const reasons: string[] = [];
  const held = (): InternalTaskResult =>
    Object.freeze({ state: "held", reasons: Object.freeze([...new Set(reasons)].sort()),
      descriptor: null, productionWriteCapability: false });

  if (!request || typeof request !== "object") {
    return Object.freeze({ state: "held", reasons: Object.freeze(["malformed_task_request"]),
      descriptor: null, productionWriteCapability: false });
  }

  const spec = Object.hasOwn(TASKS, request.kind as string) ? TASKS[request.kind] : null;
  if (!spec) reasons.push("unknown_internal_task_kind");

  const assignee = request.assignee;
  if (!assignee || typeof assignee !== "object") reasons.push("no_assignee");
  else {
    // A task nobody owns is worse than no task: it looks handled and is not.
    if (!text(assignee.userId) || !ID.test(assignee.userId)) reasons.push("assignee_user_id_unusable");
    if (!text(assignee.displayName)) reasons.push("assignee_display_name_missing");
    if (!text(assignee.approvalRef)) reasons.push("assignee_not_approved");
  }

  if (!text(request.contactId) || !ID.test(request.contactId)) reasons.push("contact_id_unusable");
  if (!text(request.invoiceId)) reasons.push("invoice_id_missing");
  if (!text(request.invoiceNumber)) reasons.push("invoice_number_missing");
  if (typeof request.dueOn !== "string" || !DAY.test(request.dueOn)) reasons.push("due_date_unusable");
  if (!Number.isSafeInteger(request.balanceMinor) || request.balanceMinor <= 0) reasons.push("balance_not_positive");
  if (typeof request.currency !== "string" || !/^[A-Z]{3}$/.test(request.currency)) reasons.push("currency_unusable");

  if (reasons.length || !spec) return held();

  const title = `${spec.title} #${request.invoiceNumber} ` +
    `(${money(request.balanceMinor, request.currency)}, day ${spec.day})`;
  const body = [
    ...spec.lines,
    "",
    `Invoice: #${request.invoiceNumber}`,
    `Balance: ${money(request.balanceMinor, request.currency)}`,
    `Day ${spec.day} fell on: ${request.dueOn}`,
    `Assigned to: ${request.assignee.displayName}`,
  ].join("\n");

  const wire = Object.freeze({
    title, body,
    // GoHighLevel takes an instant. 09:05 Phoenix on the milestone date is
    // 16:05Z, inside the same window the texts use. Phoenix has no DST, so
    // this offset is fixed all year.
    dueDate: `${request.dueOn}T16:05:00.000Z`,
    assignedTo: request.assignee.userId,
    completed: false as const,
  });

  return Object.freeze({
    state: "constructed_disabled",
    reasons: Object.freeze([]),
    descriptor: Object.freeze({
      method: "POST" as const,
      url: INTERNAL_TASK_CONTRACT.baseUrl +
        INTERNAL_TASK_CONTRACT.pathTemplate.replace("{contactId}", encodeURIComponent(request.contactId)),
      headers: Object.freeze({ Version: INTERNAL_TASK_CONTRACT.version, "Content-Type": "application/json" as const }),
      body: wire,
      serializedBody: JSON.stringify(wire),
      maximumAttempts: 1 as const,
      automaticRetry: false as const,
      productionWriteCapability: false as const,
    }),
    productionWriteCapability: false,
  });
}
