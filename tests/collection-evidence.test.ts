import assert from "node:assert/strict";
import test from "node:test";
import { buildUnverifiedReminders, manualCallMark } from "../lib/collection-evidence";

const due = new Date("2026-10-01T12:00:00Z");
test("every milestone remains unknown before, on and after its reference day", () => {
  for (const now of [due, new Date("2026-10-11T12:00:00Z"), new Date("2026-11-05T12:00:00Z")]) {
    const cells = buildUnverifiedReminders(due, now);
    assert.deepEqual(cells.map((c) => c.threshold), [10, 15, 20, 25, 30]);
    assert.ok(cells.every((c) => c.status === "unknown"));
  }
});
test("unknown or invalid due date never manufactures timing or delivery evidence", () => {
  for (const date of [null, new Date("invalid")]) {
    assert.ok(buildUnverifiedReminders(date, due).every((c) => c.status === "unknown" && c.approximateDaysUntil === undefined));
  }
});
test("approximate references use Arizona calendar days, not elapsed 24-hour periods", () => {
  const cells = buildUnverifiedReminders(new Date("2026-10-01T23:30:00-07:00"), new Date("2026-10-11T00:05:00-07:00"));
  assert.equal(cells[0].approximateDaysUntil, 0);
  assert.equal(cells[1].approximateDaysUntil, 5);
});
test("past references do not mean not sent or trigger a schedule", () => {
  const cells = buildUnverifiedReminders(due, new Date("2026-11-05T12:00:00Z"));
  assert.equal(cells[0].approximateDaysUntil, -25);
  assert.equal(cells[0].status, "unknown");
});
test("manual call marks never fabricate Sarah or another caller identity", () => {
  assert.deepEqual(manualCallMark(true, due), { calledAt: due, calledBy: null });
  assert.deepEqual(manualCallMark(false, due), { calledAt: null, calledBy: null });
});

test("source age uses Arizona dates, preserving unknown dates and negative ages", async () => {
  const { sourceDueDateAge } = await import("../lib/collection-evidence");
  assert.equal(sourceDueDateAge(null, due), null);
  assert.equal(sourceDueDateAge(due, new Date("invalid")), null);
  assert.equal(sourceDueDateAge(new Date("2026-10-01T23:30:00-07:00"), new Date("2026-10-02T00:01:00-07:00")), 1);
  assert.equal(sourceDueDateAge(due, new Date("2026-09-30T12:00:00Z")), -1);
});

test("no-phone blocks are distinct from historical reminder evidence", async () => {
  const { smsReadiness } = await import("../lib/collection-evidence");
  for (const phone of [null, undefined, "", "  "]) {
    assert.match(smsReadiness(phone), /blocked: no phone/);
    assert.match(smsReadiness(phone), /historical delivery remains unknown/);
  }
  assert.match(smsReadiness("+16025550123"), /eligibility unverified/);
  assert.match(smsReadiness("not a valid number"), /eligibility unverified/);
});

test("collections uses the shared overdue display query without email exclusion or live message lookups", async () => {
  const fixtures = [
    { id: "phone-only", customer: { email: null, phone: "+16025550123" } },
    { id: "email-only", customer: { email: "synthetic@example.invalid", phone: null } },
    { id: "neither", customer: null },
  ].map((item) => ({ invoiceNumber: null, invoiceStatus: "past_due", dueAt: due, issuedAt: due, amountDue: 12, clientName: "Synthetic", ...item }));
  const { mock } = await import("node:test");
  const queries: unknown[] = [];
  const globals = globalThis as unknown as { prisma?: unknown };
  const previousPrisma = globals.prisma;
  globals.prisma = {
    invoiceRecord: { findMany: async (args: unknown) => { queries.push(args); return fixtures; } },
    lateInvoiceCall: { findMany: async () => [
      { invoiceId: "phone-only", calledAt: due, calledBy: "Sarah" },
    ] },
  };
  let networkCalls = 0;
  const network = mock.method(globalThis, "fetch", async () => { networkCalls++; throw new Error("No network allowed in this test"); });
  try {
    const { getLateInvoiceCollections } = await import("../lib/lateInvoices");
    const rows = await getLateInvoiceCollections(due);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.reminders.every((c) => c.status === "unknown")));
    assert.equal(rows.find((r) => r.invoiceId === "phone-only")?.calledBy, "Sarah");
    assert.deepEqual(queries[0], {
      where: { amountDue: { gt: 0 }, OR: [{ invoiceStatus: "past_due" }, { invoiceStatus: "awaiting_payment", dueAt: { lt: due } }], issuedAt: { gte: new Date("2026-01-01T00:00:00Z") } },
      include: { customer: true },
    });
    assert.equal(networkCalls, 0);
  } finally {
    globals.prisma = previousPrisma; network.mock.restore();
  }
});

// Execute the actual component with synthetic hooks and a synthetic server
// action. This checks failure state without a browser, network or database.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createRequire } from "node:module";
const requireFromTest = createRequire(import.meta.url);

test("checkbox save failure preserves the prior checked state and legacy mark", async () => {
  for (const initial of [true, false]) {
    const states: unknown[] = [];
    let index = 0;
    const source = readFileSync(new URL("../app/risk/late-invoices/CalledCheckbox.tsx", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
    const compiledModule = { exports: {} as { CalledCheckbox: (props: object) => unknown } };
    const requireMock = (name: string) => name === "react" ? {
      useState: (initialValue: unknown) => {
        const i = index++;
        states[i] = initialValue;
        return [states[i], (next: unknown) => { states[i] = next; }];
      },
    } : name === "./actions" ? {
      setInvoiceCalled: async () => { throw new Error("Synthetic save failure"); },
    } : requireFromTest(name);
    new Function("require", "module", "exports", code)(requireMock, compiledModule, compiledModule.exports);
    const tree = compiledModule.exports.CalledCheckbox({ invoiceId: "synthetic", initial, calledBy: "Sarah", calledAt: "2026-10-01" });
    type Element = { type?: string; props?: { children?: unknown; onChange?: (event: { target: { checked: boolean } }) => Promise<void> } };
    function input(node: unknown): Element | undefined {
      if (!node || typeof node !== "object") return undefined;
      if (Array.isArray(node)) return node.map(input).find(Boolean);
      const element = node as Element;
      return element.type === "input" ? element : input(element.props?.children);
    }
    const checkbox = input(tree);
    assert.ok(checkbox?.props?.onChange);
    await checkbox.props.onChange({ target: { checked: !initial } });
    assert.equal(states[0], initial);
    assert.equal(states[1], "Sarah");
    assert.equal(states[2], "2026-10-01");
    assert.equal(states[3], "Could not save. Please retry.");
    assert.equal(states[4], false);
  }
});


test("UTC-midnight source values do not silently shift a date-only due date to the prior Arizona day", async () => {
  const { hasAmbiguousDateOnlyEncoding, sourceDueDateAge } = await import("../lib/collection-evidence");
  const cachedDateOnly = new Date("2026-10-01");
  const cachedMidnightInstant = new Date("2026-10-01T00:00:00Z");
  assert.equal(cachedDateOnly.getTime(), cachedMidnightInstant.getTime());
  // The cache lost the distinction: converting to Phoenix would show Sep 30.
  assert.equal(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", day: "numeric" }).format(cachedDateOnly), "30");
  for (const ambiguous of [cachedDateOnly, cachedMidnightInstant]) {
    assert.equal(hasAmbiguousDateOnlyEncoding(ambiguous), true);
    assert.equal(sourceDueDateAge(ambiguous, new Date("2026-10-02T12:00:00Z")), null);
    assert.ok(buildUnverifiedReminders(ambiguous, due).every((c) => c.status === "unknown" && c.approximateDaysUntil === undefined));
    assert.equal(ambiguous.toISOString(), "2026-10-01T00:00:00.000Z");
  }
  assert.equal(hasAmbiguousDateOnlyEncoding(new Date("2026-10-01T00:00:00-07:00")), false);
});
