import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function AuditDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const audit = await prisma.audit.findUnique({
    where: { id: params.id },
    include: { flaggedJobItems: { orderBy: { totalAmount: "desc" } } },
  });

  if (!audit) return notFound();

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back to dashboard
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">
          Audit · Week of {formatDate(audit.weekStart)}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Run {formatDateTime(audit.startedAt)} · Trigger: {audit.triggeredBy}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Jobs" value={audit.totalJobs} />
        <StatCard label="Completed" value={audit.completedJobs} accent="success" />
        <StatCard label="Invoiced" value={audit.invoicedJobs} accent="success" />
        <StatCard
          label="Flagged"
          value={audit.flaggedJobs}
          accent={audit.flaggedJobs > 0 ? "danger" : "success"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flagged Jobs</CardTitle>
          <CardDescription>
            Jobs missing completion status or an invoice
          </CardDescription>
        </CardHeader>
        <CardContent>
          {audit.flaggedJobItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No flagged jobs in this audit.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Job</th>
                    <th className="px-4 py-2.5 font-medium">Client</th>
                    <th className="px-4 py-2.5 font-medium">End</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Amount</th>
                    <th className="px-4 py-2.5 font-medium">Issues</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audit.flaggedJobItems.map((j) => (
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
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
