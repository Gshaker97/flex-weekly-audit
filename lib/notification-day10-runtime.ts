/** Explicit deployment bootstrap. Import is inert; invoking bootstrap performs authorized reads. */
import type { Day10PilotRuntime } from "./notification-day10-pilot";
import type { NotificationLedgerDatabase } from "./notification-ledger";

export function verifyDay10DeploymentHolds(env: Record<string, string | undefined>, locationId: string,
  service: "pilot" | "recurring-cron" = "pilot"): void {
  const serviceId = service === "pilot" ? "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f"
    : service === "recurring-cron" ? "ee3a4c67-8b0c-48d2-871d-e20bed336c4a" : null;
  if (!serviceId || env.RAILWAY_SERVICE_ID !== serviceId ||
      env.RAILWAY_ENVIRONMENT_ID !== "bc72bc2d-9a4c-494d-8bee-9ca782db1240" ||
      (env.RAILWAY_PROJECT_ID && env.RAILWAY_PROJECT_ID !== "5d7858db-0443-4891-8a95-1eb1261d3e61") ||
      !env.RAILWAY_DEPLOYMENT_ID || !env.DATABASE_URL || !env.GHL_API_KEY || env.GHL_LOCATION_ID !== locationId)
    throw new Error("existing_exact_deployment_configuration_required");
  if (env.GHL_INVOICE_WRITE_MODE !== "review" || env.GHL_PHONE_WRITES_ENABLED !== "false" ||
      env.SYNC_ADMISSION_MODE !== "cron_only" || env.GHL_NOTIFICATIONS_ENABLED === "true")
    throw new Error("existing_write_and_notification_holds_required");
}
/** No OAuth refresh, token save, schema change or startup/migration call. Do not invoke during development. */
export async function bootstrapDay10PilotRuntime(scope: Readonly<{
  accountId: string; locationId: string; action: "read-only" | "one-attempt"; expiresAt: string;
}>): Promise<Day10PilotRuntime> {
  if (!["read-only", "one-attempt"].includes(scope.action) || !scope.accountId || !scope.locationId)
    throw new Error("explicit_exact_runtime_scope_required");
  verifyDay10DeploymentHolds(process.env, scope.locationId);
  const original = Object.fromEntries(["RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID",
    "RAILWAY_DEPLOYMENT_ID", "DATABASE_URL", "GHL_LOCATION_ID", "GHL_API_KEY"].map(key => [key, process.env[key]]));
  const verify = () => {
    verifyDay10DeploymentHolds(process.env, scope.locationId);
    if (Date.now() >= Date.parse(scope.expiresAt) || !Number.isFinite(Date.parse(scope.expiresAt)) ||
        Object.entries(original).some(([key, value]) => process.env[key] !== value)) throw new Error("pilot_runtime_configuration_changed_or_expired");
  };
  verify();
  const prismaModule = await import("./prisma");
  const prisma: typeof import("./prisma").prisma = (prismaModule as any).prisma ?? (prismaModule as any).default?.prisma;
  if (typeof prisma?.$transaction !== "function") throw new Error("existing_database_binding_unavailable");
  const { Budget, JobberReader, requireTokenRunCoverage } = await import("../scripts/source-audit/transport");
  const { deployedNotificationSourceReadBindings } = await import("./notification-source");
  const auth = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
    return tx.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { accessToken: true, expiresAt: true } });
  }, { maxWait: 1000, timeout: 15000 });
  if (!auth?.accessToken) throw new Error("existing_no_refresh_auth_required");
  requireTokenRunCoverage(auth.expiresAt); // Existing source-audit 900-second coverage guard.
  const fetcher: typeof fetch = (input, init) => { verify(); return fetch(input, init); };
  const jobber = new JobberReader(auth.accessToken, auth.expiresAt, new Budget(), fetcher);
  const source = await deployedNotificationSourceReadBindings(jobber, { fetch: fetcher });
  const sourceIO: Day10PilotRuntime["sourceIO"] = {
    locationId: () => { verify(); return source.locationId(); },
    customers: () => { verify(); return source.customers(); },
    storedInvoices: owner => { verify(); return source.storedInvoices(owner); },
    quarantineCounts: ids => { verify(); return source.quarantineCounts(ids); },
    contacts: () => { verify(); return source.contacts(); },
    query: (sql, variables) => { verify(); return source.query(sql, variables); },
  };
  const database: NotificationLedgerDatabase = {
    transaction: work => {
      verify();
      return prisma.$transaction(async tx => {
        if (scope.action === "read-only") await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '1000ms'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '2500ms'");
        return work({ query: async <R extends Record<string, unknown>>(sql: string, values: readonly unknown[]) => {
          verify();
          if (!/^\/\* notification-(?:ledger:(?:reserve|assert|pending|outcome)|runner:history|history:read-only) \*\//.test(sql) ||
              (scope.action === "read-only" && !/^\/\*[^]*?\*\/\s*SELECT\b/.test(sql))) throw new Error("pilot_sql_scope_not_allowed");
          return tx.$queryRawUnsafe<R[]>(sql, ...values);
        } });
      }, { maxWait: 1000, timeout: 5000 });
    },
  };
  return Object.freeze({ accountId: scope.accountId, locationId: scope.locationId, credential: original.GHL_API_KEY!,
    fetch: fetcher, sourceIO, database, verifyActiveHolds: verify, close: () => prisma.$disconnect() });
}
