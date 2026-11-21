/** Private deployment installation boundary. No route, command arguments or caller policy. */
import { notificationModuleFunctions } from "./notification-module-interop";
import { createHash } from "node:crypto";
import type { RecurringDay10Policy } from "./notification-recurring-day10";

const MAX_BYTES = 32768;
const ENV_KEYS = ["FLEXX_RECURRING_DAY10_MODE", "FLEXX_RECURRING_DAY10_POLICY_JSON", "FLEXX_RECURRING_DAY10_POLICY_SHA256", "FLEXX_RECURRING_DAY10_ACCOUNT_ID",
  "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_DEPLOYMENT_ID", "GHL_LOCATION_ID"] as const;
const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;

/** Integrity checks only: this pure validator does not install a policy or grant authority.
 * The authorized deployer must review and provision BOTH the private value and its pins. */
export function validateRecurringDay10CronInstallation(raw: string, env: Record<string, string | undefined>, mode: "read-only" | "attempt"): RecurringDay10Policy {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BYTES || env.FLEXX_RECURRING_DAY10_MODE !== mode ||
      !/^[a-f0-9]{64}$/.test(env.FLEXX_RECURRING_DAY10_POLICY_SHA256 ?? "") ||
      createHash("sha256").update(raw, "utf8").digest("hex") !== env.FLEXX_RECURRING_DAY10_POLICY_SHA256 ||
      !text(env.FLEXX_RECURRING_DAY10_ACCOUNT_ID) || !text(env.RAILWAY_DEPLOYMENT_ID)) throw new Error("Private recurring installation unavailable");
  const value = JSON.parse(raw);
  if (!exact(value, ["version", "deployment", "policy"]) || value.version !== 1 ||
      !exact(value.deployment, ["projectId", "environmentId", "serviceId", "accountId", "locationId"]) ||
      !Object.values(value.deployment).every(text) ||
      value.deployment.projectId !== env.RAILWAY_PROJECT_ID || value.deployment.environmentId !== env.RAILWAY_ENVIRONMENT_ID ||
      value.deployment.serviceId !== env.RAILWAY_SERVICE_ID || value.deployment.accountId !== env.FLEXX_RECURRING_DAY10_ACCOUNT_ID ||
      value.deployment.locationId !== env.GHL_LOCATION_ID || value.policy?.accountId !== value.deployment.accountId ||
      value.policy?.locationId !== value.deployment.locationId || mode === "attempt" && value.policy?.action !== "attempt")
    throw new Error("Private recurring installation bindings differ");
  return value.policy;
}

/** Only the admitted standalone hook calls this. A mode switch is not authorization.
 * This loads a standing cohort policy provisioned through authorized deployment, not a
 * per-invoice approval artifact. Its original dates, content and limits are never renewed. */
export async function loadInstalledRecurringDay10CronService(mode: "read-only" | "attempt") {
  const original = Object.freeze(Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])));
  const assertUnchanged = () => {
    if (ENV_KEYS.some(key => process.env[key] !== original[key])) throw new Error("Recurring installation changed during run");
  };
  // A private Railway service variable is installed by the authorized deployer,
  // not supplied by a route/caller. No new file mount, volume or startup script.
  const input = validateRecurringDay10CronInstallation(original.FLEXX_RECURRING_DAY10_POLICY_JSON!, original, mode);
  assertUnchanged();
  const { installRecurringDay10Policy, createRecurringDay10Service, deployedRecurringDay10Runtime } = notificationModuleFunctions(await import("./notification-recurring-day10"),
    ["installRecurringDay10Policy", "createRecurringDay10Service", "deployedRecurringDay10Runtime"]);
  const policy = installRecurringDay10Policy(input);
  return createRecurringDay10Service({ mode, policy, runtime: async scope => {
    assertUnchanged();
    const runtime = await deployedRecurringDay10Runtime(policy, scope, mode);
    assertUnchanged();
    return Object.freeze({ ...runtime, verifyActiveHolds: () => { assertUnchanged(); runtime.verifyActiveHolds(); } });
  } });
}
