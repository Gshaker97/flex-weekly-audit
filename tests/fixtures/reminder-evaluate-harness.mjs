/**
 * Fixture-only harness that runs the REAL evaluate-only entrypoint.
 *
 * scripts/reminder-evaluate-cron.ts is imported unmodified. Everything it could
 * reach outward is cut off first:
 *
 *   - fetch, net, tls, http, https and dns throw. There is no outbound network.
 *   - Prisma is replaced through lib/prisma.ts's own `globalThis.prisma` seam,
 *     so no PrismaClient is ever constructed and no connection string is read.
 *     Only invoiceRecord.findMany and reminderEvaluationRun.create are allowed;
 *     every other model accessor throws and is recorded.
 *   - lib/reminder-evaluation-readers.ts is redirected to a fixture stub by a
 *     synchronous resolve hook, which also records the whole module graph and
 *     throws if a sender, dispatcher, transport or GHL/Jobber client is ever
 *     resolved.
 *   - The clock is frozen at HARNESS_NOW so Phoenix window behaviour is exact.
 *
 * One JSON line is written to stdout on exit, prefixed __HARNESS_JSON__.
 */
import { registerHooks } from "node:module";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import { pathToFileURL } from "node:url";

const log = {
  fetch: [], sockets: [], dns: [], modules: [], prismaCalls: [], forbidden: [],
  readers: [], runs: [], candidateQuery: null, stubbedReaders: false,
};
globalThis.__HARNESS__ = log;

/* ---------- 1. no outbound network, at all ---------------------------- */
const blocked = (bucket, label) => (...args) => {
  log[bucket].push(`${label}(${String(args[0] ?? "")})`.slice(0, 200));
  throw new Error(`HARNESS_BLOCKED_${label.toUpperCase()}`);
};
globalThis.fetch = blocked("fetch", "fetch");
net.Socket.prototype.connect = blocked("sockets", "socket.connect");
net.connect = blocked("sockets", "net.connect");
net.createConnection = blocked("sockets", "net.createConnection");
tls.connect = blocked("sockets", "tls.connect");
http.request = blocked("sockets", "http.request");
http.get = blocked("sockets", "http.get");
https.request = blocked("sockets", "https.request");
https.get = blocked("sockets", "https.get");
dns.lookup = blocked("dns", "dns.lookup");
dns.promises.lookup = blocked("dns", "dns.promises.lookup");

/* ---------- 2. frozen Phoenix clock ---------------------------------- */
const FIXED = Date.parse(process.env.HARNESS_NOW ?? "");
if (!Number.isFinite(FIXED)) throw new Error("HARNESS_NOW must be an absolute instant");
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(FIXED); else super(...args); }
  static now() { return FIXED; }
}
globalThis.Date = FrozenDate;

/* ---------- 3. fixtures ---------------------------------------------- */
// Phoenix "today" for every case below is 2026-11-16.
// Irrigation is the only ladder that can ever resolve to "agreed", so the
// reachable milestones are day 10, 15 and 21. Day 21 is the internal one.
const IRRIGATION_JOBBER = ["Irrigation Promotion"];
const IRRIGATION_LINES = ["Irrigation Diagnostic Promotion"];
const open = (due, issued, clientId) => ({
  invoiceStatus: "awaiting_payment", totalCents: 50000, balanceCents: 50000,
  issuedDate: issued, dueDate: due, clientId,
  clientTags: IRRIGATION_JOBBER, lineItemNames: IRRIGATION_LINES,
});
const contact = (id) => ({ id, tags: ["irrigation"], dnd: false, phone: null, email: null });
const openCard = (id) => [{ id, stage: "invoice overdue", status: "open" }];

const cached = [
  { jobberInvoiceId: "inv-eligible",  invoiceNumber: "9001", clientName: "Fixture Alpha",
    customer: { jobberClientId: "cl-alpha",   email: "alpha@example.test",   phone: "+16025550101" } },
  { jobberInvoiceId: "inv-old",       invoiceNumber: "9002", clientName: "Fixture Bravo",
    customer: { jobberClientId: "cl-bravo",   email: "bravo@example.test",   phone: "+16025550102" } },
  { jobberInvoiceId: "inv-ambiguous", invoiceNumber: "9003", clientName: "Fixture Charlie",
    customer: { jobberClientId: "cl-charlie", email: "charlie@example.test", phone: "+16025550103" } },
  { jobberInvoiceId: "inv-settled",   invoiceNumber: "9004", clientName: "Fixture Delta",
    customer: { jobberClientId: "cl-delta",   email: "delta@example.test",   phone: "+16025550104" } },
];

globalThis.__HARNESS_FIXTURES__ = {
  cached,
  source: {
    // due 2026-10-26 + 21 = 2026-11-16 -> day 21 falls TODAY
    "inv-eligible":  open("2026-10-26", "2026-10-12", "cl-alpha"),
    // due 2026-09-01 -> days 10/15/21 land 2026-09-11/16/22, all long past
    "inv-old":       open("2026-09-01", "2026-08-18", "cl-bravo"),
    "inv-ambiguous": open("2026-10-26", "2026-10-12", "cl-charlie"),
    "inv-settled":   { ...open("2026-10-26", "2026-10-12", "cl-delta"),
                       invoiceStatus: "paid", balanceCents: 0 },
  },
  contacts: {
    "inv-eligible":  [contact("ct-alpha")],
    "inv-old":       [contact("ct-bravo")],
    // two exact matches: must hold, never be merged or chosen between
    "inv-ambiguous": [contact("ct-charlie-1"), contact("ct-charlie-2")],
    "inv-settled":   [contact("ct-delta")],
  },
  cards: {
    "ct-alpha": openCard("op-alpha"), "ct-bravo": openCard("op-bravo"),
    "ct-charlie-1": openCard("op-charlie-1"), "ct-charlie-2": openCard("op-charlie-2"),
    "ct-delta": openCard("op-delta"),
  },
  history: {
    "inv-eligible":  { complete: true, incompleteReason: null, sends: [] },
    "inv-old":       { complete: true, incompleteReason: null, sends: [] },
    "inv-ambiguous": { complete: true, incompleteReason: null, sends: [] },
    "inv-settled":   { complete: true, incompleteReason: null, sends: [] },
  },
};

/* ---------- 4. Prisma, through lib/prisma.ts's own global seam -------- */
const invoiceRecord = {
  async findMany(args) {
    log.prismaCalls.push("invoiceRecord.findMany");
    log.candidateQuery = {
      whereKeys: Object.keys(args?.where ?? {}).sort(),
      statuses: args?.where?.invoiceStatus?.in ?? null,
      amountDueGt: args?.where?.amountDue?.gt ?? null,
      hasIssuedAtFloor: Boolean(args?.where?.issuedAt?.gte),
    };
    return globalThis.__HARNESS_FIXTURES__.cached;
  },
};
const reminderEvaluationRun = {
  async create(args) {
    log.prismaCalls.push("reminderEvaluationRun.create");
    const data = args?.data ?? {};
    log.runs.push({
      topLevelKeys: Object.keys(data).sort(),
      nestedWriteKeys: Object.keys(data).filter(k => data[k] && typeof data[k] === "object" && "create" in data[k]),
      mode: data.mode, state: data.state, phoenixDate: data.phoenixDate,
      candidates: data.candidates, eligible: data.eligible, held: data.held,
      exclusionsVerified: data.exclusionsVerified, sendsAttempted: data.sendsAttempted,
      notes: data.notes,
      rows: (data.rows?.create ?? []).map(r => ({
        invoiceNumber: r.invoiceNumber, decision: r.decision, category: r.category,
        categorySource: r.categorySource, milestoneDay: r.milestoneDay,
        audience: r.audience, daysPastDue: r.daysPastDue, holds: r.holds,
      })),
    });
    return { id: "harness-run" };
  },
};
const PRISMA_OK = new Set(["invoiceRecord", "reminderEvaluationRun", "$disconnect", "$connect"]);
globalThis.prisma = new Proxy({}, {
  get(_target, key) {
    if (typeof key !== "string") return undefined;
    if (key === "then" || key === "constructor" || key === "inspect") return undefined;
    if (key === "$disconnect" || key === "$connect") {
      return async () => { log.prismaCalls.push(key); };
    }
    if (key === "invoiceRecord") return invoiceRecord;
    if (key === "reminderEvaluationRun") return reminderEvaluationRun;
    log.forbidden.push(`prisma.${key}`);
    throw new Error(`HARNESS_FORBIDDEN_PRISMA:${key} (allowed: ${[...PRISMA_OK].join(",")})`);
  },
});

/* ---------- 5. module graph: stub the readers, bar every sender ------- */
const ROOT = pathToFileURL(process.cwd()).href + "/";
const READERS_STUB = new URL("./reminder-evaluate-readers-stub.mjs", import.meta.url).href;
const BARRED = [
  "/lib/notification-sender", "/lib/notification-dispatch", "/lib/notification-ghl-transport",
  "/lib/notification-ghl-contract", "/lib/ghl.ts", "/lib/jobber.ts", "/lib/sync.ts",
  "/lib/reminder-day21-pilot", "/lib/ghl-",
];
// @prisma/client is imported at the top of lib/prisma.ts before its global seam
// is consulted, so loading the package is unavoidable. What matters is that no
// PrismaClient is CONSTRUCTED: globalThis.prisma below is truthy, so the `??`
// short-circuits and the stub is what lib/prisma.ts exports. The "prisma"
// self-test proves the seam took, because a real client would return a delegate
// for an unknown model instead of throwing.
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const url = resolved.url;
    if (url.endsWith("/lib/reminder-evaluation-readers.ts")) {
      log.stubbedReaders = true;
      return { ...resolved, url: READERS_STUB, shortCircuit: true };
    }
    if (url.startsWith(ROOT) || url.includes("/@prisma/")) {
      log.modules.push(url.startsWith(ROOT) ? url.slice(ROOT.length) : url.split("node_modules/")[1] ?? url);
    }
    for (const barred of BARRED) {
      if (url.includes(barred)) {
        log.forbidden.push(`module:${barred}`);
        throw new Error(`HARNESS_FORBIDDEN_MODULE:${barred} resolved from ${specifier}`);
      }
    }
    return resolved;
  },
});

/* ---------- 6. report on exit, however the run ends ------------------- */
// Registered BEFORE anything can throw, so a tripped guard still reports.
process.on("exit", () => {
  process.stdout.write(`\n__HARNESS_JSON__${JSON.stringify(log)}\n`);
});

/* ---------- 7. self-test mode, so the guards are provably not vacuous */
if (process.env.HARNESS_SELFTEST) {
  const which = process.env.HARNESS_SELFTEST;
  if (which === "prisma") globalThis.prisma.syncRun;
  if (which === "fetch") await globalThis.fetch("https://api.getjobber.com/api/graphql");
  if (which === "module") await import("../../lib/ghl.ts");
  throw new Error("HARNESS_SELFTEST_DID_NOT_TRIP");
}

/* ---------- 8. run the real entrypoint ------------------------------- */
await import(new URL("../../scripts/reminder-evaluate-cron.ts", import.meta.url).href);
