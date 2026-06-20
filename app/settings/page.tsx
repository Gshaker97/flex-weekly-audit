import { prisma } from "@/lib/prisma";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatDateTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const auth = await prisma.jobberAuth.findFirst({
    orderBy: { createdAt: "desc" },
  });

  const lastSync = await prisma.syncRun.findFirst({
    orderBy: { startedAt: "desc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage the Jobber connection and sync schedule
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Jobber Connection</CardTitle>
          <CardDescription>OAuth status with Flexx Landscaping&apos;s Jobber account</CardDescription>
        </CardHeader>
        <CardContent>
          {auth ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant="success">Connected</Badge>
                <span className="text-sm text-muted-foreground">
                  Token expires {formatDateTime(auth.expiresAt)}
                </span>
              </div>
              <a href="/api/auth/jobber/connect">
                <Button variant="outline" size="sm">Reconnect</Button>
              </a>
            </div>
          ) : (
            <div className="space-y-3">
              <Badge variant="danger">Not connected</Badge>
              <div>
                <a href="/api/auth/jobber/connect">
                  <Button variant="accent">Connect Jobber</Button>
                </a>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Data Sync</CardTitle>
          <CardDescription>
            Pulls Jobber clients, jobs, and invoices into the local database
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="text-sm text-muted-foreground">
              {lastSync ? (
                <>
                  Last sync: {formatDateTime(lastSync.startedAt)}
                  {" · "}Status: <Badge variant={lastSync.status === "complete" ? "success" : lastSync.status === "failed" ? "danger" : "warning"}>{lastSync.status}</Badge>
                  <div className="mt-2 text-xs">
                    {lastSync.customersFetched} customers · {lastSync.jobsFetched} jobs · {lastSync.invoicesFetched} invoices · {lastSync.ghlOpportunitiesSynced} GHL opps
                  </div>
                </>
              ) : (
                "No syncs run yet."
              )}
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-4">
              <p className="text-sm font-medium">Scheduled sync endpoint</p>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                POST /api/sync/run with header{" "}
                <span className="text-foreground">x-cron-secret: $CRON_SECRET</span>
              </p>
              <p className="mt-3 text-xs text-muted-foreground">
                Set up a daily cron in Railway to keep KPIs fresh. Recommended schedule:
                3:00 AM Arizona time daily.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
