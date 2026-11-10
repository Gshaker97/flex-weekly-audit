/** Local candidate only. This module never contacts a provider or connects to a database.
 * A caller must explicitly inject a database and pass the separate notification gate.
 * Reservation is admission, not send authorization. See docs/notification-ledger.md.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { addInvoiceCalendarDays, invoiceCalendarDate } from "./invoice-reminder-clock";
import type { Event } from "./notification-gate";

export type NotificationLedgerEvent = Event;
export type NotificationReservationInput = Readonly<{
  event: NotificationLedgerEvent;
  body: string;
  destination: string;
  channel: "sms" | "email";
  contactId: string;
  scheduledOn: string;
}>;
/** Opaque, instance-issued capability. Never serialize, restore, log or reconstruct it. */
export type NotificationReservation = Readonly<{
  id: string; token: string; eventHash: string; bodyHash: string; destinationHash: string;
}>;
export type NotificationReservationResult =
  | Readonly<{ state: "reserved"; reservation: NotificationReservation }>
  | Readonly<{ state: "held"; reason: "invalid_reservation_input" | "already_claimed" | "ledger_uncertain" }>;
export type NotificationOutcome =
  | Readonly<{ state: "accepted"; providerMessageId: string }>
  | Readonly<{ state: "rejected" }>
  | Readonly<{ state: "unknown" }>;
export interface NotificationLedger {
  reserve(input: NotificationReservationInput): Promise<NotificationReservationResult>;
  assertReserved(handle: NotificationReservation): Promise<boolean>;
  markPending(handle: NotificationReservation): Promise<boolean>;
  markOutcome(handle: NotificationReservation, outcome: NotificationOutcome): Promise<boolean>;
}

/** A successful transaction promise MUST mean the commit acknowledgment was received.
 * Adapters must not retry callbacks, statements, commits or an uncertain operation.
 */
export interface NotificationLedgerTransaction {
  query<Row extends Record<string, unknown>>(statement: string, values: readonly unknown[]): Promise<Row[]>;
}
export interface NotificationLedgerDatabase {
  transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T>;
}

const MAX_EVENT_BYTES = 131_072;
const MAX_BODY_BYTES = 65_536;
const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const validId = (value: unknown): value is string => typeof value === "string" &&
  value.length > 0 && value.length <= 256 && value.trim() === value && !value.includes("\0");

/** Only plain JSON is accepted; unsupported values cannot silently disappear or collide.
 * Bounds also prevent recursive/cyclic or unexpectedly huge inputs reaching the database.
 */
function canonicalJson(value: unknown): string {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 10_000 || depth > 20) throw new Error("invalid_event_json");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (item.includes("\0") || Buffer.byteLength(item, "utf8") > MAX_EVENT_BYTES) throw new Error("invalid_event_json");
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null || seen.has(item)) throw new Error("invalid_event_json");
    seen.add(item);
    let result: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Reflect.ownKeys(item).length !== item.length + 1)
        throw new Error("invalid_event_json");
      result = `[${Array.from({ length: item.length }, (_, index) => {
        const property = Object.getOwnPropertyDescriptor(item, String(index));
        if (!property || !Object.hasOwn(property, "value")) throw new Error("invalid_event_json");
        return visit(property.value, depth + 1);
      }).join(",")}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        throw new Error("invalid_event_json");
      const keys = Object.keys(item).sort();
      if (Reflect.ownKeys(item).length !== keys.length) throw new Error("invalid_event_json");
      result = `{${keys.map(key => {
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!Object.hasOwn(property, "value")) throw new Error("invalid_event_json");
        return `${JSON.stringify(key)}:${visit(property.value, depth + 1)}`;
      }).join(",")}}`;
    }
    seen.delete(item);
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result, "utf8") > MAX_EVENT_BYTES) throw new Error("invalid_event_json");
  return result;
}

export const notificationBodyDigest = (body: string): string => digest(body);
export const notificationEventHash = (event: NotificationLedgerEvent): string => digest(canonicalJson(event));
export function notificationDestinationHash(destination: Pick<Event, "accountId" | "contactId" | "channel" | "destination">): string {
  return digest(JSON.stringify(["notification-destination-v1", destination.accountId,
    destination.contactId, destination.channel, destination.destination]));
}

type Prepared = { event: NotificationLedgerEvent; eventKey: string; eventPayload: string;
  body: string; destination: string; scheduledOn: string; eventHash: string; bodyHash: string; destinationHash: string };
function prepare(input: NotificationReservationInput): Prepared {
  // Snapshot before the first await. Never retain the caller's mutable event object.
  const eventPayload = canonicalJson(input.event);
  const event = JSON.parse(eventPayload) as NotificationLedgerEvent;
  const { body, destination, channel, contactId, scheduledOn } = input;
  if (!event || ![event.accountId, event.invoiceId, event.contactId].every(validId) ||
      !["homeowner", "internal"].includes(event.audience) || !["sms", "email"].includes(event.channel) ||
      !Number.isSafeInteger(event.dayPastDue) || event.dayPastDue <= 0 || event.dayPastDue > 3660 ||
      typeof body !== "string" || body.trim().length === 0 || body.includes("\0") ||
      Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES || typeof destination !== "string" ||
      !destination || destination.length > 4096 || destination.includes("\0") ||
      event.channel !== channel || event.contactId !== contactId || event.destination !== destination ||
      !/^[a-f0-9]{64}$/.test(event.bodyDigest) || digest(body) !== event.bodyDigest)
    throw new Error("invalid_reservation_input");
  const dueOn = invoiceCalendarDate(event.dueDate);
  if (!dueOn || typeof scheduledOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledOn) ||
      invoiceCalendarDate(scheduledOn) !== scheduledOn || addInvoiceCalendarDays(dueOn, event.dayPastDue) !== scheduledOn)
    throw new Error("invalid_reservation_input");
  return { event, eventPayload, body, destination, scheduledOn,
    eventKey: JSON.stringify(["notification-v1", event.accountId, event.invoiceId, event.dayPastDue, event.audience]),
    eventHash: digest(eventPayload), bodyHash: digest(body), destinationHash: notificationDestinationHash(event) };
}

const INSERT = `/* notification-ledger:reserve */
INSERT INTO "NotificationLedger" (
  "id", "reservationToken", "eventKey", "accountId", "invoiceId", "dayPastDue", "audience",
  "contactId", "scheduledOn", "channel", "eventPayload", "body", "destination",
  "eventHash", "bodyHash", "destinationHash", "state"
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11::jsonb, $12, $13, $14, $15, $16, 'reserved')
ON CONFLICT DO NOTHING RETURNING "id"`;
const MATCH = `"id" = $1 AND "reservationToken" = $2 AND "eventHash" = $3 AND "bodyHash" = $4 AND "destinationHash" = $5`;
const ASSERT = `/* notification-ledger:assert */
SELECT "id" FROM "NotificationLedger" WHERE ${MATCH} AND "state" = 'reserved'`;
const PENDING = `/* notification-ledger:pending */
UPDATE "NotificationLedger" SET "state" = 'pending', "pendingAt" = CURRENT_TIMESTAMP
WHERE ${MATCH} AND "state" = 'reserved' RETURNING "id"`;
const OUTCOME = `/* notification-ledger:outcome */
UPDATE "NotificationLedger" SET "state" = $6, "providerMessageId" = $7, "outcomeAt" = CURRENT_TIMESTAMP
WHERE ${MATCH} AND "state" = 'pending' RETURNING "id"`;
const matches = (rows: { id: unknown }[], id: string) => rows.length === 1 && rows[0].id === id;

/** No release, reset, expiry, receipt escalation or retry APIs, deliberately.
 * Only the exact frozen capability issued by this instance can advance a claim.
 */
export function createNotificationLedger(database: NotificationLedgerDatabase): NotificationLedger {
  type Phase = "reserved" | "checking" | "verified" | "pending_attempted" | "pending" | "outcome_attempted" | "closed";
  const issued = new WeakMap<NotificationReservation, Phase>();
  // Suppress same-process retries even if admission loses its commit acknowledgment.
  const admissionAttempted = new Set<string>();
  const values = (handle: NotificationReservation) =>
    [handle.id, handle.token, handle.eventHash, handle.bodyHash, handle.destinationHash];
  const execute = (statement: string, parameters: readonly unknown[]) =>
    database.transaction(tx => tx.query<{ id: unknown }>(statement, parameters));
  return Object.freeze({
    async reserve(input: NotificationReservationInput): Promise<NotificationReservationResult> {
      let prepared: Prepared;
      try { prepared = prepare(input); } catch { return { state: "held", reason: "invalid_reservation_input" }; }
      if (admissionAttempted.has(prepared.eventKey)) return { state: "held", reason: "already_claimed" };
      admissionAttempted.add(prepared.eventKey);
      const handle: NotificationReservation = Object.freeze({ id: randomUUID(), token: randomBytes(32).toString("hex"),
        eventHash: prepared.eventHash, bodyHash: prepared.bodyHash, destinationHash: prepared.destinationHash });
      const { event } = prepared;
      try {
        const rows = await execute(INSERT, [handle.id, handle.token, prepared.eventKey, event.accountId,
          event.invoiceId, event.dayPastDue, event.audience, event.contactId, prepared.scheduledOn, event.channel,
          prepared.eventPayload, prepared.body, prepared.destination, handle.eventHash, handle.bodyHash, handle.destinationHash]);
        if (!matches(rows, handle.id)) return { state: "held", reason: "already_claimed" };
        // This happens AFTER the transaction committed and returned its acknowledgment.
        issued.set(handle, "reserved");
        return { state: "reserved", reservation: handle };
      } catch { return { state: "held", reason: "ledger_uncertain" }; }
    },
    async assertReserved(handle: NotificationReservation): Promise<boolean> {
      if (!["reserved", "verified"].includes(issued.get(handle) ?? "")) {
        if (issued.has(handle)) issued.set(handle, "closed");
        return false;
      }
      issued.set(handle, "checking");
      try {
        const ok = matches(await execute(ASSERT, values(handle)), handle.id);
        // A concurrent failed assertion must not be revived by this later response.
        if (issued.get(handle) !== "checking") return false;
        issued.set(handle, ok ? "verified" : "closed");
        return ok;
      } catch { issued.set(handle, "closed"); return false; }
    },
    async markPending(handle: NotificationReservation): Promise<boolean> {
      if (issued.get(handle) !== "verified") return false;
      // Burn the capability BEFORE awaiting: overlapping and timed-out calls cannot retry.
      issued.set(handle, "pending_attempted");
      try {
        const ok = matches(await execute(PENDING, values(handle)), handle.id);
        if (issued.get(handle) !== "pending_attempted") return false;
        issued.set(handle, ok ? "pending" : "closed");
        return ok;
      } catch { issued.set(handle, "closed"); return false; }
    },
    async markOutcome(handle: NotificationReservation, outcome: NotificationOutcome): Promise<boolean> {
      if (issued.get(handle) !== "pending") return false;
      issued.set(handle, "outcome_attempted");
      if (!outcome || !["accepted", "rejected", "unknown"].includes(outcome.state) ||
          (outcome.state === "accepted" && !validId(outcome.providerMessageId))) {
        issued.set(handle, "closed"); return false;
      }
      try {
        const ok = matches(await execute(OUTCOME, [...values(handle), outcome.state,
          outcome.state === "accepted" ? outcome.providerMessageId : null]), handle.id);
        issued.set(handle, "closed");
        return ok;
      } catch { issued.set(handle, "closed"); return false; }
    },
  });
}

/** Structural raw SQL adapter avoids generating/mutating the shared Prisma client. */
export interface PrismaNotificationLedgerTransaction {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}
export interface PrismaNotificationLedgerClient {
  $transaction<T>(work: (tx: PrismaNotificationLedgerTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number }): Promise<T>;
}
export const NOTIFICATION_LEDGER_TIMEOUTS = Object.freeze({
  maxWaitMs: 1000, transactionMs: 5000, lockMs: 1000, statementMs: 2500,
});

/** Calling the factory itself is inert. A ledger operation invokes the injected client.
 * SQL syntax is fixed; all external values are bound parameters, never interpolated.
 */
export function createPrismaNotificationLedger(prisma: PrismaNotificationLedgerClient): NotificationLedger {
  return createNotificationLedger({
    transaction: work => prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
      return work({ query: <Row extends Record<string, unknown>>(statement: string, parameters: readonly unknown[]) =>
        tx.$queryRawUnsafe<Row[]>(statement, ...parameters) });
    }, { maxWait: NOTIFICATION_LEDGER_TIMEOUTS.maxWaitMs, timeout: NOTIFICATION_LEDGER_TIMEOUTS.transactionMs }),
  });
}
