import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { AlertCircle, ListTodo, CheckCircle2, FileText } from "lucide-react";
import RunAuditButton from "./RunAuditButton";

export const dynamic = "force-dynamic";

export default async function AuditsPage() {
  const latest = await prisma.audit.findFirst({
    orderBy: { startedAt: "desc" },
    include: { flaggedJobItems: { orderBy: { totalAmount: "desc" } } },
  });

  const recent = await prisma.audit.findMany({
    orderBy: { startedAt: "desc" },
    take: 20,
  });

  const totalFlaggedValue = latest
    ? latest.flaggedJobItems.reduce((acc, j) => acc + (j.totalAmount || 0), 0)
    : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Job Completion Audits</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Find jobs that aren&apos;t marked complete or are missing an invoice.
          </p>
        </div>
        <RunAuditButton />
      </div>

      {latest && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Jobs Audited"
              value={latest.totalJobs}
              sublabel={`Range: ${formatDate(latest.weekStart)} – ${formatDate(new Date(latest.weekEnd.getTime() - 1))}`}
              icon={<ListTodo size={18} />}
            />
            <StatCard
              label="Marked Complete"
              value={latest.completedJobs}
              sublabel={
                latest.totalJobs > 0
                  ? `${Math.round((latest.completedJobs / latest.totalJobs) * 100)}% completion rate`
                  : undefined
              }
              accent="success"
              icon={<CheckCircle2 size={18} />}
            />
            <StatCard
              label="Invoiced"
              value={latest.invoicedJobs}
              sublabel={
                latest.totalJobs > 0
                  ? `${Math.round((latest.invoicedJobs / latest.totalJobs) * 100)}% invoiced rate`
                  : undefined
              }
              accent="success"
              icon={<FileText size={18} />}
            />
            <StatCard
              label="Flagged Value"
              value={formatCurrency(totalFlaggedValue)}
              sublabel={`${latest.flaggedJobs} jobs need attention`}
              accent={latest.flaggedJobs > 0 ? "danger" : "success"}
              icon={<AlertCircle size={18} />}
            />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Most Recent Audit · {formatDateTime(latest.startedAt)}</CardTitle>
              <CardDescription>
                {latest.flaggedJobs > 0
                  ? `${latest.flaggedJobs} flagged jobs · ${formatCurrency(totalFlaggedValue)} in flagged value`
                  : "All jobs in this audit look good."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {latest.flaggedJobItems.length === 0 ? (
                <p className="text-sm text-muted-foreground">No flagged jobs.</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50">
                      <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="px-4 py-2.5 font-medium">Job</th>
                        <th className="px-4 py-2.5 font-medium">Client</th>
                        <th className="px-4 py-2.5 font-medium">Value</th>
                        <th className="px-4 py-2.5 font-medium">Issues</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {latest.flaggedJobItems.slice(0, 50).map((j) => (
                        <tr key={j.id} className="hover:bg-muted/30">
                          <td className="px-4 py-3">
                            <div className="font-medium">
                              {j.jobNumber ? `#${j.jobNumber}` : "—"}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {j.jobTitle ?? ""}
                            </div>
                          </td>
                          <td className="px-4 py-3">{j.clientName ?? "—"}</td>
                          <td className="px-4 py-3 font-semibold">
                            {formatCurrency(j.totalAmount)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap gap-1">
                              {j.flagReasons.map((r) => (
                                <Badge key={r} variant="danger">
                                  {r}
                                </Badge>
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {latest.flaggedJobItems.length > 50 && (
                    <div className="border-t border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
                      Showing 50 of {latest.flaggedJobItems.length} flagged jobs.{" "}
                      <Link
                        href={`/audits/${latest.id}`}
                        className="text-accent hover:underline"
                      >
                        View all →
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Audit History</CardTitle>
          <CardDescription>Past audit runs</CardDescription>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audits yet.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Range start</th>
                    <th className="px-4 py-2.5 font-medium">Run at</th>
                    <th className="px-4 py-2.5 font-medium">Total</th>
                    <th className="px-4 py-2.5 font-medium">Flagged</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recent.map((a) => (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{formatDate(a.weekStart)}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(a.startedAt)}
                      </td>
                      <td className="px-4 py-3">{a.totalJobs}</td>
                      <td className="px-4 py-3">
                        {a.flaggedJobs > 0 ? (
                          <Badge variant="danger">{a.flaggedJobs}</Badge>
                        ) : (
                          <Badge variant="success">0</Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <AuditStatusBadge status={a.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/audits/${a.id}`}
                          className="text-xs font-medium text-accent hover:underline"
                        >
                          View →
                        </Link>
                      </td>
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

function AuditStatusBadge({ status }: { status: string }) {
  if (status === "complete") return <Badge variant="success">Complete</Badge>;
  if (status === "failed") return <Badge variant="danger">Failed</Badge>;
  if (status === "running") return <Badge variant="warning">Running</Badge>;
  return <Badge variant="muted">{status}</Badge>;
}
