/**
 * End to end over the cron entrypoint's own path: approval -> configuration ->
 * pinned consent re-read -> the real Day 15 sender -> the real gate, runner,
 * transport and ledger.
 *
 * Everything outside that path is synthetic: a disposable in-memory database, a fake
 * Jobber source, a fake GoHighLevel, a fake consent submission and a fake sender. The
 * POST boundary is a function in this file. No real credential, no real contact, no
 * network, and nothing here reads an environment variable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runDay15Pilot, describeDay15PilotOutcome, type Day15PilotApproval, type Day15PilotDependencies }
  from "../lib/notification-day15-pilot-run";
import { parseDay15ConsentPin, pinMatchesConfiguredConsent, readDay15ConsentEvidence,
  DAY15_CONSENT_CONTRACT, type Day15ConsentIO, type Day15ConsentPin }
  from "../lib/notification-day15-consent-evidence";
import type { Day15SenderConfig, Day15SenderRuntime } from "../lib/notification-day15-sender";
import type { NotificationLedgerDatabase, NotificationLedgerTransaction } from "../lib/notification-ledger";

const START = Date.parse("2026-11-09T16:05:00.000Z"); // 09:05 America/Phoenix, inside the window
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const HUB = "https://clienthub.getjobber.com/client_hubs/460ccf18-5d0b-4fee-b2f9-59998b09cdc1/invoices/synthetic-hub-id";
const BODY = "SYNTHETIC ONLY: your invoice is unpaid. Balance {{balance}}. View and pay: {{invoiceLink}}";
const CONSENT_AT = new Date(START - 86_400_000).toISOString();
let sequence = 0;

async function clocked(run: (tick: (ms?: number) => void) => Promise<void>) {
  const old = Date.now; let ms = START; Date.now = () => ms;
  try { await run((delta = 1) => { ms += delta; }); } finally { Date.now = old; }
}

function config(): Day15SenderConfig {
  const invoiceId = `synthetic-day15-entry-${++sequence}`;
  return {
    version: 1, kind: "day15-homeowner-sms-fee-free-pilot", reviewRef: "synthetic-operator-review",
    reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 120_000).toISOString(),
    source: { version: 1, reviewRef: "synthetic-source", expiresAt: new Date(START + 300_000).toISOString(),
      scope: { locationId: "synthetic-location", jobberClientId: "synthetic-owner", contactId: "synthetic-contact", invoiceId },
      originalInvoice: { totalMinor: 13700, issuedDate: "2026-10-20", dueDate: "2026-10-25" },
      identityCoveragePolicy: { accountId: "synthetic-account", reviewRef: "synthetic-coverage",
        reviewedAt: new Date(START - 1000).toISOString(), expiresAt: new Date(START + 300_000).toISOString(),
        quarantine: [{ jobberClientId: "missing-a", email: null, phone: null },
          { jobberClientId: "missing-b", email: null, phone: null }] } },
    destination: "+12025550123",
    scope: { scheduledOn: "2026-11-09", dayPastDue: 15, audience: "homeowner", channel: "sms", maximumAttempts: 1,
      history: "accessible-ghl-plus-local-ledger", timeZone: "America/Phoenix", window: "[09:00:00,09:15:00)",
      authorizationRef: "synthetic-finite-attempt", timingRef: "synthetic-timing", credentialBindingRef: "synthetic-scope-review" },
    currencyPolicy: { accountId: "synthetic-account", invoiceId, currency: "USD", minorUnitExponent: 2,
      evidenceRef: "synthetic-currency-policy" },
    consent: { source: "signed-agreement", contactId: "synthetic-contact", scope: "billing-sms",
      recordedAt: CONSENT_AT, evidenceRef: "synthetic-submission" },
    invoiceLink: { source: "jobber-invoice-client-hub-uri", invoiceId, url: HUB, evidenceRef: "synthetic-link-evidence" },
    sender: { number: "+12025550124", approvalRef: "synthetic-sender-approval", writeScopeEvidenceRef: "synthetic-write-scope" },
    template: { id: "synthetic-day15", version: "1", body: BODY, policy: "day15-no-fee-claim",
      approvalRef: "synthetic-render-policy" },
    nativeSms: { version: "2021-07-28", status: "pending", receiptSource: "app", semanticsRef: "synthetic-native-observation",
      footer: { mode: "exact-native-suffix", suffix: "\nReply STOP to unsubscribe.\nThanks, Synthetic Company",
        evidenceRef: "synthetic-exact-footer" } },
  };
}

function pin(): Day15ConsentPin {
  return { version: 1, locationId: "synthetic-location", formId: "synthetic-form",
    submissionId: "synthetic-submission", contactId: "synthetic-contact", submittedAt: CONSENT_AT,
    source: "signed-agreement", evidenceRef: "synthetic-submission" };
}

class Database implements NotificationLedgerDatabase {
  rows: Record<string, any>[] = []; operations: string[] = [];
  fail: string | null = null;
  async transaction<T>(work: (tx: NotificationLedgerTransaction) => Promise<T>): Promise<T> {
    return work({ query: async <R extends Record<string, unknown>>(sql: string, v: readonly unknown[]) => {
      const operation = /notification-(ledger|runner|history):([\w-]+)/.exec(sql)!.slice(1).join(":");
      this.operations.push(operation);
      if (this.fail === operation) throw new Error("secret database failure");
      if (operation === "history:read-only")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.contactId === v[1])) as R[];
      if (operation === "runner:history")
        return structuredClone(this.rows.filter(r => r.accountId === v[0] && r.eventKey === v[1])) as R[];
      if (operation === "ledger:reserve") {
        if (this.rows.some(r => r.eventKey === v[2] ||
          (r.accountId === v[3] && r.contactId === v[7] && r.scheduledOn === v[8]))) return [];
        const row = { id: v[0], reservationToken: v[1], eventKey: v[2], accountId: v[3], invoiceId: v[4],
          dayPastDue: v[5], audience: v[6], contactId: v[7], scheduledOn: v[8], channel: v[9],
          eventPayload: JSON.parse(v[10] as string), body: v[11], eventHash: v[13], bodyHash: v[14],
          destinationHash: v[15], state: "reserved", providerMessageId: null };
        this.rows.push(row); return [{ id: row.id }] as unknown as R[];
      }
      const row = this.rows.find(r => r.id === v[0]);
      if (!row || row.reservationToken !== v[1] || row.eventHash !== v[2] || row.bodyHash !== v[3] ||
          row.destinationHash !== v[4] || row.state !== (operation === "ledger:outcome" ? "pending" : "reserved")) return [];
      if (operation === "ledger:pending") row.state = "pending";
      if (operation === "ledger:outcome") { row.state = v[5]; row.providerMessageId = v[6]; }
      return [{ id: row.id }] as unknown as R[];
    } });
  }
}

/** One synthetic world: fake Jobber, fake GHL, fake consent submission, fake sender. */
function world(tick: (ms?: number) => void, c = config(), shared?: Database) {
  const db = shared ?? new Database();
  const data = {
    paid: false, amount: 137, link: HUB, linkThrow: false, holds: true,
    posts: 0, consentReads: 0, consentStatus: 200, consentThrow: false,
    submissionId: "synthetic-submission" as string | null, consentCreatedAt: CONSENT_AT,
    termsValue: "I agree to receive account, service and marketing text messages, including reminders.",
    historyFail: false, postStatus: 201,
  };
  const owner = { jobberClientId: "synthetic-owner", email: "synthetic@example.invalid", phone: c.destination };
  const fresh = { id: owner.jobberClientId, emails: [{ address: owner.email, primary: true }],
    phones: [{ number: owner.phone, primary: true }] };

  const sender: Day15SenderRuntime = {
    accountId: "synthetic-account", locationId: "synthetic-location", credential: "synthetic-fake-token",
    database: db, verifyActiveHolds: () => { if (!data.holds) throw new Error("holds changed"); },
    readInvoiceLink: async invoiceId => {
      assert.equal(invoiceId, c.source.scope.invoiceId);
      if (data.linkThrow) throw new Error("secret jobber failure");
      return data.link;
    },
    sourceIO: {
      locationId: () => "synthetic-location",
      customers: async () => { tick(); return [owner, ...c.source.identityCoveragePolicy.quarantine]; },
      contacts: async () => { tick(); return [{ id: "synthetic-contact", locationId: "synthetic-location",
        phone: c.destination, email: owner.email }]; },
      storedInvoices: async () => [{ jobberInvoiceId: c.source.scope.invoiceId }],
      quarantineCounts: async () => c.source.identityCoveragePolicy.quarantine.map(q =>
        ({ jobberClientId: q.jobberClientId, jobs: 0, invoices: 0 })),
      query: async <T = any>(q: string): Promise<T> => {
        tick(); let result: unknown;
        if (q.includes("VerifyExplicitIdentityCoverage")) result = { account: { id: "synthetic-account" },
          clients: { nodes: q.includes("isArchived: false") ? [fresh] : [], pageInfo: { hasNextPage: false, endCursor: null } } };
        else if (q.includes("VerifyQuarantinedIdentity")) result = { account: { id: "synthetic-account" }, client: null };
        else if (q.includes("VerifyDateOwnerInvoices"))
          result = { account: { id: "synthetic-account" }, client: { id: owner.jobberClientId, invoices: {
            nodes: [{ id: c.source.scope.invoiceId, invoiceNumber: "7246", client: { id: owner.jobberClientId },
              invoiceStatus: data.paid ? "paid" : "past_due",
              amounts: { total: 137, invoiceBalance: data.paid ? 0 : data.amount },
              issuedDate: "2026-10-20", dueDate: "2026-10-25" }],
            pageInfo: { hasNextPage: false, endCursor: null } } } };
        else result = { account: { id: "synthetic-account" }, client: fresh,
          invoice: { id: c.source.scope.invoiceId, client: { id: owner.jobberClientId } } };
        return structuredClone(result) as T;
      },
    },
    fetch: (async (input, init) => {
      tick(); const url = String(input), method = init?.method ?? "GET";
      let body: unknown, status = 200;
      if (url.includes("/phone-system/")) {
        body = { status: "success", statusCode: 200, message: "ok", data: { page: 0, pageSize: 100,
          accountStatus: "active", numbers: [{ phoneNumber: c.sender.number, capabilities: { sms: true } }] } };
      } else if (url.includes("/contacts/")) {
        body = { contact: { id: "synthetic-contact", locationId: "synthetic-location", phone: c.destination,
          dnd: false, dndSettings: { SMS: { status: "inactive" } } } };
      } else if (url.includes("/conversations/search")) {
        if (data.historyFail) throw new Error("secret HTTP failure");
        body = { total: 0, conversations: [] };
      } else if (url.endsWith("/conversations/messages")) {
        assert.equal(method, "POST");
        assert.equal(db.rows.filter(r => r.state === "pending").length, 1);
        data.posts++;
        status = data.postStatus; body = { messageId: "synthetic-message", conversationId: "synthetic-conversation" };
      } else throw new Error(`unexpected URL ${url}`);
      const response = new Response(JSON.stringify(body), { status });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }) as typeof fetch,
  };

  const consentIO: Day15ConsentIO = {
    get: async request => {
      data.consentReads++;
      assert.equal(request.method, "GET");
      assert.equal(request.headers.Version, DAY15_CONSENT_CONTRACT.version);
      const url = new URL(request.url);
      assert.equal(url.origin, DAY15_CONSENT_CONTRACT.origin);
      assert.equal(url.pathname, DAY15_CONSENT_CONTRACT.path);
      assert.equal(url.searchParams.get("formId"), "synthetic-form");
      assert.equal(url.searchParams.get("startAt"), CONSENT_AT.slice(0, 10));
      if (data.consentThrow) throw new Error("secret GHL failure");
      const submissions = data.submissionId === null ? [] : [{
        id: data.submissionId, contactId: "synthetic-contact", formId: "synthetic-form",
        createdAt: data.consentCreatedAt,
        others: { terms_and_conditions: data.termsValue, signatureHash: "synthetic-hash", ip: "203.0.113.9" },
      }];
      return { status: data.consentStatus, text: JSON.stringify({ submissions, meta: { total: submissions.length, nextPage: null } }) };
    },
  };

  const raw = JSON.stringify(c);
  const approval = (action: "read-only" | "one-attempt" = "one-attempt"): Day15PilotApproval =>
    ({ configSha256: hash(raw), reviewRef: c.reviewRef, allowedInvoiceId: c.source.scope.invoiceId, action });

  const deps = (overrides: Partial<Day15PilotDependencies> = {},
    action: "read-only" | "one-attempt" = "one-attempt", confirmed = false): Day15PilotDependencies => ({
    approval: () => approval(action),
    oneAttemptConfirmed: () => confirmed,
    consentPin: () => pin(),
    readConfiguration: async () => raw,
    consentIO: async () => consentIO,
    runtime: async () => sender,
    ...overrides,
  });

  return { c, raw, db, data, sender, consentIO, approval, deps };
}

// ------------------------------------------------------------------ off by default

test("no approval: nothing is read, nothing is contacted, nothing is sent", async () => {
  await clocked(async () => {
    const boom = () => { throw new Error("must not be reached without an approval"); };
    const result = await runDay15Pilot({
      approval: () => null,
      oneAttemptConfirmed: boom as any,
      consentPin: boom as any,
      readConfiguration: boom as any,
      consentIO: boom as any,
      runtime: boom as any,
    });
    assert.equal(result.state, "no_approval");
    assert.equal(result.mode, "none");
    assert.equal(result.attempted, false);
    assert.deepEqual([...result.reasons], ["no_out_of_band_pilot_approval"]);
    assert.equal(result.consent, null);
    assert.equal(result.execution, null);
  });
});

test("an incomplete approval is no approval", async () => {
  await clocked(async () => {
    const w = world(() => {});
    for (const broken of [
      { ...w.approval(), configSha256: "not-a-sha" },
      { ...w.approval(), reviewRef: "" },
      { ...w.approval(), allowedInvoiceId: "" },
      { ...w.approval(), action: "send" as any },
    ]) {
      const result = await runDay15Pilot(w.deps({ approval: () => broken }));
      assert.equal(result.state, "no_approval");
      assert.equal(w.data.posts, 0);
      assert.equal(w.data.consentReads, 0);
    }
  });
});

test("action one-attempt without the separate confirmation stays read-only and cannot POST", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({}, "one-attempt", false));
    assert.equal(result.mode, "read-only");
    assert.equal(result.state, "read_only_complete");
    assert.equal(result.attempted, false);
    assert.equal(w.data.posts, 0);
    assert.ok(result.reasons.includes("one_attempt_not_confirmed_downgraded_to_read_only"));
  });
});

test("the confirmation alone, with a read-only approval, cannot POST either", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({}, "read-only", true));
    assert.equal(result.mode, "read-only");
    assert.equal(result.attempted, false);
    assert.equal(w.data.posts, 0);
  });
});

// ------------------------------------------------------------------ one invoice only

test("a configuration naming a different invoice holds before any network read", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({
      approval: () => ({ ...w.approval(), allowedInvoiceId: "some-other-invoice" }),
    }, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.ok(result.reasons.includes("configuration_invoice_is_not_the_one_approved_invoice"));
    assert.equal(w.data.consentReads, 0);
    assert.equal(w.data.posts, 0);
  });
});

test("an absent configuration holds", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({ readConfiguration: async () => undefined }, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.deepEqual([...result.reasons], ["pilot_configuration_absent"]);
    assert.equal(w.data.posts, 0);
  });
});

test("a review hash that does not match the configuration bytes holds", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({
      approval: () => ({ ...w.approval(), configSha256: hash("different bytes") }),
    }, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.ok(result.reasons.includes("out_of_band_reviewed_config_sha256"));
    assert.equal(w.data.posts, 0);
  });
});

// ------------------------------------------------------------------ pinned consent

test("the runtime reads the pinned consent submission and verifies it", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const read = await readDay15ConsentEvidence(pin(), w.c.consent, w.consentIO);
    assert.equal(read.state, "verified");
    assert.equal(read.submissionId, "synthetic-submission");
    assert.equal(read.pagesRead, 1);
    assert.deepEqual([...read.reasons], []);
    assert.equal(read.productionSendCapability, false);
  });
});

test("consent is never re-searched: a different submission id is a hold, not a new match", async () => {
  await clocked(async tick => {
    const w = world(tick);
    w.data.submissionId = "a-different-consenting-submission";
    const result = await runDay15Pilot(w.deps({}, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.ok(result.reasons.includes("pinned_consent_submission_not_found"));
    assert.equal(w.data.posts, 0);
  });
});

test("a moved submission instant, an empty terms value and an unreadable read all hold", async () => {
  await clocked(async tick => {
    for (const [name, apply] of [
      ["instant", (w: ReturnType<typeof world>) => { w.data.consentCreatedAt = new Date(START - 1000).toISOString(); }],
      ["terms", (w: ReturnType<typeof world>) => { w.data.termsValue = "   "; }],
      ["missing", (w: ReturnType<typeof world>) => { w.data.submissionId = null; }],
      ["http", (w: ReturnType<typeof world>) => { w.data.consentStatus = 403; }],
      ["throw", (w: ReturnType<typeof world>) => { w.data.consentThrow = true; }],
    ] as const) {
      const w = world(tick); apply(w);
      const result = await runDay15Pilot(w.deps({}, "one-attempt", true));
      assert.equal(result.state, "held", name);
      assert.ok(result.reasons.includes("pinned_consent_evidence_not_verified"), name);
      assert.equal(w.data.posts, 0, name);
    }
  });
});

test("a pin that disagrees with the configured consent costs no request", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({
      consentPin: () => ({ ...pin(), contactId: "someone-else" }),
    }, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.ok(result.reasons.includes("pinned_contact_differs_from_configured_consent"));
    assert.equal(w.data.consentReads, 0);
    assert.equal(w.data.posts, 0);
  });
});

test("an absent pin holds and never falls back to searching", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({ consentPin: () => null }, "one-attempt", true));
    assert.equal(result.state, "held");
    assert.deepEqual([...result.reasons], ["pinned_consent_evidence_absent"]);
    assert.equal(w.data.consentReads, 0);
  });
});

test("the consent pin parser refuses extra keys, a bad instant and an unbounded blob", () => {
  assert.ok(parseDay15ConsentPin(JSON.stringify(pin())));
  assert.equal(parseDay15ConsentPin(JSON.stringify({ ...pin(), extra: 1 })), null);
  assert.equal(parseDay15ConsentPin(JSON.stringify({ ...pin(), submittedAt: "2026-10-22" })), null);
  assert.equal(parseDay15ConsentPin(JSON.stringify({ ...pin(), source: "assumed" })), null);
  assert.equal(parseDay15ConsentPin("x".repeat(9000)), null);
  assert.equal(parseDay15ConsentPin(undefined), null);
  assert.deepEqual([...pinMatchesConfiguredConsent(pin(), null)], ["configured_consent_absent"]);
});

// ------------------------------------------------------- one eligible invoice sends once

test("one eligible simulated invoice sends exactly once, and a second run does not send again", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const first = await runDay15Pilot(w.deps({}, "one-attempt", true));
    assert.equal(first.mode, "reviewed-one-attempt");
    assert.equal(first.state, "attempted");
    assert.equal(first.attempted, true);
    assert.equal(first.consent?.state, "verified");
    assert.equal(first.execution?.state, "accepted");
    assert.equal(w.data.posts, 1);
    assert.equal(w.db.rows.length, 1);
    // The ledger's terminal state for a provider-accepted message.
    assert.equal(w.db.rows[0].state, "accepted");
    assert.equal(w.db.rows[0].providerMessageId, "synthetic-message");
    // Rollout and retry stay refused however well it went.
    assert.equal(first.execution?.rolloutReady, false);
    assert.equal(first.execution?.retryAllowed, false);
    assert.equal(first.productionSendCapability, false);

    // A whole second run, same ledger: the reservation already exists.
    const again = world(tick, w.c, w.db);
    const second = await runDay15Pilot(again.deps({}, "one-attempt", true));
    assert.equal(second.attempted, false);
    assert.equal(again.data.posts, 0);
    assert.equal(w.db.rows.length, 1);
  });
});

test("the log line carries no destination, no message text and no credential", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const line = describeDay15PilotOutcome(await runDay15Pilot(w.deps({}, "one-attempt", true)));
    assert.ok(line.startsWith("[day15-pilot] "));
    for (const secret of [w.c.destination, w.c.sender.number, "synthetic-fake-token", "View and pay", HUB])
      assert.ok(!line.includes(secret), `${secret} leaked into the log line`);
  });
});

// ------------------------------------------------------------- paid and uncertain hold

test("a paid invoice does not send", async () => {
  await clocked(async tick => {
    const w = world(tick);
    w.data.paid = true;
    const result = await runDay15Pilot(w.deps({}, "one-attempt", true));
    assert.equal(result.attempted, false);
    assert.notEqual(result.execution?.state, "accepted");
    assert.equal(w.data.posts, 0);
    assert.equal(w.db.rows.length, 0);
  });
});

test("a zero balance on an open invoice does not send", async () => {
  await clocked(async tick => {
    const w = world(tick);
    w.data.amount = 0;
    const result = await runDay15Pilot(w.deps({}, "one-attempt", true));
    assert.equal(result.attempted, false);
    assert.equal(w.data.posts, 0);
    assert.equal(w.db.rows.length, 0);
  });
});

test("uncertain evidence does not send: link drift, an unreadable link, lost holds, unreadable history", async () => {
  await clocked(async tick => {
    for (const [name, apply] of [
      ["link drift", (w: ReturnType<typeof world>) => {
        w.data.link = HUB.replace("synthetic-hub-id", "a-different-invoice"); }],
      ["unreadable link", (w: ReturnType<typeof world>) => { w.data.linkThrow = true; }],
      ["holds lost", (w: ReturnType<typeof world>) => { w.data.holds = false; }],
      ["unreadable history", (w: ReturnType<typeof world>) => { w.data.historyFail = true; }],
      ["ledger unavailable", (w: ReturnType<typeof world>) => { w.db.fail = "ledger:reserve"; }],
    ] as const) {
      const w = world(tick); apply(w);
      const result = await runDay15Pilot(w.deps({}, "one-attempt", true));
      assert.equal(result.attempted, false, name);
      assert.notEqual(result.execution?.state, "accepted", name);
      assert.equal(w.data.posts, 0, name);
    }
  });
});

test("a runtime that cannot be built holds instead of throwing", async () => {
  await clocked(async tick => {
    const w = world(tick);
    const result = await runDay15Pilot(w.deps({
      runtime: async () => { throw new Error("synthetic-fake-token must not escape"); },
    }, "one-attempt", true));
    assert.equal(result.attempted, false);
    assert.ok(!JSON.stringify(result).includes("synthetic-fake-token"));
    assert.equal(w.data.posts, 0);
  });
});

test("the connecting layer reads no environment variable of its own", () => {
  const source = require("node:fs").readFileSync("lib/notification-day15-pilot-run.ts", "utf8");
  assert.ok(!source.includes("process.env"));
  const consent = require("node:fs").readFileSync("lib/notification-day15-consent-evidence.ts", "utf8");
  assert.ok(!consent.includes("process.env"));
});
