/**
 * End-to-end readback proof on a DISPOSABLE local database.
 * Real migration, real hourly refresh, real dashboard helpers. Jobber is stubbed
 * at the HTTP layer; nothing touches production or GoHighLevel.
 */
import { prisma } from "./lib/prisma";
import { refreshOpenInvoiceStatuses } from "./lib/open-invoice-status-refresh";
import { oldestInvoiceVerification, invoiceVerificationState, invoiceVerificationBasis,
  describeDashboardFreshness } from "./lib/invoiceMetrics";

const DAY = 86_400_000;
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const say = (s: string) => console.log("PROOF: " + s);

async function main() {
  await prisma.invoiceRecord.deleteMany({});
  await prisma.customer.deleteMany({});
  await prisma.jobberAuth.deleteMany({});
  await prisma.syncRun.deleteMany({});

  await prisma.jobberAuth.create({ data: { id: "proof-auth", accessToken: "stub",
    refreshToken: "stub", expiresAt: new Date(now.getTime() + 3600_000) } as any });
  const owner = await prisma.customer.create({ data: { jobberClientId: "client-owner", name: "Proof Owner" } });

  // Mirrors production: every row last FULLY synced 159 days ago.
  const mk = (id: string, status: string, due: number, amountDue: number) =>
    prisma.invoiceRecord.create({ data: { jobberInvoiceId: id, invoiceNumber: id, invoiceStatus: status,
      subtotal: amountDue, total: amountDue, amountPaid: 0, amountDue, issuedAt: ago(due + 30),
      dueAt: ago(due), customerId: owner.id, clientName: "Proof Owner", lastSyncedAt: ago(159) } });
  await mk("inv-live", "past_due", 20, 137);        // Jobber confirms it, unchanged
  await mk("inv-dead", "past_due", 159, 137);       // Jobber returns null  <-- the real stale row
  await mk("inv-settled", "past_due", 25, 101.97);  // Jobber says paid, balance 0
  await prisma.syncRun.create({ data: { status: "complete", startedAt: new Date(now.getTime() - 600_000),
    completedAt: new Date(now.getTime() - 60_000), triggeredBy: "cron" } as any });

  // --- stub Jobber at the HTTP layer -------------------------------------
  const source: Record<string, unknown> = {
    "inv-live":    { id: "inv-live", invoiceStatus: "past_due", amounts: { total: 137, invoiceBalance: 137 }, client: { id: "client-owner" } },
    "inv-dead":    null,
    "inv-settled": { id: "inv-settled", invoiceStatus: "paid", amounts: { total: 101.97, invoiceBalance: 0 }, client: { id: "client-owner" } },
  };
  (globalThis as any).fetch = async (_url: string, init: any) => {
    const { variables } = JSON.parse(init.body);
    const data = Object.fromEntries(Object.entries(variables).map(([k, id]) => [k.replace("id", "i"), source[id as string]]));
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  };

  process.env.JOBBER_OPEN_STATUS_REFRESH_ENABLED = "true";
  process.env.JOBBER_PAID_BALANCE_CORRECTION_ENABLED = "true";
  const before = await prisma.invoiceRecord.findMany({ orderBy: { jobberInvoiceId: "asc" },
    select: { jobberInvoiceId: true, lastVerifiedAt: true, lastVerifyOutcome: true } });
  say("BEFORE the hourly run — nothing recorded:");
  for (const r of before) say(`   ${r.jobberInvoiceId.padEnd(12)} verifiedAt=${r.lastVerifiedAt} outcome=${r.lastVerifyOutcome}`);

  const plan = await refreshOpenInvoiceStatuses();
  say(`hourly run: checked=${plan!.checked} corrected=${plan!.updates.length} held=${plan!.holds.length} recorded=${plan!.verifications.length}`);

  // --- readback -----------------------------------------------------------
  const after = await prisma.invoiceRecord.findMany({ orderBy: { jobberInvoiceId: "asc" },
    select: { jobberInvoiceId: true, invoiceStatus: true, amountDue: true, lastSyncedAt: true,
      lastVerifiedAt: true, lastVerifyOutcome: true } });
  say("AFTER the hourly run — read back from the database:");
  for (const r of after) {
    const state = invoiceVerificationState(r, now);
    say(`   ${r.jobberInvoiceId.padEnd(12)} status=${String(r.invoiceStatus).padEnd(14)} due=$${r.amountDue} ` +
      `fullSync=${Math.round((now.getTime() - r.lastSyncedAt.getTime()) / DAY)}d ` +
      `verified=${r.lastVerifiedAt ? Math.round((now.getTime() - r.lastVerifiedAt.getTime()) / 60000) + "min" : "never"} ` +
      `outcome=${r.lastVerifyOutcome} -> ${state}`);
    const basis = invoiceVerificationBasis(r, now);
    if (basis) say(`                shown as: "${basis}"`);
  }

  // --- the live dashboard query, exactly as app/page.tsx runs it ----------
  const overdueUnpaid = await prisma.invoiceRecord.findMany({
    where: { invoiceStatus: { in: ["awaiting_payment", "past_due"] }, amountDue: { gt: 0 } },
    select: { amountDue: true, invoiceStatus: true, lastSyncedAt: true, lastVerifiedAt: true, lastVerifyOutcome: true },
  });
  const headline = overdueUnpaid.reduce((a, i) => a + (i.amountDue || 0), 0);
  const v = oldestInvoiceVerification(overdueUnpaid, now);
  const unconfirmedTotal = overdueUnpaid.filter(i => invoiceVerificationState(i, now) === "unconfirmed")
    .reduce((a, i) => a + (i.amountDue || 0), 0);
  const lastRun = await prisma.syncRun.findFirst({ where: { status: "complete", completedAt: { not: null } },
    orderBy: { completedAt: "desc" }, select: { completedAt: true } });
  say("LIVE DASHBOARD READBACK:");
  say(`   headline past-due total = $${headline.toFixed(2)} across ${overdueUnpaid.length} invoices`);
  say(`   of which Jobber could not confirm = $${unconfirmedTotal.toFixed(2)} across ${v.unconfirmedCount}`);
  say(`   staleCount=${v.staleCount} unconfirmedCount=${v.unconfirmedCount} oldestDays=${v.oldestDays}`);
  say(`   freshness line: ${describeDashboardFreshness(lastRun?.completedAt ?? null, v)}`);

  // --- assertions ---------------------------------------------------------
  const dead = after.find(r => r.jobberInvoiceId === "inv-dead")!;
  const live = after.find(r => r.jobberInvoiceId === "inv-live")!;
  const settled = after.find(r => r.jobberInvoiceId === "inv-settled")!;
  const checks: Array<[string, boolean]> = [
    ["hourly run recorded an outcome for every checked invoice", plan!.verifications.length === plan!.checked],
    ["confirmed-unchanged invoice is now marked confirmed", live.lastVerifyOutcome === "confirmed" && live.lastVerifiedAt !== null],
    ["confirmed invoice is NOT flagged despite a 159-day-old full sync", invoiceVerificationState(live, now) === "confirmed"],
    ["unconfirmable invoice recorded source_unavailable", dead.lastVerifyOutcome === "source_unavailable"],
    ["unconfirmable invoice did NOT get a confirmation timestamp", dead.lastVerifiedAt === null],
    ["unconfirmable invoice still has its original status", dead.invoiceStatus === "past_due"],
    ["unconfirmable invoice was NOT marked paid", dead.invoiceStatus !== "paid"],
    ["unconfirmable invoice keeps its balance", dead.amountDue === 137],
    ["unconfirmable invoice is STILL IN the headline total", overdueUnpaid.length === 2 && Math.abs(headline - 274) < 0.005],
    ["unconfirmable invoice is counted separately too", v.unconfirmedCount === 1 && Math.abs(unconfirmedTotal - 137) < 0.005],
    ["the dashboard flags exactly 1, not all 3", v.staleCount === 1],
    ["its row text names it unconfirmed, not paid", /could not confirm/.test(invoiceVerificationBasis(dead, now) ?? "") &&
      !/paid|settled/i.test(invoiceVerificationBasis(dead, now) ?? "")],
    ["the genuine payment still applied (balance 0, status paid)", settled.invoiceStatus === "paid" && settled.amountDue === 0],
    ["the paid invoice left the overdue population", !overdueUnpaid.some(i => i.amountDue === 101.97)],
    ["full-sync timestamps were never advanced by the hourly run",
      after.every(r => Math.round((now.getTime() - r.lastSyncedAt.getTime()) / DAY) === 159)],
  ];
  say("ASSERTIONS:");
  let failed = 0;
  for (const [label, ok] of checks) { if (!ok) failed++; say(`   ${ok ? "PASS" : "FAIL"}  ${label}`); }
  say(failed ? `RESULT: ${failed} FAILED` : `RESULT: all ${checks.length} passed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { say("ERROR " + (e?.message ?? e)); process.exit(1); });
