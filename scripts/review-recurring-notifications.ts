/** Default/local readiness is inert. Explicit read-only mode is an operator action, never cron activation. */
import { notificationModuleFunctions } from "../lib/notification-module-interop";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { recurringCoordinatorReadiness, inspectRecurringReadScope, createRecurringNotificationCoordinator,
  type RecurringNotificationReadScope, type RecurringNotificationReadRuntime } from "../lib/notification-recurring-coordinator";
async function main() {
  const [mode, path, sha256, reviewRef, ...extra] = process.argv.slice(2);
  if (!mode) { console.log(JSON.stringify(recurringCoordinatorReadiness())); return; }
  if (!["--readiness", "--read-only"].includes(mode) || !path || !/^[a-f0-9]{64}$/.test(sha256 ?? "") || !reviewRef || extra.length)
    throw new Error("invalid_arguments");
  const timer = setTimeout(() => { console.error("Recurring read-only runtime limit reached. No automatic retry."); process.exit(3); }, 330_000);
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > 32_768) throw new Error("bounded_scope_file_required");
      const bytes = Buffer.alloc(32_769), { bytesRead } = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
      if (bytesRead !== before.size || bytesRead > 32_768 || after.size !== before.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") !== sha256)
        throw new Error("scope_changed_or_hash_mismatched");
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await file.close(); }
    const scope = JSON.parse(raw) as RecurringNotificationReadScope, missing = [...inspectRecurringReadScope(scope)];
    if (scope.reviewRef !== reviewRef) missing.push("out_of_band_read_review_reference_mismatch");
    if (missing.length || mode === "--readiness") {
      console.log(JSON.stringify({ ...recurringCoordinatorReadiness(), scopeState: missing.length ? "held" : "valid_read_scope_shape", missing }));
      return;
    }
    // The separately supplied hash/ref pin reviewed bytes; they do not authenticate the operator
    // or grant permission. Never expose this as an arbitrary user-request endpoint.
    const { bootstrapRecurringNotificationReadRuntime } = notificationModuleFunctions(await import("../lib/notification-recurring-runtime"),
      ["bootstrapRecurringNotificationReadRuntime"]);
    let acquiring: Promise<RecurringNotificationReadRuntime> | undefined, cleanup: (() => Promise<void>) | undefined;
    try {
      const result = await createRecurringNotificationCoordinator({ mode: "read-only", scope,
        runtime: () => {
          acquiring = bootstrapRecurringNotificationReadRuntime(scope, { registerCleanup: close => { cleanup = close; } });
          return acquiring;
        } }).run();
      console.log(JSON.stringify(result)); // Redacted summary only; no source/config/provider payload.
    } finally {
      // A coordinator timeout can precede bootstrap resolution. Keep the outer hard timer
      // alive while draining acquisition, then close even a partially acquired runtime.
      try { await acquiring; } catch { /* Preserve the reported hold; never retry acquisition. */ }
      try { await cleanup?.(); } catch { /* Cleanup never authorizes a retry. */ }
    }
  } finally { clearTimeout(timer); }
}
main().catch(() => { console.error("Recurring inspection held: private read scope or required runtime unavailable. No automatic retry."); process.exitCode = 2; });
