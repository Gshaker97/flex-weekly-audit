import { Card, CardContent } from "@/components/ui/Card";
import { syncRunDiagnostics } from "@/lib/sync-writer-control";

/**
 * WHY THE LAST RUN SKIPPED OR STOPPED, without opening a container log.
 *
 * Two things, both read straight off the run row:
 *
 *   - every invoice card the run held, with the customer, the invoice number
 *     and a sentence saying why. A hold is usually the writer being careful,
 *     not a fault, so this is presented as information rather than an alarm.
 *   - if the run blocked, which invoice and step stopped it, and whether a
 *     GoHighLevel write was already in flight. That last part decides whether
 *     a person has to clear it by hand.
 *   - if the run took the daily full reconcile, what it checked against Jobber,
 *     which labels it corrected, and what it held.
 *
 * It renders nothing at all when a run reconciled nothing, skipped nothing and
 * blocked nothing, which is the normal case for most hourly runs.
 */
export function SyncSkipReport({ run, reconcileRun }: {
  run: { id: string; status: string; startedAt: Date; errorMessage: string | null } | null;
  /**
   * The most recent run that actually took a reconcile, which is usually NOT
   * the most recent run: the reconcile happens about once a day, so by the next
   * hour `run` carries no stamp. Without this the panel would appear for an
   * hour and then vanish, which is the opposite of a daily record.
   */
  reconcileRun?: { id: string; startedAt: Date; errorMessage: string | null } | null;
}) {
  if (!run) return null;
  const { skips, block } = syncRunDiagnostics(run.errorMessage, run.id);
  const stampSource = reconcileRun ?? run;
  const reconcile = syncRunDiagnostics(stampSource.errorMessage, stampSource.id).reconcile;
  if (!skips.length && !block && !reconcile) return null;

  return (
    <Card>
      <CardContent className="space-y-3 py-4 text-xs">
        {block && (
          <div className="space-y-1">
            <p className="font-medium text-danger">
              This sync stopped and later syncs will not run until it is cleared.
            </p>
            <p className="text-muted-foreground">
              It stopped while {block.step}
              {block.invoiceNumber ? ` for invoice #${block.invoiceNumber}` : ""}
              {block.customer ? ` (${block.customer})` : ""}: {block.reason}
            </p>
            <p className="text-muted-foreground">
              {block.pendingWrite
                ? "A GoHighLevel write was already in flight when it stopped, so somebody has to check what happened to that card before clearing this."
                : "Nothing was sent to GoHighLevel, so no customer was affected and no card was changed."}
            </p>
          </div>
        )}

        {skips.length > 0 && (
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {skips.length} invoice card{skips.length === 1 ? "" : "s"} skipped on this run
            </p>
            <p className="text-muted-foreground">
              Each one was left exactly as it was. A skip is normally the sync
              refusing to act on something it could not verify, not a failure.
            </p>
            <ul className="space-y-1 pt-1">
              {skips.map((s, i) => (
                <li key={`${s.invoiceNumber ?? "none"}-${i}`} className="text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {s.invoiceNumber ? `#${s.invoiceNumber}` : "(no invoice number)"}
                    {s.customer ? ` — ${s.customer}` : ""}
                  </span>{" "}
                  — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {reconcile && (
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              Full reconcile against Jobber — {reconcile.checkedInvoices} invoice
              {reconcile.checkedInvoices === 1 ? "" : "s"} and {reconcile.checkedCards} card
              {reconcile.checkedCards === 1 ? "" : "s"} checked
            </p>
            <p className="text-muted-foreground">
              {reconcile.scope}{" "}
              Last run {new Date(reconcile.at).toLocaleString("en-US", { timeZone: "America/Phoenix" })}.
            </p>

            {reconcile.corrected > 0 ? (
              <>
                <p className="pt-1 font-medium text-foreground">
                  {reconcile.corrected} stored label{reconcile.corrected === 1 ? "" : "s"} corrected
                </p>
                <ul className="space-y-1">
                  {reconcile.corrections.map((c, i) => (
                    <li key={`${c.invoiceNumber ?? "none"}-${i}`} className="text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {c.invoiceNumber ? `#${c.invoiceNumber}` : "(no invoice number)"}
                        {c.customer ? ` — ${c.customer}` : ""}
                      </span>{" "}
                      — {c.from ?? "no label"} → {c.to}
                    </li>
                  ))}
                </ul>
                {reconcile.corrected > reconcile.corrections.length && (
                  <p className="text-muted-foreground">
                    …and {reconcile.corrected - reconcile.corrections.length} more.
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                Every label already matched Jobber. Nothing needed correcting.
              </p>
            )}

            {reconcile.held > 0 && (
              <>
                <p className="pt-1 font-medium text-foreground">
                  {reconcile.held} invoice{reconcile.held === 1 ? "" : "s"} held
                </p>
                <ul className="space-y-1">
                  {reconcile.holdReasons.map((r, i) => (
                    <li key={`hold-${i}`} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{r.count}×</span> {r.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {reconcile.cardReasons.length > 0 && (
              <>
                <p className="pt-1 font-medium text-foreground">Cards the run left alone</p>
                <ul className="space-y-1">
                  {reconcile.cardReasons.map((r, i) => (
                    <li key={`card-${i}`} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{r.count}×</span> {r.reason}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
