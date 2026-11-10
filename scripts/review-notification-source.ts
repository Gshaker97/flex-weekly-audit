/** Private source-only report. No migration, writer, send, workflow, refresh or eligibility claim.
 * node --import tsx scripts/review-notification-source.ts --run-in-deployment request.json sha256 report.json
 */
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { prisma } from "../lib/prisma";
import { Budget, JobberReader, requireTokenRunCoverage } from "./source-audit/transport";
import { deployedNotificationSourceReadBindings, readNotificationSource, refreshNotificationSource,
  inspectNotificationSource, type NotificationSourceRequest } from "../lib/notification-source";

let stage = "configuration";
let timer: ReturnType<typeof setTimeout> | undefined;
async function main() {
  const [flag, input, expectedHash, output, ...extra] = process.argv.slice(2);
  if (flag !== "--run-in-deployment" || !input || !output || input === output || extra.length
      || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) throw new Error("invalid_arguments");
  timer = setTimeout(() => { console.error("Notification source review stopped at its runtime limit. No send or migration attempted."); process.exit(3); }, 600_000);
  if (process.env.RAILWAY_SERVICE_ID !== "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f"
      || process.env.RAILWAY_ENVIRONMENT_ID !== "bc72bc2d-9a4c-494d-8bee-9ca782db1240"
      || (process.env.RAILWAY_PROJECT_ID && process.env.RAILWAY_PROJECT_ID !== "5d7858db-0443-4891-8a95-1eb1261d3e61")
      || !process.env.RAILWAY_DEPLOYMENT_ID || !process.env.DATABASE_URL)
    throw new Error("existing_web_deployment_required");
  if (process.env.GHL_INVOICE_WRITE_MODE !== "review" || process.env.GHL_PHONE_WRITES_ENABLED !== "false"
      || process.env.SYNC_ADMISSION_MODE !== "cron_only" || process.env.GHL_NOTIFICATIONS_ENABLED === "true")
    throw new Error("existing_holds_required");
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 16_384) throw new Error("request_file_invalid");
    const bytes = Buffer.alloc(16_385), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs || bytesRead > 16_384) throw new Error("request_file_changed_or_oversize");
    const body = bytes.subarray(0, bytesRead);
    if (createHash("sha256").update(body).digest("hex") !== expectedHash) throw new Error("request_hash_invalid");
    raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } finally { await file.close(); }
  const request = JSON.parse(raw) as NotificationSourceRequest;
  stage = "read_existing_auth";
  const auth = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
    return tx.jobberAuth.findFirst({ orderBy: { createdAt: "desc" }, select: { accessToken: true, expiresAt: true } });
  }, { maxWait: 1000, timeout: 15000 });
  if (!auth?.accessToken) throw new Error("existing_auth_missing");
  requireTokenRunCoverage(auth.expiresAt); // Preserve the established 900-second coverage guard.
  const budget = new Budget(), reader = new JobberReader(auth.accessToken, auth.expiresAt, budget);
  const io = await deployedNotificationSourceReadBindings(reader);
  stage = "initial_source_identity_read";
  const handle = await readNotificationSource(request, io), initial = inspectNotificationSource(handle);
  stage = "final_exact_source_read";
  const refreshed = await refreshNotificationSource(handle), final = inspectNotificationSource(refreshed);
  stage = "write_private_report";
  // Full snapshot remains private. No email/phone, raw token or provider response is logged.
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), mode: "read_only_source_review",
    requestSha256: expectedHash, initial, final, sourceRequests: budget.requests,
    productionSendCapability: false, notificationActivationReady: false,
    limitations: ["Source and identity evidence only; no recipient suppression, sender, template approval, historical attempt or delivery proof is granted.",
      "No database migration, writer admission, OAuth refresh, invoice mutation, GHL mutation, workflow change or message send was attempted.",
      "Jobber and GHL reads are not one atomic snapshot. Original observation times and proof expiry are retained."] }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log("Saved private notification source report. No send or migration attempted.");
}
main().catch(() => { console.error(`Notification source review held at ${stage}. No send or migration attempted.`); process.exitCode = 2; })
  .finally(async () => { await prisma.$disconnect(); if (timer) clearTimeout(timer); });
