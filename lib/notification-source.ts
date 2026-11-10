/** Disabled, read-only source composition. No sender, migration, scheduler or sync hook. */
import { createHash } from "node:crypto";
import { permitsUnknownCurrency } from "./notification-copy-policy";
import { readOwnerInvoiceEvidence } from "./ghl-date-readiness";
import { readReviewedIdentityCoverage, coveragePermitsExactInvoice,
  type CachedLinkCounts, type ReviewedOmissionPolicy, type IdentityCoverageEvidence } from "./ghl-identity-coverage";
import { verifyFreshGhlIdentity, validGhlContactIdentity } from "./ghl-write-identity";
import type { FreshJobberIdentity } from "./ghl-write-identity";
import { canonicalPhone } from "./ghl-phone-match";
import { moneyCents } from "./ghl-phone-state";
import { invoiceCalendarDate, invoiceReminderClock } from "./invoice-reminder-clock";
import { PROPOSAL, type Event, type Evidence, type Proof } from "./notification-gate";
import type { GhlContact } from "./ghl";
import type { jobberGraphQL } from "./jobber";
import type { JobberReader } from "../scripts/source-audit/transport";
import { GhlReadonlyReader } from "../scripts/ghl-preview/transport";
import { readAllContacts } from "../scripts/ghl-preview/snapshot";

type Customer = { jobberClientId: string; email?: string | null; phone?: string | null };
export type NotificationSourceRequest = Readonly<{
  version: 1; reviewRef: string; expiresAt: string;
  scope: Readonly<{ locationId: string; jobberClientId: string; contactId: string; invoiceId: string }>;
  originalInvoice: Readonly<{ totalMinor: number; issuedDate: string; dueDate: string }>;
  identityCoveragePolicy: ReviewedOmissionPolicy;
}>;
/** Trusted IO boundary, not request JSON. Each function must perform fresh, complete reads.
 * There is deliberately no injectable `coverage: true` or pre-minted identity/source proof. */
export type NotificationSourceIO = Readonly<{
  locationId(): string | undefined;
  customers(): Promise<Customer[]>;
  storedInvoices(ownerId: string): Promise<{ jobberInvoiceId: string }[]>;
  quarantineCounts(ids: string[]): Promise<CachedLinkCounts[]>;
  contacts(): Promise<GhlContact[]>;
  query: typeof jobberGraphQL;
}>;
declare const notificationSourceBrand: unique symbol;
export type NotificationSourceHandle = Readonly<{ [notificationSourceBrand]: true }>;
export type NotificationSourceSnapshot = Readonly<{
  kind: "notification-source-v1"; requestSha256: string;
  observedAt: string; expiresAt: string; sourceRef: string;
  identityObservedAt: string; identityExpiresAt: string; identitySourceRef: string;
  contactObservedAt: string; contactExpiresAt: string;
  cacheObservedAt: string; quarantineCountsObservedAt: string;
  exactOwnerObservedAt: string; coverageReused: boolean;
  accountId: string; locationId: string; invoiceId: string; ownerId: string; homeownerContactId: string;
  sourceRevision: string; ownerRevision: string;
  rawStatus: string; status: "open" | "paid" | "void" | "unknown";
  invoiceNumber: string | null; currency: null; category: null; categoryVerified: false;
  unsupportedInputs: readonly string[];
  totalMinor: number; balanceMinor: number; issuedDate: string; dueDate: string;
  sentOn: string; dueOn: string; daysPastDue: number;
  productionSendCapability: false; timingApproved: false;
}>;
type PrivateSnapshot = {
  snapshot: NotificationSourceSnapshot;
  request: NotificationSourceRequest; io: NotificationSourceIO;
  customers: Customer[]; contacts: GhlContact[]; identities: FreshJobberIdentity[]; coverage: IdentityCoverageEvidence;
  homeownerEmail: string | null; homeownerPhone: string | null;
  contactEmail: string | null; contactPhone: string | null;
};
const issued = new WeakMap<NotificationSourceHandle, PrivateSnapshot>();
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 256 && value.trim() === value && !value.includes("\0");
const emailKey = (value?: string | null) => value?.trim().toLowerCase() || null;
const sortedRows = (rows: unknown[][]) => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
function customerIdentityKey(rows: Customer[]): string {
  if (!Array.isArray(rows) || rows.some(c => !id(c?.jobberClientId) ||
      (c.email != null && typeof c.email !== "string") || (c.phone != null && typeof c.phone !== "string")))
    throw new Error("Notification cached identity fields unverified");
  return JSON.stringify(sortedRows(rows.map(c => [c.jobberClientId, c.email ?? null, c.phone ?? null])));
}
function contactIdentityKey(rows: GhlContact[], locationId: string): string {
  if (!Array.isArray(rows) || rows.some(c => !id(c?.id) || !validGhlContactIdentity(c) ||
      ((c as GhlContact & { locationId?: string }).locationId !== undefined &&
       (c as GhlContact & { locationId?: string }).locationId !== locationId)) ||
      new Set(rows.map(c => c.id)).size !== rows.length)
    throw new Error("Notification contact snapshot unverified");
  // Preserve raw primary/secondary identifier values and duplicates. Ignore only unrelated
  // activity/metadata and ordering; malformed documented identity fields throw above.
  return JSON.stringify(sortedRows(rows.map(c => [c.id, (c as GhlContact & { locationId?: string }).locationId ?? null,
    c.email ?? null, c.phone ?? null, [...(c.additionalEmails ?? [])].map(e => e.email).sort(),
    [...(c.additionalPhones ?? [])].map(p => p.phone).sort()])));
}
const identityKey = (v: FreshJobberIdentity) => JSON.stringify([v.id,
  sortedRows(v.emails.map(e => [e.address, e.primary])), sortedRows(v.phones.map(p => [p.number, p.primary]))]);
const sourceIdentityKey = (rows: FreshJobberIdentity[]) => JSON.stringify(rows.map(identityKey).sort());
const instant = (value: unknown) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && invoiceCalendarDate(value)
  ? Date.parse(value) : NaN;
function validateRequest(r: NotificationSourceRequest, locationId: string | undefined, at: number): void {
  const expires = instant(r?.expiresAt), policyExpires = instant(r?.identityCoveragePolicy?.expiresAt);
  if (r?.version !== 1 || !id(r.reviewRef) || !r.scope || Object.keys(r.scope).length !== 4 ||
      !Object.values(r.scope).every(id) || r.scope.locationId !== locationId ||
      !Number.isFinite(at) || !Number.isFinite(expires) || expires <= at || expires > policyExpires ||
      !Number.isSafeInteger(r.originalInvoice?.totalMinor) || r.originalInvoice.totalMinor <= 0 ||
      !invoiceReminderClock(r.originalInvoice.issuedDate, r.originalInvoice.dueDate, new Date(at)))
    throw new Error("Invalid or expired exact notification source request");
}
function assertFresh(proof: Proof, at: number): void {
  const observed = instant(proof?.observedAt), expires = instant(proof?.expiresAt);
  if (!Number.isFinite(at) || !id(proof?.sourceRef) || !Number.isFinite(observed) || !Number.isFinite(expires) ||
      observed > at || expires <= at || expires <= observed || at - observed >= PROPOSAL.maxProofAgeSeconds * 1000)
    throw new Error("Notification source or external proof expired or unverified");
}
function assertRecentIdentityRechecks(continuity: Pick<NotificationSourceSnapshot, "identityExpiresAt" | "identitySourceRef" |
  "contactObservedAt" | "exactOwnerObservedAt" | "cacheObservedAt" | "quarantineCountsObservedAt">, at: number): void {
  for (const key of ["contactObservedAt", "exactOwnerObservedAt", "cacheObservedAt", "quarantineCountsObservedAt"] as const) {
    const observedAt = continuity[key], observed = instant(observedAt), identityExpires = instant(continuity.identityExpiresAt);
    if (!Number.isFinite(observed) || !Number.isFinite(identityExpires)) throw new Error(`Notification ${key} unverified`);
    try {
      assertFresh({ observedAt, expiresAt: new Date(Math.min(observed + PROPOSAL.maxProofAgeSeconds * 1000, identityExpires)).toISOString(),
        sourceRef: continuity.identitySourceRef }, at);
    } catch { throw new Error(`Notification ${key} proof expired or unverified`); }
  }
}
function owned(handle: NotificationSourceHandle, sourceRequired = true): PrivateSnapshot {
  const data = issued.get(handle);
  if (!data) throw new Error("Unissued notification source handle; ledger admission is not source evidence");
  if (sourceRequired) assertFresh(data.snapshot, Date.now());
  const s = data.snapshot, at = Date.now();
  if (at < instant(s.identityObservedAt) || at >= instant(s.identityExpiresAt) ||
      !coveragePermitsExactInvoice(data.coverage, data.customers, data.identities, data.request.scope))
    throw new Error("Notification original identity coverage expired or changed");
  return data;
}

/** Reads the existing account-checked explicit active/archive identity union, exact
 * owner/invoice and complete owner-invoice connection. No card/stage/zeroing assumption.
 * Policy is never renewed. Its 24h maximum and coverage's 5min maximum remain unchanged.
 * Source observation time is START of all reads, never end-of-read timestamp laundering. */
export async function readNotificationSource(request: NotificationSourceRequest, io: NotificationSourceIO): Promise<NotificationSourceHandle> {
  io = Object.freeze({ ...io });
  const r = structuredClone(request), begun = Date.now();
  validateRequest(r, io.locationId(), begun);
  const s = r.scope, customers = structuredClone(await io.customers());
  customerIdentityKey(customers);
  const owners = customers.filter(c => c.jobberClientId === s.jobberClientId);
  if (owners.length !== 1) throw new Error("Notification cached owner missing or duplicated");
  const owner = owners[0];
  // Call the real evidence issuer, not a caller-supplied boolean or cloned capability.
  let exactOwnerObservedAt = new Date(begun).toISOString(), quarantineCountsObservedAt = new Date(begun).toISOString();
  const coverageQuery: typeof jobberGraphQL = async <T = any>(statement: string, variables?: Record<string, any>): Promise<T> => {
    if (statement.includes("VerifyExactCoverageOwnerInvoice")) exactOwnerObservedAt = new Date(Date.now()).toISOString();
    return io.query<T>(statement, variables);
  };
  const covered = await readReviewedIdentityCoverage(r.identityCoveragePolicy, customers, s,
    () => {
      quarantineCountsObservedAt = new Date(Date.now()).toISOString();
      return io.quarantineCounts(r.identityCoveragePolicy.quarantine.map(c => c.jobberClientId));
    }, coverageQuery);
  const contactObservedAt = Date.now();
  const contacts = structuredClone(await io.contacts());
  contactIdentityKey(contacts, s.locationId);
  const contact = contacts.find(c => c.id === s.contactId);
  const email = emailKey(owner.email), phone = canonicalPhone(owner.phone);
  if (!contact || !((email && email === emailKey(contact.email)) || (phone && phone === canonicalPhone(contact.phone))))
    throw new Error("Notification selected contact differs from primary source identity");
  const identityHold = verifyFreshGhlIdentity(owner, customers, contacts, s.contactId, covered.identities, covered.evidence);
  if (identityHold) throw new Error(identityHold);
  const identityExpires = Math.min(begun + 300_000, instant(r.expiresAt), instant(r.identityCoveragePolicy.expiresAt));
  const baseline = { request: r, io, customers, contacts, identities: covered.identities, coverage: covered.evidence,
    homeownerEmail: email, homeownerPhone: phone, contactEmail: emailKey(contact.email), contactPhone: canonicalPhone(contact.phone) };
  const identityBinding = [r.scope, customerIdentityKey(customers), sourceIdentityKey(covered.identities), contactIdentityKey(contacts, s.locationId)];
  return readAndIssueSource(baseline, { identityObservedAt: new Date(begun).toISOString(),
    identityExpiresAt: new Date(identityExpires).toISOString(),
    identitySourceRef: `notification-identity-v1:${sha([identityBinding, r.identityCoveragePolicy])}`,
    ownerRevision: sha(identityBinding), contactObservedAt: new Date(contactObservedAt).toISOString(),
    cacheObservedAt: new Date(begun).toISOString(), quarantineCountsObservedAt, exactOwnerObservedAt, coverageReused: false });
}
type Continuity = Pick<NotificationSourceSnapshot, "identityObservedAt" | "identityExpiresAt" | "identitySourceRef" |
  "ownerRevision" | "contactObservedAt" | "cacheObservedAt" | "quarantineCountsObservedAt" | "exactOwnerObservedAt" | "coverageReused">;
type Baseline = Omit<PrivateSnapshot, "snapshot">;
async function readAndIssueSource(data: Baseline, continuity: Continuity): Promise<NotificationSourceHandle> {
  const { request: r, io, customers, identities, coverage } = data, s = r.scope, begun = Date.now();
  // Same trusted pagination as date readiness / paid-cycle, account checked on EVERY page.
  const query: typeof jobberGraphQL = async <T = any>(statement: string, variables?: Record<string, any>): Promise<T> => {
    const result: any = await io.query(statement.replace("{", "{ account { id }")
      .replace("nodes { id invoiceStatus", "nodes { id invoiceNumber invoiceStatus"), variables);
    if (result?.account?.id !== r.identityCoveragePolicy.accountId)
      throw new Error("Notification invoice source account changed or unavailable");
    return result as T;
  };
  const invoices = structuredClone(await readOwnerInvoiceEvidence(s.jobberClientId, query));
  const stored = structuredClone(await io.storedInvoices(s.jobberClientId));
  if (invoices.length !== 1 || invoices[0].id !== s.invoiceId || invoices[0].client?.id !== s.jobberClientId ||
      !Array.isArray(stored) || stored.length !== 1 || stored[0]?.jobberInvoiceId !== s.invoiceId)
    throw new Error("Original notification invoice set changed or incomplete");
  const invoice = invoices[0], totalMinor = moneyCents(invoice.amounts?.total), balanceMinor = moneyCents(invoice.amounts?.invoiceBalance);
  if (totalMinor === null || balanceMinor === null || balanceMinor > totalMinor || totalMinor !== r.originalInvoice.totalMinor ||
      invoice.issuedDate !== r.originalInvoice.issuedDate || invoice.dueDate !== r.originalInvoice.dueDate ||
      typeof invoice.invoiceStatus !== "string" || !invoice.invoiceStatus.trim())
    throw new Error("Original notification invoice fields changed or unverified");
  const clock = invoiceReminderClock(invoice.issuedDate, invoice.dueDate, new Date(Date.now()));
  if (!clock) throw new Error("Notification source invoice dates unverified");
  const rawStatus = invoice.invoiceStatus.toLowerCase();
  const status = ["awaiting_payment", "past_due"].includes(rawStatus) && balanceMinor > 0 &&
      (rawStatus !== "past_due" || clock.isOverdue) ? "open"
    : rawStatus === "paid" && balanceMinor === 0 ? "paid"
    : rawStatus === "void" ? "void" : "unknown";
  // Labels and createdAt are not identity or reminder-clock inputs. Keep number for display
  // without making a changed/missing display label another logical invoice or send event.
  const sourceRevision = sha([r.scope, invoice.id, invoice.client?.id, invoice.invoiceStatus,
    totalMinor, balanceMinor, invoice.issuedDate, invoice.dueDate]);
  // A retained snapshot must expire when ANY relied-on exact check expires, not only when
  // a caller happens to compose it. The unchanged account-wide proof still keeps its own
  // original five-minute bound; these final checks never extend or relabel that proof.
  const expires = Math.min(instant(continuity.identityExpiresAt), ...[begun,
    instant(continuity.contactObservedAt), instant(continuity.exactOwnerObservedAt),
    instant(continuity.cacheObservedAt), instant(continuity.quarantineCountsObservedAt)]
    .map(observed => observed + PROPOSAL.maxProofAgeSeconds * 1000));
  const proof = { observedAt: new Date(begun).toISOString(), expiresAt: new Date(expires).toISOString(),
    sourceRef: `notification-source-v1:${sourceRevision}` };
  validateRequest(r, io.locationId(), Date.now());
  if (Date.now() >= instant(continuity.identityExpiresAt) ||
      !coveragePermitsExactInvoice(coverage, customers, identities, s))
    throw new Error("Notification identity coverage expired or changed");
  assertRecentIdentityRechecks(continuity, Date.now());
  assertFresh(proof, Date.now());
  const contactExpiresAt = new Date(Math.min(instant(continuity.contactObservedAt) + PROPOSAL.maxProofAgeSeconds * 1000,
    instant(continuity.identityExpiresAt))).toISOString();
  const number = (invoice as typeof invoice & { invoiceNumber?: unknown }).invoiceNumber;
  const invoiceNumber = typeof number === "string" && number.trim().length > 0 && number.length <= 256 ? number
    : typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? String(number) : null;
  const snapshot: NotificationSourceSnapshot = Object.freeze({ kind: "notification-source-v1", ...proof, ...continuity, contactExpiresAt,
    requestSha256: sha(r), accountId: r.identityCoveragePolicy.accountId, locationId: s.locationId,
    invoiceId: s.invoiceId, ownerId: s.jobberClientId, homeownerContactId: s.contactId,
    sourceRevision, rawStatus, status, totalMinor, balanceMinor, invoiceNumber,
    currency: null, category: null, categoryVerified: false,
    unsupportedInputs: Object.freeze(["independent_currency_and_category", "fresh_recipient_and_DND",
      "approved_internal_recipient", "approved_template_body_and_channel", "fee_suspension_and_collection_facts",
      "complete_existing_attempt_history", "production_send_permission"]),
    issuedDate: invoice.issuedDate!, dueDate: invoice.dueDate!,
    sentOn: clock.sentOn, dueOn: clock.dueOn, daysPastDue: clock.daysPastDue,
    productionSendCapability: false, timingApproved: false });
  const handle = Object.freeze({}) as NotificationSourceHandle;
  issued.set(handle, { ...data, snapshot });
  return handle;
}
/** Reuses only the SAME still-live opaque coverage issuer proof. Reads exact source owner,
 * all current GHL contact identities and the complete owner invoice set again. The original
 * coverage observation/expiry/reference and owner revision remain unchanged, never renewed.
 * This is not fresh account-wide coverage; changes outside these exact rereads may remain
 * unseen until coverage expires. DND and other external evidence still need their own read. */
export async function refreshNotificationSource(handle: NotificationSourceHandle): Promise<NotificationSourceHandle> {
  const before = owned(handle, false), { request: r, io } = before, s = r.scope;
  validateRequest(r, io.locationId(), Date.now());
  const cacheObservedAt = new Date(Date.now()).toISOString(), customers = structuredClone(await io.customers());
  if (customerIdentityKey(customers) !== customerIdentityKey(before.customers) || !coveragePermitsExactInvoice(before.coverage, customers, before.identities, s))
    throw new Error("Notification cached identities changed since original coverage");
  const quarantineIds = r.identityCoveragePolicy.quarantine.map(c => c.jobberClientId);
  const quarantineCountsObservedAt = new Date(Date.now()).toISOString(), counts = await io.quarantineCounts(quarantineIds);
  if (!Array.isArray(counts) || counts.length !== 2 || new Set(counts.map(c => c.jobberClientId)).size !== 2 ||
      counts.some(c => !quarantineIds.includes(c.jobberClientId) || c.jobs !== 0 || c.invoices !== 0))
    throw new Error("Notification quarantine links changed or unverified since original coverage");
  const exactOwnerObservedAt = new Date(Date.now()).toISOString();
  const exact: any = await io.query(`query VerifyNotificationExactOwner($ownerId: EncodedId!, $invoiceId: EncodedId!) {
    account { id } client(id: $ownerId) { id emails { address primary } phones { number primary } }
    invoice(id: $invoiceId) { id client { id } }
  }`, { ownerId: s.jobberClientId, invoiceId: s.invoiceId });
  const expected = before.identities.find(c => c.id === s.jobberClientId)!;
  if (exact?.account?.id !== r.identityCoveragePolicy.accountId || exact?.client?.id !== s.jobberClientId ||
      !Array.isArray(exact.client.emails) || !Array.isArray(exact.client.phones) ||
      identityKey(exact.client) !== identityKey(expected) || exact.invoice?.id !== s.invoiceId || exact.invoice?.client?.id !== s.jobberClientId)
    throw new Error("Notification exact owner/invoice changed since original coverage");
  const contactObservedAt = new Date(Date.now()).toISOString(), contacts = structuredClone(await io.contacts());
  // Never bless new identifiers/collisions using old coverage; harmless activity/order is not identity.
  if (contactIdentityKey(contacts, s.locationId) !== contactIdentityKey(before.contacts, s.locationId))
    throw new Error("Notification contact identity changed since original coverage");
  const { snapshot: old, ...baseline } = before;
  return readAndIssueSource(baseline, { identityObservedAt: old.identityObservedAt, identityExpiresAt: old.identityExpiresAt,
    identitySourceRef: old.identitySourceRef, ownerRevision: old.ownerRevision, cacheObservedAt, quarantineCountsObservedAt,
    exactOwnerObservedAt, contactObservedAt, coverageReused: true });
}

/** Inspection is not reissuance: a clone or serialized snapshot is not a source handle. */
export function inspectNotificationSource(handle: NotificationSourceHandle): NotificationSourceSnapshot {
  return owned(handle).snapshot;
}

/** Missing metadata is explicit: existing invoice query has no currency/category fields.
 * Only independently trusted readers may supply this, never event/request/ledger values. */
export type NotificationSourceMetadata = Proof & Readonly<{
  accountId: string; invoiceId: string; sourceRevision: string;
  currency: string | null; category: Evidence["source"]["category"]; categoryVerified: boolean;
}>;
export type NotificationExternalEvidence = Readonly<{
  metadata: NotificationSourceMetadata;
  recipient: Evidence["recipient"]; dnd: Evidence["dnd"]; template: Evidence["template"];
  channelAuthorization: Evidence["channelAuthorization"]; facts: Evidence["facts"]; attempts: Evidence["attempts"];
}>;

/** Composes ONLY source/owner evidence from real reads. The remaining independent trusted
 * inputs are copied unchanged, never approved or manufactured here. planNotification still
 * must assess both preflight and strictly newer final evidence; neither can authorize a send. */
export function composeNotificationEvidence(handle: NotificationSourceHandle, event: Event, external: NotificationExternalEvidence) {
  const data = owned(handle), s = data.snapshot, e = structuredClone(event), x = structuredClone(external), at = Date.now();
  const m = x?.metadata;
  assertFresh(m, at);
  if (s.status !== "open" || s.balanceMinor <= 0) throw new Error("Notification source is not open positive balance");
  const validCurrency = typeof m.currency === "string" ? /^[A-Z]{3}$/.test(m.currency)
    : m.currency === null && permitsUnknownCurrency(e);
  if (m.accountId !== s.accountId || m.invoiceId !== s.invoiceId || m.sourceRevision !== s.sourceRevision ||
      !validCurrency || ![null, "maintenance", "irrigation"].includes(m.category) ||
      typeof m.categoryVerified !== "boolean" || (m.category === null ? m.categoryVerified : !m.categoryVerified))
    throw new Error("Independent notification currency/category metadata missing or mismatched");
  if (e.accountId !== s.accountId || e.invoiceId !== s.invoiceId || e.ownerId !== s.ownerId ||
      e.homeownerContactId !== s.homeownerContactId || e.sourceRevision !== s.sourceRevision || e.ownerRevision !== s.ownerRevision ||
      e.issuedDate !== s.issuedDate || e.dueDate !== s.dueDate || e.balanceMinor !== s.balanceMinor ||
      e.currency !== m.currency || e.category !== m.category)
    throw new Error("Notification event changed from exact source/owner evidence");
  assertRecentIdentityRechecks(s, at);
  if (e.audience === "homeowner" && (e.contactId !== s.homeownerContactId ||
      (e.channel === "sms" ? e.destination !== data.homeownerPhone || e.destination !== data.contactPhone
        : e.channel === "email" ? e.destination !== data.homeownerEmail || e.destination !== data.contactEmail : true)))
    throw new Error("Notification homeowner destination is not exact fresh primary identity");
  // Require actual external fields; no historyComplete=true, DND=allowed, facts=true defaults.
  for (const key of ["recipient", "dnd", "template", "channelAuthorization", "attempts"] as const) assertFresh(x[key], at);
  if (!Array.isArray(x.facts)) throw new Error("Independent notification facts evidence missing");
  for (const fact of x.facts) assertFresh(fact, at);
  // Only a real invoice reread may advance the gate's source observation. In particular,
  // replacing old metadata with fresh metadata cannot turn one handle into two source reads.
  // Metadata's own age limit still tightens expiry even if its supplied expiresAt is later.
  const sourceProof: Proof = { observedAt: s.observedAt,
    expiresAt: new Date(Math.min(instant(s.expiresAt), instant(m.expiresAt),
      instant(m.observedAt) + PROPOSAL.maxProofAgeSeconds * 1000)).toISOString(),
    sourceRef: `notification-source-composed:${sha([s.sourceRef, m])}` };
  const ownerProof: Proof = { observedAt: s.identityObservedAt, expiresAt: s.identityExpiresAt, sourceRef: s.identitySourceRef };
  const evidence: Evidence = {
    source: { ...sourceProof, accountId: s.accountId, invoiceId: s.invoiceId, revision: s.sourceRevision,
      available: true, complete: true, status: s.status, balanceMinor: s.balanceMinor, currency: m.currency,
      ownerId: s.ownerId, issuedDate: s.issuedDate, dueDate: s.dueDate, category: m.category, categoryVerified: m.categoryVerified },
    owner: { ...ownerProof, accountId: s.accountId, invoiceId: s.invoiceId, revision: s.ownerRevision,
      ownerId: s.ownerId, homeownerContactId: s.homeownerContactId, exactSourceIdentity: true, complete: true },
    recipient: x.recipient, dnd: x.dnd, template: x.template, channelAuthorization: x.channelAuthorization,
    facts: x.facts, attempts: x.attempts,
  };
  return Object.freeze({ evidence: freezeTree(evidence), productionSendCapability: false as const, timingApproved: false as const });
}
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** Explicit deployed READ bindings, inert until a read is requested. No credential retrieval,
 * refresh, token writes, DB connection, API call or migration occurs in this factory.
 * JobberReader must be supplied from a separately authorized read-only caller. Do NOT pass
 * application jobberGraphQL: its getValidAccessToken path can refresh and write auth tokens.
 * The cache/GHL reads are reused without adding a card/stage or mutation prerequisite. */
export async function deployedNotificationSourceReadBindings(reader: Pick<JobberReader, "query">,
  options: Readonly<{ fetch?: typeof fetch }> = {}): Promise<NotificationSourceIO> {
  const prismaModule = await import("./prisma");
  // The deployed tsx/CJS bridge may expose these under default. Validate without a query.
  const prisma: typeof import("./prisma").prisma = (prismaModule as any).prisma ?? (prismaModule as any).default?.prisma;
  if (typeof prisma?.customer?.findMany !== "function" || typeof prisma?.invoiceRecord?.findMany !== "function" ||
      typeof GhlReadonlyReader !== "function" || typeof readAllContacts !== "function" || typeof reader?.query !== "function")
    throw new Error("Notification read-only deployed module binding unavailable");
  const locationId = process.env.GHL_LOCATION_ID, apiKey = process.env.GHL_API_KEY, fetcher = options.fetch;
  return Object.freeze({
    locationId: () => process.env.GHL_LOCATION_ID,
    customers: () => prisma.customer.findMany({ select: { jobberClientId: true, email: true, phone: true } }),
    storedInvoices: (ownerId: string) => prisma.invoiceRecord.findMany({ where: { customer: { jobberClientId: ownerId } }, select: { jobberInvoiceId: true } }),
    quarantineCounts: async (ids: string[]) => (await prisma.customer.findMany({
      where: { jobberClientId: { in: ids } }, select: { jobberClientId: true, _count: { select: { jobs: true, invoices: true } } },
    })).map(c => ({ jobberClientId: c.jobberClientId, jobs: c._count.jobs, invoices: c._count.invoices })),
    contacts: async () => {
      if (process.env.GHL_LOCATION_ID !== locationId || process.env.GHL_API_KEY !== apiKey)
        throw new Error("Notification GHL read configuration changed");
      const ghl = new GhlReadonlyReader({ locationId: locationId ?? "", apiKey: apiKey ?? "", fetch: fetcher,
        deadlineAt: Date.now() + PROPOSAL.maxProofAgeSeconds * 1000 });
      const result = await readAllContacts(ghl);
      if (result.contacts.some(c => !c.contactShapeValid)) throw new Error("Notification contact identity fields unverified");
      return result.contacts.map(c => ({ id: c.id, locationId: ghl.locationId, email: c.email, phone: c.phone,
        additionalEmails: c.additionalEmails.map(email => ({ email })), additionalPhones: c.additionalPhones.map(phone => ({ phone })) }));
    },
    query: async <T = any>(statement: string, variables?: Record<string, any>): Promise<T> =>
      await reader.query(statement, variables, { maxAttempts: 1, deadlineAt: Date.now() + PROPOSAL.maxProofAgeSeconds * 1000 }) as T,
  });
}
