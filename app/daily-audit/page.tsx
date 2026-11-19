import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/utils";
import type { CheckResult, CheckStatus } from "@/lib/daily-audit/run";
import RunDailyAuditButton from "./RunDailyAuditButton";

export const dynamic = "force-dynamic";

const STATUS: Record<CheckStatus, { label: string; variant: "success" | "warning" | "danger" | "muted" }> = {
  pass: { label: "Pass", variant: "success" },
  warn: { label: "Check", variant: "warning" },
  fail: { label: "Fail", variant: "danger" },
  error: { label: "Didn't run", variant: "danger" },
};

export default async function DailyAuditPage() {
  const recent = await prisma.dailyAuditReport.findMany({
    orderBy: { startedAt: "desc" },
    take: 14,
  });
  const latestDone = recent.find((r) => r.status !== "running") ?? null;
  const running = recent[0]?.status === "running" &&
    Date.now() - recent[0].startedAt.getTime() < 30 * 60_000;
  const checks = ((latestDone?.checks ?? []) as unknown) as CheckResult[];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Daily Audit</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each morning: the dashboard against Jobber, the GHL Invoice Pipeline, and whether every
            late invoice got its reminder on the right day. Read-only; nothing is changed or sent.
          </p>
        </div>
        <RunDailyAuditButton running={running} />
      </div>

      {!latestDone ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No daily audit has run yet.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                {latestDone.runDate} · {formatDateTime(latestDone.startedAt)}
              </CardTitle>
              <CardDescription>
                {latestDone.status === "failed"
                  ? `The run stopped early: ${latestDone.errorMessage ?? "unknown error"}`
                  : latestDone.failCount === 0 && latestDone.warnCount === 0
                  ? "Everything checks out."
                  : `${latestDone.failCount} failing, ${latestDone.warnCount} to check.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {checks.map((c) => (
                  <li key={c.key} className="flex items-start justify-between gap-4 py-3">
                    <div>
                      <a href={`#${c.key}`} className="font-medium hover:underline">
                        {c.title}
                      </a>
                      <p className="text-sm text-muted-foreground">{c.summary}</p>
                    </div>
                    <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {checks
            .filter((c) => c.rows.length > 0 || c.notes.length > 0)
            .map((c) => (
              <Card key={c.key} id={c.key}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-4">
                    <CardTitle>{c.title}</CardTitle>
                    <Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge>
                  </div>
                  <CardDescription>{c.summary}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {c.rows.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                            {c.columns.map((col) => (
                              <th key={col} className="px-4 py-2.5 font-medium whitespace-nowrap">
                                {col}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {c.rows.map((row, i) => (
                            <tr key={i} className="hover:bg-muted/30 align-top">
                              {c.columns.map((col) => (
                                <td key={col} className="px-4 py-2.5">
                                  {row[col] ?? "—"}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {c.totalRows > c.rows.length && (
                        <div className="border-t border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                          Showing {c.rows.length} of {c.totalRows}.
                        </div>
                      )}
                    </div>
                  )}
                  {c.notes.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                      {c.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            ))}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No runs yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Started</th>
                    <th className="px-4 py-2.5 font-medium">Trigger</th>
                    <th className="px-4 py-2.5 font-medium">Failing</th>
                    <th className="px-4 py-2.5 font-medium">To check</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recent.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-medium">{r.runDate}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{formatDateTime(r.startedAt)}</td>
                      <td className="px-4 py-2.5">{r.triggeredBy}</td>
                      <td className="px-4 py-2.5">{r.failCount}</td>
                      <td className="px-4 py-2.5">{r.warnCount}</td>
                      <td className="px-4 py-2.5">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
