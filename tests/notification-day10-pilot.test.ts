import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectDay10PilotReadiness, reviewDay10PilotConfiguration, createDay10Pilot,
  summarizeDay10PilotExecution, type Day10PilotConfig, type Day10PilotRuntime } from "../lib/notification-day10-pilot";
import { ORIGINAL_DAY10_SMS_BODY } from "../lib/notification-copy-policy";
import { verifyDay10DeploymentHolds } from "../lib/notification-day10-runtime";
import type { NotificationLedgerDatabase, NotificationLedgerTransaction } from "../lib/notification-ledger";

const START = Date.parse("2026-11-09T16:05:00.000Z"), hash = (s: string) => createHash("sha256").update(s).digest("hex");
let sequence = 0;
async function clocked(run: (tick: (ms?: number) => void) => Promise<void>) {
  const old = Date.now; let ms = START; Date.now = () => ms;
  try { await run((delta = 1) => { ms += delta; }); } finally { Date.now = old; }
}
function config(): Day10PilotConfig {
  const invoiceId = `synthetic-pilot-${++sequence}`;
  return { version: 1, kind: "day10-homeowner-sms-pilot", reviewRef: "synthetic-operator-review",
    reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 120_000).toISOString(),
    source: { version: 1, reviewRef: "synthetic-source", expiresAt: new Date(START + 300_000).toISOString(),
      scope: { locationId: "synthetic-location", jobberClientId: "synthetic-owner", contactId: "synthetic-contact", invoiceId },
      originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-20", dueDate: "2026-10-30" },
      identityCoveragePolicy: { accountId: "synthetic-account", reviewRef: "synthetic-coverage",
        reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 300_000).toISOString(),
        quarantine: [{ jobberClientId: "missing-a", email: null, phone: null }, { jobberClientId: "missing-b", email: null, phone: null }] } },
    destination: "+12025550123", scope: { scheduledOn: "2026-11-09", dayPastDue: 10, audience: "homeowner", channel: "sms", maximumAttempts: 1,
      history: "accessible-ghl-plus-local-ledger", timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)",
      authorizationRef: "synthetic-finite-attempt", timingRef: "synthetic-timing", credentialBindingRef: "synthetic-scope-review" },
    currencyPolicy: { accountId: "synthetic-account", invoiceId, currency: "USD", minorUnitExponent: 2, evidenceRef: "synthetic-currency-policy" },
    sender: { number: "+12025550124", approvalRef: "synthetic-sender-approval", writeScopeEvidenceRef: "synthetic-write-scope" },
    template: { id: "synthetic-day10", version: "1", body: "SYNTHETIC ONLY: Invoice {{invoiceNumber}} has {{balance}} outstanding, due {{dueDate}}.",
      policy: "day10-open-balance-no-enforcement", approvalRef: "synthetic-render-policy" },
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", semanticsRef: "synthetic-native-observation",
      footer: { mode: "exact-native-suffix", suffix: "\nReply STOP to unsubscribe.\nThanks, Synthetic Company", evidenceRef: "synthetic-exact-footer" } } };
}
class Database implements NotificationLedgerDatabase {
  rows: Record<string, any>[] = []; operations: string[] = [];
  hook: ((operation: string) => void) | null = null;
  fail: string | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    let operation = "";
    const value = await work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      operation = /notification-(ledger|runner|history):([\w-]+)/.exec(sql)!.slice(1).join(":"); this.operations.push(operation);
      if (this.fail === operation) throw new Error("secret database failure");
      if (operation === "history:read-only") return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.contactId === v[1])) as R[];
      if (operation === "runner:history") return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.eventKey === v[1])) as R[];
      if (operation === "ledger:reserve") {
        if (this.rows.some(r => r.eventKey === v[2])) return [];
        const e = JSON.parse(v[10] as string), row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], invoiceId: v[4],
          dayPastDue: v[5], audience: v[6], contactId: v[7], scheduledOn: v[8], channel: v[9], eventPayload: e,
          eventHash: v[13], bodyHash: v[14], destinationHash: v[15], state: "reserved", providerMessageId: null };
        this.rows.push(row); return [{ id: row.id }] as unknown as R[];
      }
      const row = this.rows.find(r => r.id === v[0]);
      if (!row || row.reservationToken !== v[1] || row.eventHash !== v[2] || row.bodyHash !== v[3] || row.destinationHash !== v[4] ||
          row.state !== (operation === "ledger:outcome" ? "pending" : "reserved")) return [];
      if (operation === "ledger:pending") row.state = "pending";
      if (operation === "ledger:outcome") { row.state = v[5]; row.providerMessageId = v[6]; }
      return [{ id: row.id }] as unknown as R[];
    } });
    this.hook?.(operation); return value;
  }
}
function fixture(tick: (ms?: number) => void, c = config()) {
  const db = new Database(), calls: { url: string; method: string; version: string | null; body?: string }[] = [];
  const data = { dnd: "inactive" as string | undefined, globalDnd: false, senderSms: true, historyOutbound: false,
    historyTotal: 0, historyFail: false, paid: false, ownerChanged: false, amount: 137, dueDate: "2026-10-30", invoiceNumber: "1234" as string | null, sourceReads: 0, bootstrap: 0,
    holds: true, postStatus: 201, postThrow: false, senderCalls: 0, posts: 0, destination: c.destination, noCurrency: false };
  const owner = { jobberClientId: "synthetic-owner", email: "synthetic@example.invalid", phone: c.destination };
  const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }], phones: [{ number: owner.phone, primary: true }] };
  const runtime: Day10PilotRuntime = { accountId: "synthetic-account", locationId: "synthetic-location", credential: "synthetic-fake-token",
    database: db, verifyActiveHolds: () => { if (!data.holds) throw new Error("holds changed"); },
    sourceIO: { locationId: () => "synthetic-location", customers: async () => { tick(); return [owner, ...c.source.identityCoveragePolicy.quarantine]; },
      contacts: async () => { tick(); return [{ id: "synthetic-contact", locationId: "synthetic-location", phone: data.destination, email: owner.email }]; },
      storedInvoices: async () => [{ jobberInvoiceId: c.source.scope.invoiceId }],
      quarantineCounts: async () => c.source.identityCoveragePolicy.quarantine.map(q => ({ jobberClientId: q.jobberClientId, jobs: 0, invoices: 0 })),
      query: async <T = any>(q: string): Promise<T> => {
        tick(); let result: unknown;
        if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: "synthetic-account" }, clients: {
          nodes: q.includes("isArchived: false") ? [fresh] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
        else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "synthetic-account" }, client: null };
        else if (q.includes("VerifyDateOwnerInvoices")) {
          data.sourceReads++; result = { account: { id: "synthetic-account" }, client: { id: owner.jobberClientId, invoices: {
            nodes: [{ id: c.source.scope.invoiceId, invoiceNumber: data.invoiceNumber, client: { id: owner.jobberClientId }, invoiceStatus: data.paid ? "paid" : "past_due",
              amounts: { total: 137, invoiceBalance: data.paid ? 0 : data.amount }, issuedDate: "2026-10-20", dueDate: data.dueDate }],
            pageInfo: { hasNextPage: false, endCursor: null } } } };
        } else result = { account: { id: "synthetic-account" }, client: fresh,
          invoice: { id: c.source.scope.invoiceId, client: { id: data.ownerChanged ? "other" : owner.jobberClientId } } };
        return structuredClone(result) as T;
      } },
    fetch: (async (input, init) => {
      tick(); const url = String(input), method = init?.method ?? "GET", headers = new Headers(init?.headers);
      calls.push({ url, method, version: headers.get("Version"), body: init?.body as string | undefined });
      let body: unknown, status = 200;
      if (url.includes("/phone-system/")) {
        data.senderCalls++; assert.equal(headers.get("Version"), "v3");
        body = { status: "success", statusCode: 200, message: "ok", data: { page: 0, pageSize: 100, accountStatus: "active",
          numbers: [{ phoneNumber: c.sender!.number, capabilities: { sms: data.senderSms } }] } };
      } else if (url.includes("/contacts/")) {
        assert.equal(headers.get("Version"), "2021-07-28");
        body = { contact: { id: "synthetic-contact", locationId: "synthetic-location", phone: data.destination,
          dnd: data.globalDnd, dndSettings: { SMS: { status: data.dnd } } } };
      } else if (url.includes("/conversations/search")) {
        assert.equal(headers.get("Version"), "2021-04-15");
        if (data.historyFail) throw new Error("secret HTTP failure");
        body = data.historyOutbound ? { total: 1, conversations: [{ id: "synthetic-conversation", contactId: "synthetic-contact", locationId: "synthetic-location" }] }
          : { total: data.historyTotal, conversations: [] };
      } else if (url.includes("/synthetic-conversation/messages")) {
        body = { messages: { nextPage: false, lastMessageId: "synthetic-old", messages: [{ id: "synthetic-old", type: 2,
          messageType: "TYPE_SMS", direction: "outbound", status: "delivered", contactId: "synthetic-contact", locationId: "synthetic-location",
          conversationId: "synthetic-conversation", dateAdded: "2026-11-08T16:00:00.000Z" }] } };
      } else if (url.endsWith("/conversations/messages")) {
        assert.equal(method, "POST"); assert.equal(data.sourceReads, 3); assert.equal(db.rows[0].state, "pending");
        data.posts++; if (data.postThrow) throw new Error("uncertain send");
        status = data.postStatus; body = { messageId: "synthetic-message", conversationId: "synthetic-conversation" };
      } else throw new Error("unexpected URL");
      const response = new Response(JSON.stringify(body), { status });
      Object.defineProperty(response, "url", { value: url }); return response;
    }) as typeof fetch,
  };
  function reviewed(action: "read-only" | "one-attempt" = "one-attempt") {
    const raw = JSON.stringify(c), result = reviewDay10PilotConfiguration(raw, { configSha256: hash(raw), reviewRef: c.reviewRef, action });
    assert.ok(result.handle, JSON.stringify(result.readiness)); return result.handle;
  }
  const run = (mode: "read-only" | "reviewed-one-attempt" = "reviewed-one-attempt") => createDay10Pilot({ mode,
    config: reviewed(mode === "read-only" ? "read-only" : "one-attempt"), runtime: async () => { data.bootstrap++; return runtime; } });
  return { c, data, db, calls, runtime, reviewed, run };
}

test("default pilot is an exact no-op and does not inspect config/runtime getters", async () => {
  const p = createDay10Pilot({ get config(): never { throw new Error("config getter"); }, get runtime(): never { throw new Error("runtime getter"); } });
  assert.equal((await p.run()).state, "disabled"); assert.equal((await p.run()).state, "disabled");
});
test("configuration readiness names concrete missing policy without IO", () => clocked(async tick => {
  const f = fixture(tick); (f.c as any).currencyPolicy = null;
  const raw = JSON.stringify(f.c), r = inspectDay10PilotReadiness(raw, { configSha256: hash(raw), reviewRef: f.c.reviewRef, action: "read-only" });
  assert.equal(r.state, "held"); assert.ok(r.missing.includes("reviewed_exact_invoice_currency_policy"));
  assert.ok(r.actualRuntimeChecks.includes("fresh_channel_dnd_contact_get_2021_07_28")); assert.equal(f.data.bootstrap, 0); assert.equal(f.calls.length, 0);
}));
for (const kind of ["hash", "review ref", "expiry", "currency", "sender", "template", "footer", "semantics", "schedule", "scope", "unknown token", "boolean approval"])
  test(`configuration ${kind} cannot authorize bootstrap`, () => clocked(async tick => {
    const f = fixture(tick), c: any = f.c;
    if (kind === "expiry") c.expiresAt = new Date(START).toISOString();
    if (kind === "currency") c.currencyPolicy = null;
    if (kind === "sender") c.sender = null;
    if (kind === "template") c.template = null;
    if (kind === "footer") c.nativeSms.footer = null;
    if (kind === "semantics") c.nativeSms.semanticsRef = "";
    if (kind === "schedule") c.scope.scheduledOn = "2026-11-10";
    if (kind === "scope") c.scope.maximumAttempts = 2;
    if (kind === "unknown token") c.template.body += " {{guess}}";
    if (kind === "boolean approval") c.approved = true;
    const raw = JSON.stringify(c), r = reviewDay10PilotConfiguration(raw, { configSha256: kind === "hash" ? "0".repeat(64) : hash(raw),
      reviewRef: kind === "review ref" ? "other" : c.reviewRef, action: "one-attempt" });
    assert.equal(r.handle, null, kind); assert.equal(f.data.bootstrap, 0); assert.equal(f.db.operations.length, 0);
  }));
test("read-only performs real source/sender/contact/history checks but never reserves or POSTs", () => clocked(async tick => {
  const f = fixture(tick), out = await f.run("read-only").run();
  assert.equal(out.phase, "read_only", JSON.stringify(out)); assert.equal(out.reservationCreated, false); assert.equal(out.attempted, false);
  assert.equal(f.data.sourceReads, 2); assert.equal(f.data.senderCalls, 3); assert.equal(f.data.posts, 0);
  assert.ok(f.db.operations.every(op => op === "history:read-only" || op === "runner:history")); assert.equal(f.db.rows.length, 0);
}));
test("real pilot derives dynamic event/body and makes exactly one SMS 201 attempt through actual runner", () => clocked(async tick => {
  const f = fixture(tick), pilot = f.run(), out = await pilot.run();
  assert.equal(out.state, "accepted", JSON.stringify(out)); assert.equal(f.data.posts, 1); assert.equal(f.data.sourceReads, 3);
  assert.equal(f.data.senderCalls, 4); assert.equal(f.db.operations.filter(op => op === "ledger:pending").length, 1);
  const wire = JSON.parse(f.calls.find(c => c.method === "POST")!.body!);
  assert.equal(wire.message, "SYNTHETIC ONLY: Invoice 1234 has USD 137.00 outstanding, due 2026-10-30.");
  assert.equal(wire.status, "pending"); assert.equal(wire.toNumber, f.c.destination); assert.equal(wire.fromNumber, f.c.sender!.number);
  assert.equal(wire.message.includes("Reply STOP"), false); // Receipt suffix is not appended to the outbound payload.
  assert.equal(f.db.rows[0].eventPayload.balanceMinor, 13700); assert.match(f.db.rows[0].eventPayload.sourceRevision, /^[a-f0-9]{64}$/);
  assert.equal((await pilot.run()).state, "held"); assert.equal(f.data.posts, 1); assert.equal(out.transport!.deliveryConfirmed, false);
}));
for (const kind of ["paid", "owner", "destination", "dnd", "missing dnd", "sender", "history", "unmatched outbound", "search continuation", "holds", "ledger unavailable"])
  test(`real pilot ${kind} failure has no preflight writes`, () => clocked(async tick => {
    const f = fixture(tick);
    if (kind === "paid") f.data.paid = true;
    if (kind === "owner") f.data.ownerChanged = true;
    if (kind === "destination") f.data.destination = "+12025550125";
    if (kind === "dnd") f.data.dnd = "active";
    if (kind === "missing dnd") f.data.dnd = undefined;
    if (kind === "sender") f.data.senderSms = false;
    if (kind === "history") f.data.historyFail = true;
    if (kind === "unmatched outbound") f.data.historyOutbound = true;
    if (kind === "search continuation") f.data.historyTotal = 2;
    if (kind === "holds") f.data.holds = false;
    if (kind === "ledger unavailable") f.db.fail = "history:read-only";
    const out = await f.run().run(); assert.equal(out.state, "held", JSON.stringify(out));
    assert.equal(f.data.posts, 0); assert.equal(f.db.rows.length, 0);
  }));
for (const kind of ["paid", "balance", "dnd", "sender", "history", "expiry", "holds"])
  test(`post-reservation ${kind} drift consumes claim without a POST`, () => clocked(async tick => {
    const f = fixture(tick); f.db.hook = op => {
      if (op !== "ledger:reserve") return;
      if (kind === "paid") f.data.paid = true;
      if (kind === "balance") f.data.amount = 100;
      if (kind === "dnd") f.data.dnd = "active";
      if (kind === "sender") f.data.senderSms = false;
      if (kind === "history") f.data.historyOutbound = true;
      if (kind === "expiry") tick(121_000);
      if (kind === "holds") f.data.holds = false;
    };
    const p = f.run(), out = await p.run(); assert.notEqual(out.state, "accepted"); assert.equal(out.reservationCreated, true);
    assert.equal(f.data.posts, 0); assert.equal(f.db.rows[0].state, "reserved"); assert.equal((await p.run()).state, "held");
  }));
for (const kind of ["429", "500", "timeout", "lost pending", "lost outcome"])
  test(`pilot ${kind} does not retry`, () => clocked(async tick => {
    const f = fixture(tick);
    if (kind === "429" || kind === "500") f.data.postStatus = Number(kind);
    if (kind === "timeout") f.data.postThrow = true;
    if (kind === "lost pending") f.db.fail = "ledger:pending";
    if (kind === "lost outcome") f.db.fail = "ledger:outcome";
    const p = f.run(), out = await p.run(); assert.equal(out.state, "unknown", JSON.stringify(out));
    assert.equal(f.data.posts, kind === "lost pending" ? 0 : 1); await p.run();
    assert.equal(f.data.posts, kind === "lost pending" ? 0 : 1); assert.equal(out.retryAllowed, false);
  }));
test("forged/cloned config and read-only review cannot be promoted to a send", () => clocked(async tick => {
  const f = fixture(tick), handle = f.reviewed("read-only");
  for (const candidate of [handle, { ...handle }, {}]) {
    const out = await createDay10Pilot({ mode: "reviewed-one-attempt", config: candidate as typeof handle,
      runtime: async () => { f.data.bootstrap++; return f.runtime; } }).run();
    assert.equal(out.state, "held");
  }
  assert.equal(f.data.bootstrap, 0);
}));
test("reviewed config is immutable and expires before bootstrap", () => clocked(async tick => {
  const f = fixture(tick), handle = f.reviewed(); (f.c as any).destination = "+12025550125";
  tick(121_000);
  const out = await createDay10Pilot({ mode: "reviewed-one-attempt", config: handle, runtime: async () => { f.data.bootstrap++; return f.runtime; } }).run();
  assert.equal(out.state, "held"); assert.equal(f.data.bootstrap, 0);
}));
test("readiness CLI and importing runtime never touch the ambient Prisma singleton", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    Object.defineProperty(globalThis, "prisma", { get() { throw new Error("ambient Prisma touched"); } });
    Promise.all([import("./lib/notification-day10-runtime.ts"), import("./scripts/review-day10-notification-pilot.ts")])
      .catch(() => { process.exitCode = 9; });
  `], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, GHL_NOTIFICATIONS_ENABLED: "true", DATABASE_URL: "invalid://never-connect" } });
  assert.equal(child.status, 0, child.stderr); const output = JSON.parse(child.stdout);
  assert.equal(output.state, "held"); assert.ok(output.missing.includes("bounded_config_file")); assert.equal(output.rolloutReady, false);
});
test("deployed bootstrap preserves no-refresh reader, read-only token transaction and active holds", () => {
  const source = readFileSync("lib/notification-day10-runtime.ts", "utf8");
  assert.match(source, /requireTokenRunCoverage\(auth\.expiresAt\)/);
  assert.match(source, /SET TRANSACTION READ ONLY/); assert.match(source, /new JobberReader/);
  assert.doesNotMatch(source, /jobberGraphQL|migrate|refreshToken|upsert|jobberAuth\.update/);
  assert.throws(() => verifyDay10DeploymentHolds({}, "location"));
  const env = { RAILWAY_SERVICE_ID: "ed22ce04-2e5d-47d1-98ed-ce63c99d3d9f", RAILWAY_ENVIRONMENT_ID: "bc72bc2d-9a4c-494d-8bee-9ca782db1240",
    RAILWAY_DEPLOYMENT_ID: "synthetic", DATABASE_URL: "synthetic", GHL_API_KEY: "synthetic", GHL_LOCATION_ID: "location",
    GHL_INVOICE_WRITE_MODE: "review", GHL_PHONE_WRITES_ENABLED: "false", SYNC_ADMISSION_MODE: "cron_only", GHL_NOTIFICATIONS_ENABLED: "false" };
  assert.doesNotThrow(() => verifyDay10DeploymentHolds(env, "location"));
  assert.throws(() => verifyDay10DeploymentHolds({ ...env, GHL_NOTIFICATIONS_ENABLED: "true" }, "location"));
});

test("mutating the caller configuration after review cannot change the immutable recipient or body", () => clocked(async tick => {
  const f = fixture(tick), handle = f.reviewed();
  (f.c as any).destination = "+12025550125";
  (f.c.template as any).body = "ALTERED {{balance}}";
  const out = await createDay10Pilot({ mode: "reviewed-one-attempt", config: handle, runtime: async () => f.runtime }).run();
  assert.equal(out.state, "accepted", JSON.stringify(out));
  const wire = JSON.parse(f.calls.find(c => c.method === "POST")!.body!);
  assert.equal(wire.toNumber, "+12025550123"); assert.match(wire.message, /^SYNTHETIC ONLY:/);
}));
test("active-hold change after pending commit prevents HTTP without a retry", () => clocked(async tick => {
  const f = fixture(tick); f.db.hook = op => { if (op === "ledger:pending") f.data.holds = false; };
  const p = f.run(), out = await p.run(); assert.equal(out.state, "unknown"); assert.equal(f.data.posts, 0);
  assert.equal(f.db.rows[0].state, "unknown"); assert.equal((await p.run()).state, "held");
}));
test("absent global DND follows reviewed false default alongside explicit inactive SMS", () => clocked(async tick => {
  const f = fixture(tick); (f.data as any).globalDnd = undefined;
  const out = await f.run("read-only").run(); assert.equal(out.phase, "read_only", JSON.stringify(out));
  assert.equal(f.data.posts, 0); assert.equal(f.db.rows.length, 0);
}));

for (const stalled of ["open", "read"]) test(`readiness deadline covers stalled file ${stalled}`, () => {
  const script = `
    const fs = require("node:fs/promises");
    const never = () => new Promise(() => {});
    fs.open = ${JSON.stringify(stalled)} === "open" ? never : async () => ({
      stat: async () => ({ isFile: () => true, size: 2, mtimeMs: 1, ctimeMs: 1 }),
      read: never, close: async () => {}
    });
    require("node:module").syncBuiltinESMExports();
    const originalTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 120000 ? 20 : ms, ...args);
    process.argv = ["node", "script", "--readiness", "synthetic-never-read", "0".repeat(64), "synthetic-review"];
    import("./scripts/review-day10-notification-pilot.ts");
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 3, child.stderr); assert.match(child.stderr, /runtime limit reached/); assert.equal(child.stdout, "");
});
test("readiness safely rejects symlink, directory and oversized files without runtime initialization", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-day10-cli-"));
  try {
    const small = join(dir, "small.json"), link = join(dir, "link.json"), large = join(dir, "large.json");
    writeFileSync(small, "{}"); symlinkSync(small, link); writeFileSync(large, " ".repeat(32_769));
    for (const path of [link, dir, large]) {
      const script = `
        Object.defineProperty(globalThis, "prisma", { get() { throw new Error("ambient touched"); } });
        process.argv = ["node", "script", "--readiness", ${JSON.stringify(path)}, "0".repeat(64), "synthetic-review"];
        import("./scripts/review-day10-notification-pilot.ts");
      `;
      const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", timeout: 5000 });
      assert.equal(child.status, 2, child.stderr); assert.equal(child.stdout, ""); assert.doesNotMatch(child.stderr, /ambient touched/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("exact original static Day10 copy sends unchanged without currency or invoice-number rendering", () => clocked(async tick => {
  const c = config(); (c as any).currencyPolicy = null; (c.template as any).body = ORIGINAL_DAY10_SMS_BODY;
  assert.equal(ORIGINAL_DAY10_SMS_BODY, "This is a friendly reminder your invoice is 10 days past due. We kindly ask this invoice be paid as soon as possible to avoid any late fees. Please reach out to our office at 602-329-7865 if you have any questions or concerns.");
  const f = fixture(tick, c); f.data.invoiceNumber = null;
  const out = await f.run().run();
  assert.equal(out.state, "accepted", JSON.stringify(out)); assert.equal(f.data.posts, 1);
  const wire = JSON.parse(f.calls.find(call => call.method === "POST")!.body!);
  assert.equal(wire.message, ORIGINAL_DAY10_SMS_BODY); assert.doesNotMatch(wire.message, /USD|137\.00|1234/);
  assert.equal(f.db.rows[0].eventPayload.currency, null); assert.equal(f.db.rows[0].eventPayload.balanceMinor, 13700);
  assert.deepEqual(f.db.rows[0].eventPayload.claimedFacts, []);
  const summary = summarizeDay10PilotExecution(out);
  assert.equal(summary.state, "accepted"); assert.equal(summary.attempted, true); assert.equal(summary.rolloutReady, false);
  assert.equal("productionSendCapability" in summary, false); assert.equal("transport" in summary, false);
  assert.equal("messageId" in summary, false);
}));
test("original static copy without currency also passes read-only evaluation with no writes", () => clocked(async tick => {
  const c = config(); (c as any).currencyPolicy = null; (c.template as any).body = ORIGINAL_DAY10_SMS_BODY;
  const f = fixture(tick, c), out = await f.run("read-only").run();
  assert.equal(out.phase, "read_only", JSON.stringify(out)); assert.equal(f.data.posts, 0); assert.equal(f.db.rows.length, 0);
}));
for (const body of [ORIGINAL_DAY10_SMS_BODY + " ", ORIGINAL_DAY10_SMS_BODY.replace("10 days", "eleven days"),
  ORIGINAL_DAY10_SMS_BODY.replace("602-329-7865", "602-329-7866"), ORIGINAL_DAY10_SMS_BODY + " USD 137.00", "Please pay $137.00.",
  "Please pay {{balance}}.", "Invoice {{invoiceNumber}} is overdue."])
  test(`unknown currency cannot accompany altered or monetary copy: ${body.slice(-35)}`, () => clocked(async () => {
    const c = config(); (c as any).currencyPolicy = null; (c.template as any).body = body;
    const raw = JSON.stringify(c), result = reviewDay10PilotConfiguration(raw, { configSha256: hash(raw), reviewRef: c.reviewRef, action: "one-attempt" });
    assert.equal(result.handle, null); assert.ok(result.readiness.missing.includes("reviewed_exact_invoice_currency_policy"));
  }));
for (const kind of ["paid", "partial payment", "zero", "wrong due date"])
  test(`static unknown-currency copy retains the final ${kind} source guard`, () => clocked(async tick => {
    const c = config(); (c as any).currencyPolicy = null; (c.template as any).body = ORIGINAL_DAY10_SMS_BODY;
    const f = fixture(tick, c);
    f.db.hook = operation => {
      if (operation !== "ledger:reserve") return;
      if (kind === "paid") f.data.paid = true;
      if (kind === "partial payment") f.data.amount = 100;
      if (kind === "zero") f.data.amount = 0;
      if (kind === "wrong due date") f.data.dueDate = "2026-10-29";
    };
    const out = await f.run().run(); assert.notEqual(out.state, "accepted"); assert.equal(out.reservationCreated, true);
    assert.equal(f.data.posts, 0); assert.equal(f.db.rows[0].state, "reserved");
  }));
