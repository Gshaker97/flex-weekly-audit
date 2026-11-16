// Day 15 fee-free homeowner SMS, one approved invoice, on the standalone cron service.
//
// DEFAULT IS OFF AND DEFAULT IS NO SEND.
//
//   - Unset FLEXX_DAY15_PILOT_MODE: this script reads nothing and returns. It does not
//     open the database, contact Jobber or contact GoHighLevel.
//   - FLEXX_DAY15_PILOT_MODE=read-only: the full path runs with the HTTP boundary
//     refusing every POST, so no message can leave the process.
//   - FLEXX_DAY15_PILOT_MODE=one-attempt: still read-only UNLESS the command line also
//     carries --approved-one-attempt. Neither signal alone can send.
//
// Nothing in here schedules itself. The cron service's start command is
// `npm run sync:cron`; this entrypoint is not part of it and is not invoked by it.
//
// The configuration names exactly one invoice, and FLEXX_DAY15_ALLOWED_INVOICE_ID must
// name the same one, or the run holds. Consent is the pinned submission re-read, never
// a fresh search. Balance and invoice link are read live from Jobber by the sender.
import { runDay15Pilot, describeDay15PilotOutcome, type Day15PilotApproval } from "../lib/notification-day15-pilot-run";
import { parseDay15ConsentPin } from "../lib/notification-day15-consent-evidence";
import { bootstrapDay15PilotRuntime } from "../lib/notification-day15-runtime";
import { phoenixParts, withinArizonaWindow } from "../lib/reminder-evaluation";

const MAX_CONFIG_BYTES = 32_768;

function approval(): Day15PilotApproval | null {
  const action = process.env.FLEXX_DAY15_PILOT_MODE;
  if (action !== "read-only" && action !== "one-attempt") return null;
  const configSha256 = process.env.FLEXX_DAY15_REVIEW_SHA256 ?? "";
  const reviewRef = process.env.FLEXX_DAY15_REVIEW_REF ?? "";
  const allowedInvoiceId = process.env.FLEXX_DAY15_ALLOWED_INVOICE_ID ?? "";
  if (!configSha256 || !reviewRef || !allowedInvoiceId) return null;
  return Object.freeze({ configSha256, reviewRef, allowedInvoiceId, action });
}

async function main() {
  const action = process.env.FLEXX_DAY15_PILOT_MODE;
  if (action !== "read-only" && action !== "one-attempt") {
    console.log(`[day15-pilot] disabled (FLEXX_DAY15_PILOT_MODE=${action ?? "unset"}); nothing read, nothing contacted`);
    return;
  }
  const confirmed = process.argv.includes("--approved-one-attempt");
  const now = new Date();
  const parts = phoenixParts(now);
  console.log(`[day15-pilot] phoenix=${parts?.date} ${String(parts?.hour).padStart(2, "0")}:${String(parts?.minute).padStart(2, "0")} ` +
    `inWindow=${withinArizonaWindow(now)} action=${action} oneAttemptConfirmed=${confirmed}`);

  const given = approval();
  if (!given) {
    console.log("[day15-pilot] state=no_approval mode=none reasons=[incomplete_out_of_band_pilot_approval]");
    return;
  }

  const outcome = await runDay15Pilot({
    approval: () => given,
    oneAttemptConfirmed: () => confirmed,
    consentPin: () => parseDay15ConsentPin(process.env.FLEXX_DAY15_CONSENT_PIN),
    readConfiguration: async () => {
      const path = process.env.FLEXX_DAY15_CONFIG_PATH;
      if (!path) return undefined;
      const { readFile, stat } = await import("node:fs/promises");
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return undefined;
      return readFile(path, "utf8");
    },
    consentIO: async () => (await bundle()).consentIO,
    runtime: async () => (await bundle()).sender,
  });

  console.log(describeDay15PilotOutcome(outcome));
  if (outcome.readiness && outcome.readiness.missing.length)
    console.log(`[day15-pilot] configuration missing=[${outcome.readiness.missing.join("; ")}]`);
  await close();
}

// One bundle per process. The consent read and the sender share one Jobber auth read,
// one database binding and one HTTP boundary, so holds are verified against the same
// configuration snapshot throughout.
let pending: ReturnType<typeof bootstrapDay15PilotRuntime> | null = null;
function bundle() {
  const action = process.env.FLEXX_DAY15_PILOT_MODE === "one-attempt" && process.argv.includes("--approved-one-attempt")
    ? "one-attempt" as const : "read-only" as const;
  pending ??= bootstrapDay15PilotRuntime({
    accountId: process.env.FLEXX_DAY15_ACCOUNT_ID ?? "",
    locationId: process.env.GHL_LOCATION_ID ?? "",
    action,
    // The sender clamps its own expiry to the configuration's; this is the outer bound.
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  });
  return pending;
}
async function close() {
  if (!pending) return;
  try { await (await pending).close(); } catch { /* cleanup only */ }
}

main()
  .then(async () => { await close(); process.exit(0); })
  .catch(async (err: any) => {
    // Reason only. No message text, no phone number, no credential.
    console.error(`[day15-pilot] failed: ${err?.message ?? "unknown"}`);
    await close();
    process.exit(1);
  });
