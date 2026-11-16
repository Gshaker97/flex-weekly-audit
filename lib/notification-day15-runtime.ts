/**
 * Deployment bootstrap for the Day 15 pilot, on the standalone cron service.
 *
 * It reuses the Day 10 runtime wholesale - the same deployment-hold check, the same
 * no-refresh Jobber auth guard, the same deployed source bindings, the same ledger
 * transaction scope - and adds exactly two things the Day 15 sender needs:
 *
 *   readInvoiceLink  one read-only Jobber query for this invoice's client-hub URI;
 *   consentIO        one read-only GHL GET for the pinned consent submission.
 *
 * The live invoice BALANCE is not added here: it already arrives through the existing
 * source bindings, read fresh from Jobber on every one of the sender's three source
 * reads. Nothing in this module refreshes a token, writes to Jobber, writes to GHL,
 * changes a setting or runs a migration.
 *
 * Import is inert. Calling bootstrap performs authorized reads.
 */
import { verifyDay10DeploymentHolds, bootstrapDay10PilotRuntime } from "./notification-day10-runtime";
import { DAY15_CONSENT_CONTRACT, type Day15ConsentIO } from "./notification-day15-consent-evidence";
import type { Day15SenderRuntime } from "./notification-day15-sender";

/** The standalone cron service, with every Day 10 write and notification hold retained. */
export function verifyDay15DeploymentHolds(env: Record<string, string | undefined>, locationId: string): void {
  verifyDay10DeploymentHolds(env, locationId, "recurring-cron");
}

/** Only this shape is accepted as a client-hub invoice link. Same regex the sender uses. */
const CLIENT_HUB = /^https:\/\/clienthub\.getjobber\.com\/client_hubs\/[0-9a-f-]{36}\/invoices\/[A-Za-z0-9._~-]{1,256}$/;

/**
 * The one Jobber read this module adds. `query` is rejected by the reader unless it
 * begins with `query`, so this cannot become a mutation.
 */
export const DAY15_INVOICE_LINK_QUERY =
  `query ReadDay15InvoiceClientHubLink($invoiceId: EncodedId!) {
    invoice(id: $invoiceId) { id clientHubUri }
  }`;

export type Day15PilotRuntimeBundle = Readonly<{
  sender: Day15SenderRuntime;
  consentIO: Day15ConsentIO;
  close(): Promise<void>;
}>;

/**
 * `action` is the ceiling on what the HTTP boundary will carry: under "read-only"
 * no POST leaves this process at all, whatever the sender asks for.
 */
export async function bootstrapDay15PilotRuntime(scope: Readonly<{
  accountId: string; locationId: string; action: "read-only" | "one-attempt"; expiresAt: string;
}>): Promise<Day15PilotRuntimeBundle> {
  if (!["read-only", "one-attempt"].includes(scope.action) || !scope.accountId || !scope.locationId)
    throw new Error("explicit_exact_runtime_scope_required");
  verifyDay15DeploymentHolds(process.env, scope.locationId);

  // Reuse the Day 10 bootstrap for auth, source bindings, ledger scope and holds.
  // It re-checks the same holds on every guarded call, against the cron service id.
  const base = await bootstrapDay10PilotRuntime({ ...scope, service: "recurring-cron" });
  const credential = base.credential;
  const verify = base.verifyActiveHolds;

  // Narrow the HTTP boundary. GET anywhere on the GHL service origin; POST only to the
  // one send route, and only when a single attempt is the approved action.
  const guarded: typeof fetch = (input, init) => {
    verify();
    const url = String(input);
    const method = init?.method ?? "GET";
    if (init?.redirect !== "error") throw new Error("day15_redirect_refusal_required");
    if (new URL(url).origin !== DAY15_CONSENT_CONTRACT.origin) throw new Error("day15_http_origin_not_allowed");
    if (method === "GET") return base.fetch(input, init);
    if (method === "POST" && scope.action === "one-attempt" &&
        url === `${DAY15_CONSENT_CONTRACT.origin}/conversations/messages`) return base.fetch(input, init);
    throw new Error("day15_http_scope_not_allowed");
  };

  const sender: Day15SenderRuntime = Object.freeze({
    accountId: base.accountId, locationId: base.locationId, credential,
    fetch: guarded, sourceIO: base.sourceIO, database: base.database,
    verifyActiveHolds: verify,
    readInvoiceLink: async (invoiceId: string) => {
      verify();
      const result: any = await base.sourceIO.query(DAY15_INVOICE_LINK_QUERY, { invoiceId });
      const invoice = result?.invoice;
      if (!invoice || invoice.id !== invoiceId) throw new Error("day15_invoice_link_read_identity_mismatch");
      const url = invoice.clientHubUri;
      if (typeof url !== "string" || !CLIENT_HUB.test(url)) throw new Error("day15_invoice_link_shape_unverified");
      verify();
      return url;
    },
    close: base.close,
  });

  const consentIO: Day15ConsentIO = Object.freeze({
    get: async request => {
      verify();
      if (request.method !== "GET" || request.headers.Version !== DAY15_CONSENT_CONTRACT.version)
        throw new Error("day15_consent_contract_drift");
      const url = new URL(request.url);
      if (url.origin !== DAY15_CONSENT_CONTRACT.origin || url.pathname !== DAY15_CONSENT_CONTRACT.path)
        throw new Error("day15_consent_route_not_allowed");
      const response = await guarded(request.url, {
        method: "GET", redirect: "error", signal: request.signal,
        headers: { ...request.headers, Authorization: `Bearer ${credential}` },
      });
      if (response.redirected || response.url !== request.url) throw new Error("day15_consent_redirect_or_url_mismatch");
      // Bounded read: the contract's cap, enforced here rather than trusting the body.
      const text = (await response.text()).slice(0, DAY15_CONSENT_CONTRACT.maxResponseBytes);
      verify();
      return { status: response.status, text };
    },
  });

  return Object.freeze({ sender, consentIO, close: () => base.close?.() ?? Promise.resolve() });
}
