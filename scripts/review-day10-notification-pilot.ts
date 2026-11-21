/** Default is inert readiness. No real runtime invocation is authorized by development/tests. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inspectDay10PilotReadiness, reviewDay10PilotConfiguration, createDay10Pilot, deployedDay10PilotRuntime, summarizeDay10PilotExecution, type Day10PilotRuntime } from "../lib/notification-day10-pilot";

async function main() {
  const [mode, path, expectedSha256, reviewRef, ...extra] = process.argv.slice(2);
  if (!mode) { console.log(JSON.stringify(inspectDay10PilotReadiness())); return; }
  if (!["--readiness", "--read-only", "--reviewed-one-attempt"].includes(mode) || !path ||
      !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "") || !reviewRef || extra.length) throw new Error("invalid_arguments");
  const timer = setTimeout(() => { console.error("Day10 pilot runtime limit reached. No retry is authorized."); process.exit(3); }, 120_000);
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let raw: string;
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size < 1 || before.size > 32_768) throw new Error("bounded_config_file_required");
      const bytes = Buffer.alloc(32_769), { bytesRead } = await file.read(bytes, 0, bytes.length, 0), after = await file.stat();
      if (bytesRead !== before.size || bytesRead > 32_768 || after.size !== before.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || createHash("sha256").update(bytes.subarray(0, bytesRead)).digest("hex") !== expectedSha256)
        throw new Error("config_changed_or_hash_mismatched");
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } finally { await file.close(); }
    const reviewed = reviewDay10PilotConfiguration(raw, { configSha256: expectedSha256, reviewRef,
      action: mode === "--reviewed-one-attempt" ? "one-attempt" : "read-only" });
    if (!reviewed.handle || mode === "--readiness") { console.log(JSON.stringify(reviewed.readiness)); return; }
    // Explicit action mode and the out-of-band reviewed hash/ref are the trusted operator boundary,
    // not a public endpoint or proof of authorization obtained from the configuration itself.
    const handle = reviewed.handle;
    let runtime: Day10PilotRuntime | undefined;
    try {
      const result = await createDay10Pilot({ mode: mode === "--read-only" ? "read-only" : "reviewed-one-attempt",
        config: handle, runtime: async () => {
          runtime = await deployedDay10PilotRuntime(handle, mode === "--reviewed-one-attempt" ? "one-attempt" : "read-only");
          return runtime;
        } }).run();
      // Never print provider IDs, destinations, source snapshots, message bodies or credentials.
      console.log(JSON.stringify(summarizeDay10PilotExecution(result)));
    } finally {
      try { await runtime?.close?.(); } catch { /* Cleanup cannot change a send outcome or authorize retry. */ }
    }
  } finally { clearTimeout(timer); }
}
main().catch(() => { console.error("Day10 pilot held: configuration or required runtime evidence unavailable. No retry is authorized."); process.exitCode = 2; });
