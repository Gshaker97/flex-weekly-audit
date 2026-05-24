import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { AlertCircle, CheckCircle2, FileText, ListTodo } from "lucide-react";
import RunAuditButton from "./RunAuditButton";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const auth = await prisma.jobberAuth.findFirst({
    orderBy: { createdAt: "desc" },
  });

  if (!auth) {
    return <ConnectJobberPrompt />;
  }

  const latest = await prisma.audit.findFirst({
    orderBy: { startedAt: "desc" },
    include: {
      flaggedJobItems: { orderBy: { totalAmount: "desc" } },
    },
  });

  const recentAudits = await prisma.audit.findMany({
    orderBy: { startedAt: "desc" },
    take: 8,
  });

  const completionRate =
    latest && latest.totalJobs > 0
      ? Math.round((latest.completedJobs / latest.totalJobs) * 100)
      : null;
  const invoicedRate =
    latest && latest.totalJobs > 0
      ? Math.round((latest.invoicedJobs / latest.totalJobs) * 100)
      : null;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Operations Audit
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {latest ? (
              <>
                Last run {formatDateTime(latest.startedAt)} — covering{" "}
                {formatDate(latest.weekStart)} through{" "}
                {formatDate(new Date(latest.weekEnd.getTime() - 1))}
              </>
            ) : (
              "No audits yet. Pick a range and run your first audit."
            )}
          </p>
        </div>
        <RunAuditButton />
      </div>

      {latest ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Total Jobs in Range"
              value={latest.totalJobs}
              sublabel="Jobs scheduled or completed"
              icon={<ListTodo size={18} />}
            />
            <StatCard
              label="Marked Complete"
              value={`${latest.completedJobs}`}
              sublabel={
                completionRate != null ? `${completionRate}% completion rate` : undefined
              }
              accent="success"
              icon={<CheckCircle2 size={18} />}
            />
            <StatCard
              label="Invoiced"
              value={`${latest.invoicedJobs}`}
              sublabel={
                invoicedRate != null ? `${invoicedRate}% invoiced rate` : undefined
              }
              accent="success"
              icon={<FileText size={18} />}
            />
            <StatCard
              label="Needs Attention"
              value={latest.flaggedJobs}
              sublabel="Missing status or invoice"
              accent={latest.flaggedJobs > 0 ? "danger" : "success"}
              icon={<AlertCircle size={18} />}
            />
          </div>

          {latest.status === "failed" && (
            <Card className="border-danger/30 bg-danger-bg">
              <CardContent className="pt-6">
                <p className="text-sm font-medium text-danger">
                  Last audit failed
                </p>
                <p className="mt-1 text-sm text-danger/80">
                  {latest.errorMessage}
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Flagged Jobs</CardTitle>
              <CardDescription>
                Jobs in this range that are missing a completion status, an
                invoice, or both.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {latest.flaggedJobItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border py-12 text-center">
                  <CheckCircle2
                    size={32}
                    className="mx-auto text-success"
                  />
                  <p className="mt-3 text-sm font-medium">
                    All jobs are complete and invoiced
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Nothing needs attention for this range.
                  </p>
                </div>
              ) : (
                <FlaggedJobsTable items={latest.flaggedJobItems} />
              )}
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">
              Run your first audit to see job and invoice status.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent Audits</CardTitle>
          <CardDescription>History of past audit runs</CardDescription>
        </CardHeader>
        <CardContent>
          {recentAudits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No previous audits.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Range start</th>
                    <th className="px-4 py-2.5 font-medium">Run at</th>
                    <th className="px-4 py-2.5 font-medium">Trigger</th>
                    <th className="px-4 py-2.5 font-medium">Total</th>
                    <th className="px-4 py-2.5 font-medium">Flagged</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentAudits.map((a) => (
                    <tr key={a.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">
                        {formatDate(a.weekStart)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDateTime(a.startedAt)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {a.triggeredBy}
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

function FlaggedJobsTable({ items }: { items: any[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-4 py-2.5 font-medium">Job</th>
            <th className="px-4 py-2.5 font-medium">Client</th>
            <th className="px-4 py-2.5 font-medium">End date</th>
            <th className="px-4 py-2.5 font-medium">Status</th>
            <th className="px-4 py-2.5 font-medium">Amount</th>
            <th className="px-4 py-2.5 font-medium">Issues</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((j) => (
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
              <td className="px-4 py-3 text-muted-foreground">
                {formatDate(j.scheduledEnd ?? j.completedAt)}
              </td>
              <td className="px-4 py-3">
                <Badge variant="muted">{j.jobStatus ?? "unknown"}</Badge>
              </td>
              <td className="px-4 py-3 font-medium">
                {formatCurrency(j.totalAmount)}
              </td>
              <td className="px-4 py-3">
                <div className="flex flex-wrap gap-1">
                  {j.flagReasons.map((r: string) => (
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
    </div>
  );
}

function ConnectJobberPrompt() {
  return (
    <div className="mx-auto mt-12 max-w-xl">
      <Card>
        <CardHeader>
          <CardTitle>Connect Jobber to get started</CardTitle>
          <CardDescription>
            Authorize this app to read jobs, invoices, and clients from your
            Flex Landscaping Jobber account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <a href="/api/auth/jobber/connect">
            <Button variant="accent" size="lg" className="w-full">
              Connect Jobber Account
            </Button>
          </a>
          <p className="mt-3 text-xs text-muted-foreground">
            You&apos;ll be redirected to Jobber to grant read-only access.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
