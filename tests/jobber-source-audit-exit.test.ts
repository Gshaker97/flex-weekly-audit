import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * THE PRE-DEPLOY AUDIT MUST NOT FAIL A DEPLOYMENT OVER WHAT IT FINDS.
 *
 * `scripts/audit-jobber-source.ts` runs as the web service's Railway pre-deploy
 * command, where a non-zero exit fails the whole deployment. On 2026-11-25 that
 * stopped the web service shipping any commit at all: three deployments in a
 * row failed, first on an expired Jobber token, then because an invoice changed
 * while the audit was paging through 241 requests over three minutes. Neither
 * says anything about the code being deployed.
 *
 * These tests run the real script as a subprocess and pin which failures still
 * stop a deployment: only the ones that mean the pre-deploy command itself is
 * wrong.
 */

const SCRIPT = path.join(__dirname, "..", "scripts", "audit-jobber-source.ts");
const TSX = path.join(__dirname, "..", "node_modules", ".bin", "tsx");
const SERVICE = "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f";
const ENVIRONMENT = "bc72bc2d-9a4c-494d-8bee-9ca782db1240";

function runAudit(env: Record<string, string>, args: string[] = ["--run-in-deployment"]) {
  const result = spawnSync(TSX, [SCRIPT, ...args], {
    encoding: "utf8", timeout: 120_000,
    // A deliberately bare environment: nothing from this machine leaks in, so
    // the script cannot accidentally reach a real service or database.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
  });
  const line = result.stdout.split("\n").map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .find(v => v && typeof v === "object" && v.audit === "jobber-source-v1");
  return { status: result.status, report: line as any, stdout: result.stdout, stderr: result.stderr };
}

test("running it without the deliberate deployment flag fails the deployment", () => {
  const r = runAudit({}, []);
  assert.equal(r.report?.code, "EXPLICIT_DEPLOYMENT_FLAG_REQUIRED");
  assert.equal(r.report?.deploymentBlocked, true);
  assert.equal(r.status, 2, "the pre-deploy command itself is wrong, so stop");
});

test("an unrecognised argument fails the deployment rather than being ignored", () => {
  const r = runAudit({}, ["--run-in-deployment", "--write-everything"]);
  assert.equal(r.report?.code, "EXPLICIT_DEPLOYMENT_FLAG_REQUIRED");
  assert.equal(r.status, 2);
});

test("running it outside a Railway deployment fails the deployment", () => {
  const r = runAudit({});
  assert.equal(r.report?.code, "EXISTING_RAILWAY_DEPLOYMENT_REQUIRED");
  assert.equal(r.report?.deploymentBlocked, true);
  assert.equal(r.status, 2);
});

test("running it against the wrong service or environment fails the deployment", () => {
  for (const env of [
    { RAILWAY_SERVICE_ID: "someone-elses-service", RAILWAY_ENVIRONMENT_ID: ENVIRONMENT },
    { RAILWAY_SERVICE_ID: SERVICE, RAILWAY_ENVIRONMENT_ID: "someone-elses-environment" },
    { RAILWAY_SERVICE_ID: SERVICE, RAILWAY_ENVIRONMENT_ID: ENVIRONMENT, RAILWAY_PROJECT_ID: "someone-elses-project" },
  ]) {
    const r = runAudit({ ...env, RAILWAY_DEPLOYMENT_ID: "d1", DATABASE_URL: "postgresql://u:p@127.0.0.1:1/db" });
    assert.equal(r.report?.code, "WRONG_RAILWAY_SERVICE_OR_ENVIRONMENT", JSON.stringify(env));
    assert.equal(r.report?.deploymentBlocked, true);
    assert.equal(r.status, 2, JSON.stringify(env));
  }
});

test("an audit that cannot run at all reports it and lets the deployment through", () => {
  // Right place, right flag, but the database is unreachable. Before this, any
  // such failure exited 2 and took the deployment down with it.
  const r = runAudit({
    RAILWAY_SERVICE_ID: SERVICE, RAILWAY_ENVIRONMENT_ID: ENVIRONMENT, RAILWAY_DEPLOYMENT_ID: "d1",
    DATABASE_URL: "postgresql://nobody:nothing@127.0.0.1:1/nowhere?connect_timeout=2",
  });
  assert.equal(r.report?.outcome, "incomplete");
  assert.equal(r.report?.deploymentBlocked, false, r.stdout.slice(0, 400));
  assert.equal(r.status, 0, "the deployment must go ahead");
  assert.ok(typeof r.report?.code === "string" && r.report.code.length > 0, "and it must still say why");
});
