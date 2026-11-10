import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
function run(args: string[], env: Record<string,string> = {}) {
  try {
    return { code: 0, output: execFileSync(process.execPath, ["--import", "tsx", "scripts/review-notification-source.ts", ...args], {
      cwd: process.cwd(), env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: "utf8", timeout: 15000, stdio: "pipe",
    }) };
  } catch (e: any) { return { code: e.status, output: String(e.stdout ?? "") + String(e.stderr ?? "") }; }
}
test("private source CLI refuses missing explicit deployment invocation before IO", () => {
  const r = run([]); assert.equal(r.code, 2); assert.match(r.output, /held at configuration/);
});
test("private source CLI rejects other deployment and redacts environment secrets", () => {
  const r = run(["--run-in-deployment", "/not-read.json", "a".repeat(64), "/not-written.json"], {
    RAILWAY_SERVICE_ID: "different-service", DATABASE_URL: "synthetic-private-secret", GHL_API_KEY: "synthetic-private-key",
  });
  assert.equal(r.code, 2); assert.match(r.output, /held at configuration/); assert.doesNotMatch(r.output, /synthetic-private/);
});
test("private source CLI contains read-only auth guard, exact hash, no refresh or sender", () => {
  const code = readFileSync("scripts/review-notification-source.ts", "utf8");
  assert.match(code, /SET TRANSACTION READ ONLY/); assert.match(code, /requireTokenRunCoverage\(auth.expiresAt\)/);
  assert.match(code, /mode: 0o600, flag: "wx"/); assert.match(code, /createHash\("sha256"\)/);
  assert.doesNotMatch(code, /\.send\(|migrate deploy|runFullSync\(|\.refreshToken\(/);
});
test("private source CLI rejects oversized and symlink input before auth and never writes output", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-notification-cli-"));
  const env = { RAILWAY_SERVICE_ID: "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f",
    RAILWAY_ENVIRONMENT_ID: "bc72bc2d-9a4c-494d-8bee-9ca782db1240", RAILWAY_DEPLOYMENT_ID: "synthetic",
    DATABASE_URL: "postgresql://synthetic:synthetic@127.0.0.1:65432/synthetic_not_connected",
    GHL_INVOICE_WRITE_MODE: "review", GHL_PHONE_WRITES_ENABLED: "false", SYNC_ADMISSION_MODE: "cron_only" };
  try {
    const large = join(dir, "large.json"), link = join(dir, "link.json");
    writeFileSync(large, "a".repeat(16_385)); symlinkSync(large, link);
    for (const path of [large, link, dir]) {
      const r = run(["--run-in-deployment", path, "a".repeat(64), join(dir, "not-written.json")], env);
      assert.equal(r.code, 2); assert.match(r.output, /held at configuration/);
      assert.doesNotMatch(r.output, /read_existing_auth/);
    }
    assert.throws(() => readFileSync(join(dir, "not-written.json")));
    const code = readFileSync("scripts/review-notification-source.ts", "utf8");
    assert.ok(code.indexOf("timer = setTimeout") < code.indexOf("await open"));
    assert.match(code, /Buffer.alloc\(16_385\)/); assert.match(code, /O_NOFOLLOW \| constants.O_NONBLOCK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
