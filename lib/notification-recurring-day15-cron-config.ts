/** Private deployment installation boundary. No route, command arguments or caller policy. */
import { notificationModuleFunctions } from "./notification-module-interop";
import { createHash } from "node:crypto";
import type { RecurringDay15EmailPolicy } from "./notification-recurring-day15-email";

const MAX_BYTES = 32768;
const ENV_KEYS = ["FLEXX_RECURRING_DAY15_EMAIL_MODE", "FLEXX_RECURRING_DAY15_EMAIL_POLICY_JSON",
  "FLEXX_RECURRING_DAY15_EMAIL_POLICY_SHA256", "FLEXX_RECURRING_DAY15_EMAIL_ACCOUNT_ID",
  "RAILWAY_SERVICE_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_DEPLOYMENT_ID", "GHL_LOCATION_ID"] as const;

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 &&
  value.length <= 256 && value.trim() === value;

/**
 * Integrity checks only: this pure validator does not install a policy or grant
 * authority. The authorized deployer must review and provision BOTH the private value
 * and its pins.
 */
export function validateRecurringDay15EmailCronInstallation(raw: string, env: Record<string, string | undefined>,
  mode: "read-only" | "attempt"): RecurringDay15EmailPolicy {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_BYTES ||
      env.FLEXX_RECURRING_DAY15_EMAIL_MODE !== mode ||
      !/^[a-f0-9]{64}$/.test(env.FLEXX_RECURRING_DAY15_EMAIL_POLICY_SHA256 ?? "") ||
      createHash("sha256").update(raw, "utf8").digest("hex") !== env.FLEXX_RECURRING_DAY15_EMAIL_POLICY_SHA256 ||
      !text(env.FLEXX_RECURRING_DAY15_EMAIL_ACCOUNT_ID) || !text(env.RAILWAY_DEPLOYMENT_ID))
    throw new Error("Private recurring installation unavailable");
  const value = JSON.parse(raw);
  if (!exact(value, ["version", "deployment", "policy"]) || value.version !== 1 ||
      !exact(value.deployment, ["projectId", "environmentId", "serviceId", "accountId", "locationId"]) ||
      !Object.values(value.deployment).every(text) ||
      value.deployment.projectId !== env.RAILWAY_PROJECT_ID ||
      value.deployment.environmentId !== env.RAILWAY_ENVIRONMENT_ID ||
      value.deployment.serviceId !== env.RAILWAY_SERVICE_ID ||
      value.deployment.accountId !== env.FLEXX_RECURRING_DAY15_EMAIL_ACCOUNT_ID ||
      value.deployment.locationId !== env.GHL_LOCATION_ID ||
      value.policy?.accountId !== value.deployment.accountId ||
      value.policy?.locationId !== value.deployment.locationId ||
      mode === "attempt" && value.policy?.action !== "attempt")
    throw new Error("Private recurring installation bindings differ");
  return value.policy;
}

/**
 * Only the admitted standalone hook calls this. A mode switch is not authorization.
 * This loads a standing cohort policy provisioned through authorized deployment, not a
 * per-invoice approval artifact.
 */
export async function loadInstalledRecurringDay15EmailCronService(mode: "read-only" | "attempt") {
  const original = Object.freeze(Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]])));
  const assertUnchanged = () => {
    if (ENV_KEYS.some(key => process.env[key] !== original[key])) throw new Error("Recurring installation changed during run");
  };
  const input = validateRecurringDay15EmailCronInstallation(original.FLEXX_RECURRING_DAY15_EMAIL_POLICY_JSON!, original, mode);
  assertUnchanged();
  const { installRecurringDay15EmailPolicy, createRecurringDay15EmailService, deployedRecurringDay15EmailRuntime } =
    notificationModuleFunctions(await import("./notification-recurring-day15-email"),
      ["installRecurringDay15EmailPolicy", "createRecurringDay15EmailService", "deployedRecurringDay15EmailRuntime"]);
  const policy = installRecurringDay15EmailPolicy(input);
  return createRecurringDay15EmailService({ mode, policy, runtime: async scope => {
    assertUnchanged();
    const runtime = await deployedRecurringDay15EmailRuntime(policy, scope, mode);
    assertUnchanged();
    return Object.freeze({ ...runtime, verifyActiveHolds: () => { assertUnchanged(); runtime.verifyActiveHolds(); } });
  } });
}
