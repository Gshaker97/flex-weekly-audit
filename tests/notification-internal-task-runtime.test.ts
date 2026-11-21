import test from "node:test";
import assert from "node:assert/strict";
import {
  bootstrapInternalTaskRuntime, type InternalTaskRuntimeScope,
} from "../lib/notification-internal-task-runtime";
import type { InternalTaskRequest } from "../lib/notification-internal-task";

/**
 * The one place an internal task actually reaches GoHighLevel.
 *
 * Two things are pinned here above all else. A task has no idempotency key, so
 * a replayed POST is a SECOND task in a colleague's list: every failure mode
 * must end the attempt, including 429, which the rest of the GHL client retries.
 * And a 201 is not proof — confirmation only comes from reading the task back.
 */

const LOCATION = "loc-under-test";
const HOLDS = {
  RAILWAY_SERVICE_ID: "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f",
  RAILWAY_ENVIRONMENT_ID: "bc72bc2d-9a4c-494d-8bee-9ca782db1240",
  RAILWAY_PROJECT_ID: "5d7858db-0443-4891-8a95-1eb1261d3e61",
  RAILWAY_DEPLOYMENT_ID: "deploy-under-test",
  DATABASE_URL: "postgresql://not-used.invalid/no",
  GHL_API_KEY: "key-under-test",
  GHL_LOCATION_ID: LOCATION,
  GHL_INVOICE_WRITE_MODE: "review",
  GHL_PHONE_WRITES_ENABLED: "false",
  SYNC_ADMISSION_MODE: "cron_only",
  GHL_NOTIFICATIONS_ENABLED: "false",
};

const ANGIE = { userId: "angie-user-id", displayName: "Angie Wiggins", approvalRef: "owner-2026-11-19" };
const request = (over: Partial<InternalTaskRequest> = {}): InternalTaskRequest => ({
  kind: "day21-call", assignee: ANGIE, contactId: "contact-1", invoiceNumber: "7226",
  invoiceId: "inv-1", dueOn: "2026-11-25", balanceMinor: 16_000, currency: "USD", ...over,
});
const scope = (over: Partial<InternalTaskRuntimeScope> = {}): InternalTaskRuntimeScope => ({
  locationId: LOCATION, action: "one-attempt",
  expiresAt: new Date(Date.now() + 600_000).toISOString(), service: "pilot", ...over,
});
const TASKS_URL = "https://services.leadconnectorhq.com/contacts/contact-1/tasks";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** Runs `body` with the holds in place and global fetch replaced by a script. */
async function withFetch(
  script: (call: Call, index: number) => { status: number; text: string } | Error,
  body: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  Object.assign(process.env, HOLDS);
  const calls: Call[] = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const call: Call = { url, method: init.method ?? "GET", headers: { ...(init.headers ?? {}) },
      body: typeof init.body === "string" ? init.body : null };
    assert.equal(init.redirect, "error", "every request must refuse redirects");
    calls.push(call);
    const outcome = script(call, calls.length - 1);
    if (outcome instanceof Error) throw outcome;
    return { status: outcome.status, redirected: false, url, text: async () => outcome.text } as any;
  }) as any;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}

/** The ordinary happy path: empty list, POST accepted, task found on read-back. */
const happy = (taskId = "task-1") => (call: Call) =>
  call.method === "POST"
    ? { status: 201, text: JSON.stringify({ id: taskId }) }
    : { status: 200, text: JSON.stringify({ tasks: [{ id: taskId, title: "t", completed: false }] }) };

// ------------------------------------------------------------- the scope gates

test("a runtime cannot be bootstrapped without an exact scope", async () => {
  await withFetch(happy(), async () => {
    for (const bad of [undefined, null, {}, { locationId: LOCATION }, { locationId: LOCATION, action: "send" },
      { locationId: "", action: "one-attempt" }, { locationId: LOCATION, action: "one-attempt", service: "web" }]) {
      assert.throws(() => bootstrapInternalTaskRuntime(bad as never), /explicit_exact_runtime_scope_required/,
        JSON.stringify(bad));
    }
  });
});

test("the deployed configuration must be the real one", async () => {
  await withFetch(happy(), async () => {
    for (const [key, value] of [["RAILWAY_SERVICE_ID", "something-else"], ["GHL_LOCATION_ID", "another-location"],
      ["GHL_API_KEY", ""], ["GHL_INVOICE_WRITE_MODE", "live"], ["GHL_NOTIFICATIONS_ENABLED", "true"],
      ["SYNC_ADMISSION_MODE", "any"], ["GHL_PHONE_WRITES_ENABLED", "true"]] as const) {
      const saved = process.env[key];
      process.env[key] = value;
      assert.throws(() => bootstrapInternalTaskRuntime(scope()), /required/, `${key}=${value}`);
      process.env[key] = saved;
    }
  });
});

test("an expired runtime refuses, and contacts nothing", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope({ expiresAt: new Date(Date.now() + 50).toISOString() }));
    await new Promise(resolve => setTimeout(resolve, 80));
    await assert.rejects(() => runtime.create(request()), /configuration_changed_or_expired/);
    assert.equal(calls.length, 0);
  });
});

test("a configuration changed underneath a live runtime refuses", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    process.env.RAILWAY_DEPLOYMENT_ID = "a-different-deployment";
    await assert.rejects(() => runtime.create(request()), /configuration_changed_or_expired/);
    assert.equal(calls.length, 0);
  });
});

test("read-only means no POST leaves the process at all", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope({ action: "read-only" }));
    const result = await runtime.create(request());
    assert.equal(result.state, "held");
    assert.deepEqual([...result.reasons], ["runtime_is_read_only"]);
    assert.equal(calls.length, 0);
    // Reading is still allowed under read-only.
    await runtime.list("contact-1");
    assert.deepEqual(calls.map(c => c.method), ["GET"]);
  });
});

// --------------------------------------------------- the builder still decides

test("a request the builder holds is never sent", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request({ assignee: undefined as never }));
    assert.equal(result.state, "held");
    assert.ok(result.reasons.includes("no_assignee"));
    assert.equal(calls.length, 0, "a task with no owner must not reach GoHighLevel");
  });
});

test("the runtime cannot reword a task or change its owner", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    await runtime.create(request());
    const sent = JSON.parse(calls.find(c => c.method === "POST")!.body!);
    assert.equal(sent.assignedTo, ANGIE.userId);
    assert.match(sent.title, /^Call about past-due invoice #7226 \(USD 160\.00, day 21\)$/);
    assert.match(sent.body, /Day 21 of the past-due ladder/);
    assert.equal(sent.completed, false);
  });
});

// ----------------------------------------------------------------- the write

test("a confirmed task is created once and read back by id", async () => {
  await withFetch(happy("task-xyz"), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "created_and_confirmed");
    assert.equal(result.httpStatus, 201);
    assert.equal(result.taskId, "task-xyz");
    assert.deepEqual([...result.reasons], []);
    // Exactly one POST, then a GET to confirm.
    assert.deepEqual(calls.map(c => c.method), ["POST", "GET"]);
    assert.equal(calls[0].url, TASKS_URL);
  });
});

test("the credential is sent on the wire and never kept in the result", async () => {
  await withFetch(happy(), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(calls[0].headers.Authorization, `Bearer ${HOLDS.GHL_API_KEY}`);
    assert.equal(calls[0].headers.Version, "2021-07-28");
    // The descriptor is the audit trail, so it must stay credential-free.
    assert.ok(!JSON.stringify(result.descriptor).includes(HOLDS.GHL_API_KEY));
    assert.ok(!("Authorization" in (result.descriptor!.headers as Record<string, string>)));
  });
});

test("a 201 whose task is NOT found on read-back is unconfirmed, not success", async () => {
  await withFetch(call => call.method === "POST"
    ? { status: 201, text: JSON.stringify({ id: "task-1" }) }
    : { status: 200, text: JSON.stringify({ tasks: [] }) }, async () => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "attempted_unconfirmed");
    assert.deepEqual([...result.reasons], ["internal_task_not_found_on_read_back"]);
    assert.equal(result.taskId, "task-1");
  });
});

test("a 201 with no readable id is unconfirmed", async () => {
  await withFetch(() => ({ status: 201, text: "ok, created!" }), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "attempted_unconfirmed");
    assert.deepEqual([...result.reasons], ["internal_task_accepted_without_a_readable_id"]);
    assert.equal(result.taskId, null);
    assert.deepEqual(calls.map(c => c.method), ["POST"], "nothing to read back");
  });
});

test("the task id is read from any of the envelopes GoHighLevel has used", async () => {
  for (const envelope of [{ id: "task-1" }, { task: { id: "task-1" } }, { data: { id: "task-1" } }]) {
    await withFetch(call => call.method === "POST"
      ? { status: 201, text: JSON.stringify(envelope) }
      : { status: 200, text: JSON.stringify([{ id: "task-1", title: "t", completed: false }]) }, async () => {
      const runtime = bootstrapInternalTaskRuntime(scope());
      const result = await runtime.create(request());
      assert.equal(result.state, "created_and_confirmed", JSON.stringify(envelope));
    });
  }
});

// ------------------------------------------- a failure is never retried

test("a 429 ends the attempt: a retry would be a second task in her list", async () => {
  await withFetch(() => ({ status: 429, text: "rate limited" }), async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "attempted_unconfirmed");
    assert.equal(result.httpStatus, 429);
    assert.deepEqual([...result.reasons], ["internal_task_http_429"]);
    assert.equal(calls.filter(c => c.method === "POST").length, 1, "exactly one POST, never a replay");
  });
});

test("every other refusal also ends the attempt", async () => {
  for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
    await withFetch(() => ({ status, text: "no" }), async calls => {
      const runtime = bootstrapInternalTaskRuntime(scope());
      const result = await runtime.create(request());
      assert.equal(result.state, "attempted_unconfirmed", String(status));
      assert.equal(result.httpStatus, status);
      assert.equal(calls.length, 1, String(status));
    });
  }
});

test("a timeout is reported as unknown, not as a failure and not retried", async () => {
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  await withFetch(() => abort, async calls => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "attempted_unconfirmed");
    assert.ok(result.reasons.includes("internal_task_attempt_outcome_unknown"));
    assert.equal(result.taskId, null);
    assert.equal(calls.length, 1);
    // It may exist: the descriptor is kept so a person can go and look.
    assert.ok(result.descriptor);
  });
});

test("a failed read-back leaves the attempt unconfirmed, with the id to check", async () => {
  await withFetch(call => call.method === "POST"
    ? { status: 201, text: JSON.stringify({ id: "task-1" }) }
    : { status: 500, text: "nope" }, async () => {
    const runtime = bootstrapInternalTaskRuntime(scope());
    const result = await runtime.create(request());
    assert.equal(result.state, "attempted_unconfirmed");
    assert.ok(result.reasons.includes("internal_task_read_back_failed"));
    assert.equal(result.taskId, "task-1");
  });
});

// --------------------------------------------------------------------- list

test("list reads a contact's tasks and refuses an unusable id", async () => {
  await withFetch(() => ({ status: 200, text: JSON.stringify({ tasks: [
    { id: "a", title: "one", completed: false }, { id: "b", title: "two", completed: true },
    { title: "no id" }] }) }), async () => {
    const runtime = bootstrapInternalTaskRuntime(scope({ action: "read-only" }));
    const rows = await runtime.list("contact-1");
    assert.deepEqual(rows.map(r => r.id), ["a", "b"]);
    assert.equal(rows[1].completed, true);
    await assert.rejects(() => runtime.list("a/b"), /contact_id_unusable/);
  });
});

test("an unreadable or refused list throws rather than reporting no tasks", async () => {
  await withFetch(() => ({ status: 200, text: "<html>" }), async () => {
    const runtime = bootstrapInternalTaskRuntime(scope({ action: "read-only" }));
    await assert.rejects(() => runtime.list("contact-1"), /internal_task_list_unreadable/);
  });
  await withFetch(() => ({ status: 403, text: "no" }), async () => {
    const runtime = bootstrapInternalTaskRuntime(scope({ action: "read-only" }));
    await assert.rejects(() => runtime.list("contact-1"), /internal_task_list_http_403/);
  });
});
