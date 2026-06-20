// Direct stdout/stderr logging for the sync pipeline.
//
// Symptom this fixes: the sync runs to completion (SyncRun rows are written)
// but NO log lines reach Railway's Deploy Logs — not even the unconditional
// `[sync] mode=` line. That means the code executes but its output is being
// lost, not skipped. The sync is kicked off as a detached, fire-and-forget
// promise from the route; Next.js patches the global `console` in production,
// and console output from background work that has escaped the request
// lifecycle can be swallowed before it is captured.
//
// Writing straight to the process streams bypasses any `console` interception
// and lands reliably in the container's stdout/stderr, which Railway captures.

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export function log(...args: unknown[]): void {
  process.stdout.write(format(args) + "\n");
}

export function logError(...args: unknown[]): void {
  process.stderr.write(format(args) + "\n");
}
