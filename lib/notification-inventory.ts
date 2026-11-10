/** Bounded READ-ONLY account discovery. Never sends, schedules or mints identity from JSON. */
import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { AuditFailure, INVOICE_QUERY, LIMITS, paginate, type Invoice } from "../scripts/source-audit/core";
import { requireTokenRunCoverage, type JobberReader } from "../scripts/source-audit/transport";
import { GhlReadonlyReader } from "../scripts/ghl-preview/transport";
import { validGhlContactIdentity } from "./ghl-write-identity";
import { moneyCents } from "./ghl-phone-state";
import { invoiceReminderClock } from "./invoice-reminder-clock";
import { planNotificationWorklist, NOTIFICATION_WORKLIST_LIMIT, type NotificationWorklistInvoice } from "./notification-worklist";
import { inspectNotificationSourceBatch, notificationBatchPolicy, resolveNotificationBatchOwner,
  readNotificationSourceFromBatch, inspectNotificationSource, inspectNotificationSourceContactTags, deployedNotificationSourceReadBindings,
  type NotificationSourceHandle, type NotificationRecurringSourceIO,
  type NotificationSourceBatch, type NotificationRecurringSourceRequest } from "./notification-source";

const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 &&
  value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const inventoryFailureCodes = ["SOURCE_PAGE_LIMIT", "SOURCE_RECORD_LIMIT", "SOURCE_CONNECTION_MISSING",
  "SOURCE_PAGE_MALFORMED", "SOURCE_PAGE_OVERSIZE", "SOURCE_EMPTY_CONTINUATION", "SOURCE_CURSOR_MISSING",
  "SOURCE_EMPTY_CURSOR_INVALID", "SOURCE_CURSOR_REPEATED", "INVALID_SOURCE_INVOICE_ID", "SOURCE_ID_REPEATED",
  "RUN_TIME_LIMIT", "EXISTING_TOKEN_EXPIRED_OR_NEAR_EXPIRY", "EXISTING_TOKEN_INSUFFICIENT_RUN_COVERAGE",
  "RESPONSE_BYTE_LIMIT", "EMPTY_RESPONSE_BODY", "INVALID_JSON_RESPONSE", "NON_READ_QUERY_REJECTED",
  "PROBE_TIME_LIMIT", "EXISTING_CONNECTION_AUTHORIZATION_FAILED", "SOURCE_HTTP_ERROR",
  "SOURCE_RESPONSE_MALFORMED", "SOURCE_ERRORS_MALFORMED", "SOURCE_GRAPHQL_ERROR", "SOURCE_DATA_MISSING",
  "SOURCE_REQUEST_TIMEOUT", "SOURCE_NETWORK_ERROR", "SOURCE_RETRIES_EXHAUSTED",
  "SOURCE_RATE_LIMIT_METADATA_INVALID", "SOURCE_RATE_LIMIT_UNRECOVERABLE", "SOURCE_RATE_LIMIT_SCOPE_INVALID",
  "INVENTORY_SCOPE_OR_DEADLINE", "INVENTORY_ACCOUNT_CHANGED"] as const;
const inventoryFailureFactKeys = ["pages", "invoices", "bytes", "httpStatus", "expiryRemainingMinutes",
  "requiredMinutes", "graphqlErrorCount"] as const;
const inventoryCostFactKeys = ["requestedQueryCost", "actualQueryCost", "maximumAvailable", "currentlyAvailable", "restoreRate", "attempts"] as const;
type InventoryFailureFactKey = typeof inventoryFailureFactKeys[number] | typeof inventoryCostFactKeys[number];
export type NotificationInventoryFailure = Readonly<{
  code: typeof inventoryFailureCodes[number] | "INVENTORY_UNEXPECTED_FAILURE";
  facts: Readonly<Partial<Record<InventoryFailureFactKey, number | boolean>>>;
}>;
/** Diagnostics only, never authority. ESM/CJS copies of AuditFailure can have different
 * constructors. Read only native Errors' own data fields, never text, accessors or response data. */
export function notificationInventoryFailure(error: unknown): NotificationInventoryFailure {
  const unknown = (): NotificationInventoryFailure => freeze({ code: "INVENTORY_UNEXPECTED_FAILURE", facts: {} });
  try {
    if (!utilTypes.isNativeError(error)) return unknown();
    const own = (key: string): unknown => Object.getOwnPropertyDescriptor(error, key)?.value;
    const code = own("code"), rawFacts = own("facts");
    if (own("name") !== "AuditFailure" || typeof code !== "string" ||
        !inventoryFailureCodes.includes(code as typeof inventoryFailureCodes[number]) ||
        !rawFacts || typeof rawFacts !== "object" || Array.isArray(rawFacts) || utilTypes.isProxy(rawFacts)) return unknown();
    const facts: Partial<Record<InventoryFailureFactKey, number | boolean>> = {};
    for (const key of inventoryFailureFactKeys) {
      const value: unknown = Object.getOwnPropertyDescriptor(rawFacts, key)?.value;
      if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) facts[key] = value;
    }
    for (const key of inventoryCostFactKeys) {
      const value: unknown = Object.getOwnPropertyDescriptor(rawFacts, key)?.value;
      if (typeof value === "number" && Number.isFinite(value)) facts[key] = value;
    }
    return freeze({ code: code as typeof inventoryFailureCodes[number], facts });
  } catch { return unknown(); }
}
export const NOTIFICATION_INVENTORY_QUERY = INVOICE_QUERY.replace("AuditInvoices", "NotificationInventoryInvoices")
  .replace("{\n", "{\n  account { id }\n");
export type NotificationInventoryRequest = Readonly<{
  version: 1; accountId: string; locationId: string; reviewRef: string; expiresAt: string;
}>;
export type NotificationInventoryRow = Readonly<{
  invoiceId: string; ownerId: string | null; invoiceNumber: string | null; rawStatus: string | null;
  status: "open" | "paid" | "void" | "unknown"; totalMinor: number | null; balanceMinor: number | null;
  issuedDate: string | null; dueDate: string | null; holds: readonly string[];
}>;
export type NotificationInventorySnapshot = Readonly<{
  mode: "read-only-discovery"; accountId: string; locationId: string; reviewRef: string;
  observedAt: string; completedAt: string; expiresAt: string; sourceRef: string;
  coverage: "complete-account-invoices" | "partial-held"; terminalPageObserved: boolean;
  pages: number; invoiceCount: number; rows: readonly NotificationInventoryRow[]; holds: readonly string[];
  failure?: NotificationInventoryFailure;
  identityVerified: false; productionSendCapability: false;
}>;
export type NotificationInventoryIO = Readonly<{
  locationId(): string | undefined;
  /** Existing token expiry from trusted credential acquisition; never credentials or a refresh hook. */
  tokenExpiresAt(): Date;
  query: Pick<JobberReader, "query">["query"];
}>;
declare const inventoryBrand: unique symbol;
export type NotificationInventory = Readonly<{ [inventoryBrand]: true }>;
const inventories = new WeakMap<NotificationInventory, NotificationInventorySnapshot>();
function sourceRow(invoice: Invoice, now: number): NotificationInventoryRow {
  const raw = invoice.raw, totalMinor = moneyCents((raw.amounts as any)?.total), balanceMinor = moneyCents((raw.amounts as any)?.invoiceBalance);
  const ownerId = id(invoice.owner) ? invoice.owner : null;
  const issuedDate = typeof raw.issuedDate === "string" ? raw.issuedDate : null;
  const dueDate = typeof raw.dueDate === "string" ? raw.dueDate : null;
  const clock = invoiceReminderClock(issuedDate, dueDate, new Date(now));
  const rawStatus = typeof raw.invoiceStatus === "string" ? raw.invoiceStatus : null, normalized = rawStatus?.toLowerCase();
  const status = ["awaiting_payment", "past_due"].includes(normalized ?? "") && balanceMinor !== null && balanceMinor > 0 &&
    (normalized !== "past_due" || clock?.isOverdue) ? "open" : normalized === "paid" && balanceMinor === 0 ? "paid"
    : normalized === "void" ? "void" : "unknown";
  return { invoiceId: invoice.id, ownerId, invoiceNumber: invoice.invoiceNumber, rawStatus, status, totalMinor, balanceMinor, issuedDate, dueDate,
    holds: [...(!ownerId ? ["source_owner_unverified"] : []),
      ...(totalMinor === null || balanceMinor === null || balanceMinor > totalMinor ? ["source_amounts_unverified"] : []),
      ...(!clock ? ["source_dates_unverified"] : []), ...(status === "unknown" ? ["source_status_not_open"] : [])] };
}
function owned(handle: NotificationInventory, fresh = false): NotificationInventorySnapshot {
  const value = inventories.get(handle);
  if (!value) throw new Error("Unissued notification inventory; a report is not source discovery");
  if (fresh && (Date.now() < Date.parse(value.observedAt) || Date.now() >= Date.parse(value.expiresAt)))
    throw new Error("Notification discovery expired; no catch-up or freshness renewal");
  return value;
}
/** No incremental filters or cache-driven owner enumeration. Account is checked on EVERY
 * page, all source statuses remain visible, and partial/overflow results cannot seed requests. */
export async function readNotificationInventory(request: NotificationInventoryRequest, io: NotificationInventoryIO): Promise<NotificationInventory> {
  const r = structuredClone(request), begun = Date.now(), expires = Date.parse(r?.expiresAt);
  if (r?.version !== 1 || ![r.accountId, r.locationId, r.reviewRef].every(id) || r.locationId !== io.locationId() ||
      !Number.isFinite(expires) || expires <= begun) throw new Error("Invalid notification inventory request");
  requireTokenRunCoverage(io.tokenExpiresAt(), begun); // Established 900-second startup guard, never refresh.
  const deadlineAt = Math.min(expires, begun + LIMITS.runMs), rawRows: Invoice[] = [];
  let pages = 0, terminalPageObserved = false, holds: string[] = [];
  let failure: NotificationInventoryFailure | undefined;
  try {
    const result = await paginate(async after => {
      if (Date.now() >= deadlineAt || io.locationId() !== r.locationId) throw new AuditFailure("INVENTORY_SCOPE_OR_DEADLINE");
      const data = await io.query(NOTIFICATION_INVENTORY_QUERY, { after }, { maxAttempts: LIMITS.maxAttempts, deadlineAt,
        notificationReadRateLimit: true });
      pages++;
      if (data?.account && (data.account as any).id !== r.accountId || !data?.account) throw new AuditFailure("INVENTORY_ACCOUNT_CHANGED");
      if (Date.now() >= deadlineAt || io.locationId() !== r.locationId) throw new AuditFailure("INVENTORY_SCOPE_OR_DEADLINE");
      return data;
    }, { maxPages: LIMITS.maxPages, maxRecords: LIMITS.maxRecords });
    rawRows.push(...result.records); terminalPageObserved = result.terminalPageObserved;
  } catch (error) {
    // Never publish the first N pages. Only allowlisted metadata survives, not provider text.
    holds = ["account_invoice_inventory_incomplete_or_unverified"];
    failure = notificationInventoryFailure(error);
  }
  const rows = rawRows.map(row => sourceRow(row, Date.now())).sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const sourceRef = `notification-inventory-v1:${createHash("sha256").update(JSON.stringify([r.accountId, r.locationId, rows])).digest("hex")}`;
  const snapshot = freeze({ mode: "read-only-discovery" as const, accountId: r.accountId, locationId: r.locationId, reviewRef: r.reviewRef,
    observedAt: new Date(begun).toISOString(), completedAt: new Date(Date.now()).toISOString(),
    expiresAt: new Date(Math.min(expires, begun + LIMITS.runMs)).toISOString(), sourceRef,
    coverage: terminalPageObserved ? "complete-account-invoices" as const : "partial-held" as const,
    terminalPageObserved, pages, invoiceCount: rows.length, rows, holds, ...(failure ? { failure } : {}),
    identityVerified: false as const, productionSendCapability: false as const });
  const handle = Object.freeze({}) as NotificationInventory; inventories.set(handle, snapshot); return handle;
}
export function inspectNotificationInventory(handle: NotificationInventory): NotificationInventorySnapshot { return owned(handle); }

/** Integration entry: genuine inventory + shared genuine identity population feed the existing
 * pure planner. Paid/void/invalid exclusions remain explicit; no first-invoice-per-owner rule. */
export function planNotificationInventory(handle: NotificationInventory, batch: NotificationSourceBatch,
  refreshedSources: readonly NotificationSourceHandle[] = []) {
  const inventory = owned(handle, true), population = inspectNotificationSourceBatch(batch);
  if (inventory.accountId !== population.accountId || inventory.locationId !== population.locationId)
    throw new Error("Notification inventory and population account/location disagree");
  if (!Array.isArray(refreshedSources) || refreshedSources.length > NOTIFICATION_WORKLIST_LIMIT)
    throw new Error("Refreshed source input limit or shape");
  const current = new Map<string, { source: ReturnType<typeof inspectNotificationSource>; tags: ReturnType<typeof inspectNotificationSourceContactTags> }>();
  for (const handle of refreshedSources) {
    const source = inspectNotificationSource(handle), tags = inspectNotificationSourceContactTags(handle);
    const original = inventory.rows.find(row => row.invoiceId === source.invoiceId);
    if (!original || source.accountId !== inventory.accountId || source.locationId !== inventory.locationId ||
        source.ownerId !== original.ownerId || source.identitySourceRef !== population.sourceRef || current.has(source.invoiceId))
      throw new Error("Refreshed source does not match unique discovered invoice/population");
    current.set(source.invoiceId, { source, tags });
  }
  const holds = [...inventory.holds];
  const excluded: { invoiceId: string; reasons: readonly string[] }[] = [], rows: NotificationWorklistInvoice[] = [];
  const ownerHolds: { invoiceId: string; reasons: readonly string[] }[] = [];
  if (inventory.coverage === "complete-account-invoices") for (const row of inventory.rows) {
    if (row.holds.length || row.status !== "open" || !row.ownerId || row.balanceMinor === null) {
      excluded.push({ invoiceId: row.invoiceId, reasons: row.holds.length ? row.holds : [`${row.status}_no_reminder`] }); continue;
    }
    const owner = resolveNotificationBatchOwner(batch, row.ownerId), refreshed = current.get(row.invoiceId);
    if (refreshed && refreshed.source.homeownerContactId !== owner.contactId) throw new Error("Refreshed source contact differs from batch");
    if (owner.holds.length) ownerHolds.push({ invoiceId: row.invoiceId, reasons: owner.holds });
    rows.push({ accountId: inventory.accountId, locationId: inventory.locationId, invoiceId: row.invoiceId, ownerId: row.ownerId,
      homeownerContactId: owner.contactId, issuedDate: refreshed?.source.issuedDate ?? row.issuedDate, dueDate: refreshed?.source.dueDate ?? row.dueDate,
      status: refreshed?.source.status ?? row.status, balanceMinor: refreshed?.source.balanceMinor ?? row.balanceMinor,
      contactTags: refreshed?.tags ?? owner.contactTags });
  }
  if (rows.length > NOTIFICATION_WORKLIST_LIMIT) holds.push("open_invoice_worklist_limit");
  return freeze({ inventory, population, holds, excluded, ownerHolds,
    worklist: planNotificationWorklist(rows, new Date(Date.now())), productionSendCapability: false as const });
}
/** Generate pins from a real scanner handle. A standing policy supplies scope; no manual
 * per-invoice approval is invented. This request is NOT a source capability or authorization. */
export function notificationRequestFromInventory(handle: NotificationInventory, batch: NotificationSourceBatch,
  invoiceId: string): NotificationRecurringSourceRequest {
  const inventory = owned(handle, true), population = inspectNotificationSourceBatch(batch);
  if (inventory.coverage !== "complete-account-invoices" || inventory.accountId !== population.accountId || inventory.locationId !== population.locationId)
    throw new Error("Complete matching inventory required");
  const row = inventory.rows.find(item => item.invoiceId === invoiceId);
  if (!row || row.holds.length || row.status !== "open" || !row.ownerId || !row.totalMinor || !row.issuedDate || !row.dueDate)
    throw new Error("Discovered invoice is held or unavailable");
  const owner = resolveNotificationBatchOwner(batch, row.ownerId);
  if (!owner.contactId || owner.holds.length) throw new Error("Discovered owner/contact unresolved");
  return freeze({ version: 2, reviewRef: inventory.reviewRef,
    expiresAt: new Date(Math.min(Date.parse(inventory.expiresAt), Date.parse(population.expiresAt))).toISOString(),
    inventorySourceRef: inventory.sourceRef,
    scope: { locationId: inventory.locationId, jobberClientId: row.ownerId, contactId: owner.contactId, invoiceId: row.invoiceId },
    originalInvoice: { totalMinor: row.totalMinor, issuedDate: row.issuedDate, dueDate: row.dueDate }, identityCoveragePolicy: notificationBatchPolicy(batch) });
}
/** Real exact-source capability integration, with independent rereads rather than trusting discovery. */
export async function readDiscoveredNotificationSource(handle: NotificationInventory, batch: NotificationSourceBatch, invoiceId: string) {
  return readNotificationSourceFromBatch(batch, notificationRequestFromInventory(handle, batch, invoiceId));
}

/** Inert factory. Caller acquires EXISTING credentials separately and supplies the real expiry.
 * No OAuth refresh, auth write, DB query, provider read, migration or application startup here. */
export async function deployedNotificationInventoryReadBindings(reader: Pick<JobberReader, "query">,
  options: Readonly<{ tokenExpiresAt: Date; fetch?: typeof fetch; cacheRead?: import("./notification-source").NotificationCacheRead }>): Promise<Readonly<{
    inventoryIO: NotificationInventoryIO; sourceIO: NotificationRecurringSourceIO;
  }>> {
  const base = await deployedNotificationSourceReadBindings(reader, { ...options, notificationReadRateLimit: true });
  const prismaModule = await import("./prisma");
  const prisma: typeof import("./prisma").prisma = (prismaModule as any).prisma ?? (prismaModule as any).default?.prisma;
  if (typeof prisma?.customer?.findMany !== "function") throw new Error("Recurring cache read binding unavailable");
  const locationId = process.env.GHL_LOCATION_ID, apiKey = process.env.GHL_API_KEY, tokenExpiry = options.tokenExpiresAt.getTime();
  const fetcher = options.fetch;
  const cacheRead: import("./notification-source").NotificationCacheRead = options.cacheRead ?? (read => read(prisma));
  const verify = () => {
    if (process.env.GHL_LOCATION_ID !== locationId || process.env.GHL_API_KEY !== apiKey)
      throw new Error("Recurring read configuration changed");
  };
  const sourceIO: NotificationRecurringSourceIO = Object.freeze({ ...base,
    customer: async (ownerId: string) => {
      verify(); if (!id(ownerId)) throw new Error("Invalid recurring cache owner");
      const rows = await cacheRead(tx => tx.customer.findMany({ where: { jobberClientId: ownerId }, select: { jobberClientId: true, email: true, phone: true } }));
      if (rows.length !== 1) return null;
      return rows[0];
    },
    contact: async (contactId: string) => {
      verify(); if (!/^[A-Za-z0-9_-]{1,256}$/.test(contactId)) throw new Error("Invalid exact recurring contact");
      const ghl = new GhlReadonlyReader({ locationId: locationId ?? "", apiKey: apiKey ?? "", fetch: fetcher, deadlineAt: Date.now() + 60000 });
      const result = await ghl.request(`/contacts/${contactId}`), contact: any = result.contact;
      if (!contact || contact.id !== contactId || contact.locationId !== locationId || !validGhlContactIdentity(contact))
        throw new Error("Exact recurring contact identity unverified");
      // Preserve identity/tags only. DND is still independently validated by the existing contract reader.
      return { id: contact.id, locationId: contact.locationId, email: contact.email ?? null, phone: contact.phone ?? null,
        additionalEmails: contact.additionalEmails ?? [], additionalPhones: contact.additionalPhones ?? [], tags: contact.tags };
    },
  });
  return Object.freeze({ sourceIO, inventoryIO: Object.freeze({ locationId: () => { verify(); return base.locationId(); },
    tokenExpiresAt: () => new Date(tokenExpiry), query: reader.query.bind(reader) }) });
}
