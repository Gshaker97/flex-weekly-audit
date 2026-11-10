/** Inert deployment bindings. Read-only inspection and explicitly installed Day10 service remain separate. */
import type { RecurringNotificationReadRuntime, RecurringNotificationReadScope } from "./notification-recurring-coordinator";
import type { RecurringDay10Runtime } from "./notification-recurring-day10";
import type { NotificationLedgerDatabase } from "./notification-ledger";
import { verifyDay10DeploymentHolds } from "./notification-day10-runtime";

/** Reuses the established no-refresh 900-second auth guard and deployed inventory bindings.
 * No invocation during development. Scope comes from the authenticated application/operator,
 * not a public JSON endpoint; a reviewRef is provenance, never a grant to send messages. */
export async function bootstrapRecurringNotificationReadRuntime(scope: RecurringNotificationReadScope,
  lifecycle: Readonly<{ registerCleanup?(close: () => Promise<void>): void }> = {}): Promise<RecurringNotificationReadRuntime> {
  const runtime = await bootstrapRecurringRuntime(scope, "read-only", lifecycle);
  return Object.freeze({ accountId: runtime.accountId, locationId: runtime.locationId,
    inventoryIO: runtime.inventoryIO, sourceIO: runtime.sourceIO, history: runtime.history, contact: runtime.contact,
    verifyActiveHolds: runtime.verifyActiveHolds, close: runtime.close });
}

/** Exact standalone cron deployment, with all original web-pilot write holds retained. */
export function verifyRecurringDay10DeploymentHolds(env: Record<string, string | undefined>, locationId: string): void {
  verifyDay10DeploymentHolds(env, locationId, "recurring-cron");
}

/** Used only after the service validates its original installed standing policy. */
export async function bootstrapRecurringDay10Runtime(scope: RecurringNotificationReadScope,
  action: "read-only" | "attempt"): Promise<RecurringDay10Runtime> {
  if (!["read-only", "attempt"].includes(action)) throw new Error("Explicit recurring action required");
  return bootstrapRecurringRuntime(scope, action, {}, "recurring-cron");
}
async function bootstrapRecurringRuntime(scope: RecurringNotificationReadScope, action: "read-only" | "attempt",
  lifecycle: Readonly<{ registerCleanup?(close: () => Promise<void>): void }> = {}, service: "pilot" | "recurring-cron" = "pilot") {
  const s = structuredClone(scope), original = Object.fromEntries(["RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID",
    "RAILWAY_DEPLOYMENT_ID", "DATABASE_URL", "GHL_LOCATION_ID", "GHL_API_KEY"].map(key => [key, process.env[key]]));
  const verify = () => {
    verifyDay10DeploymentHolds(process.env, s.locationId, service);
    if (s.version !== 1 || !s.accountId || s.identityCoveragePolicy.accountId !== s.accountId || !s.reviewRef ||
        !Number.isFinite(Date.parse(s.expiresAt)) || Date.now() >= Date.parse(s.expiresAt) ||
        Object.entries(original).some(([key, value]) => process.env[key] !== value)) throw new Error("recurring_read_scope_or_deployment_changed");
  };
  verify();
  const prismaModule = await import("./prisma");
  const prisma: typeof import("./prisma").prisma = (prismaModule as any).prisma ?? (prismaModule as any).default?.prisma;
  // Register immediately after acquisition, before auth reads or any later failing guard.
  // The standalone owner retains this cleanup even when no complete runtime is returned.
  lifecycle.registerCleanup?.(() => prisma.$disconnect());
  const { Budget, JobberReader, requireTokenRunCoverage } = await import("../scripts/source-audit/transport");
  const { deployedNotificationInventoryReadBindings } = await import("./notification-inventory");
  const auth = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
    return tx.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { accessToken: true, expiresAt: true } });
  }, { maxWait: 1000, timeout: 15000 });
  if (!auth?.accessToken) throw new Error("existing_no_refresh_auth_required");
  requireTokenRunCoverage(auth.expiresAt);
  const jobber = new JobberReader(auth.accessToken, auth.expiresAt, new Budget(), (input, init) => { verify(); return fetch(input, init); });
  const ghlFetch: typeof fetch = (input, init) => {
    verify();
    if (init?.method !== "GET" || init.redirect !== "error") throw new Error("recurring_read_only_http_required");
    return fetch(input, init);
  };
  const { assertReadOnlyRequest } = await import("../scripts/ghl-preview/transport");
  const sourceFetch: typeof fetch = (input, init) => {
    verify();
    const url = new URL(String(input)), method = init?.method ?? "";
    if (init?.redirect !== "manual" || !(method === "POST" && url.pathname === "/contacts/search" ||
        method === "GET" && /^\/contacts\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) && url.pathname !== "/contacts/search"))
      throw new Error("recurring_source_read_route_required");
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : null;
    assertReadOnlyRequest(url, method, body);
    if (method === "POST" && body.locationId !== s.locationId) throw new Error("recurring_source_location_mismatch");
    return fetch(input, init);
  };
  const bindings = await deployedNotificationInventoryReadBindings(jobber, { tokenExpiresAt: auth.expiresAt, fetch: sourceFetch,
    cacheRead: read => {
      verify(); return prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
        verify(); return read(tx);
      }, { maxWait: 1000, timeout: 5000 });
    } });
  const history: RecurringNotificationReadRuntime["history"] = {
    accountId: s.accountId, locationId: s.locationId,
    get: async req => {
      verify();
      if (req.method !== "GET" || req.headers.Version !== "2021-04-15" ||
          new URL(req.url).origin !== "https://services.leadconnectorhq.com") throw new Error("recurring_history_contract_mismatch");
      const response = await ghlFetch(req.url, { method: "GET", redirect: "error", signal: req.signal,
        headers: { ...req.headers, Authorization: `Bearer ${original.GHL_API_KEY!}` } });
      if (response.redirected || response.url !== req.url) throw new Error("recurring_history_redirect_or_url_mismatch");
      return { status: response.status, body: response.body };
    },
    select: async (sql, parameters) => {
      verify();
      if (!/^\/\* notification-history:read-only \*\/\s*SELECT\b/.test(sql)) throw new Error("recurring_read_only_sql_required");
      return prisma.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
        return tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...parameters);
      }, { maxWait: 1000, timeout: 5000 });
    },
  };
  const database: NotificationLedgerDatabase = { transaction: work => {
    verify(); return prisma.$transaction(async tx => {
      if (action === "read-only") await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
      return work({ query: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
        verify();
        if (!/^\/\* notification-(?:ledger:(?:reserve|assert|pending|outcome)|runner:history|history:read-only) \*\//.test(sql) ||
            action === "read-only" && !/^\/\*[^]*?\*\/\s*SELECT\b/.test(sql)) throw new Error("Recurring SQL scope not allowed");
        return tx.$queryRawUnsafe<R[]>(sql, ...values);
      } });
    }, { maxWait: 1000, timeout: 5000 });
  } };
  const serviceFetch: typeof fetch = (url, init) => {
    verify();
    if (init?.redirect !== "error" || new URL(String(url)).origin !== "https://services.leadconnectorhq.com" ||
        !(init?.method === "GET" || action === "attempt" && init?.method === "POST" &&
          String(url) === "https://services.leadconnectorhq.com/conversations/messages")) throw new Error("Recurring service HTTP scope not allowed");
    return fetch(url, init);
  };
  return Object.freeze({ accountId: s.accountId, locationId: s.locationId, ...bindings, history, database,
    credential: original.GHL_API_KEY!, fetch: serviceFetch,
    contact: { fetch: ghlFetch, credential: original.GHL_API_KEY!, accountId: s.accountId, locationId: s.locationId,
      scopes: ["contacts.readonly"] }, verifyActiveHolds: verify, close: () => prisma.$disconnect() });
}
