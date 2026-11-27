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
 *
 * It renders nothing at all when a run skipped nothing and blocked nothing,
 * which is the normal case.
 */
export function SyncSkipReport({ run }: {
  run: { id: string; status: string; startedAt: Date; errorMessage: string | null } | null;
}) {
  if (!run) return null;
  const { skips, block } = syncRunDiagnostics(run.errorMessage, run.id);
  if (!skips.length && !block) return null;

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
      </CardContent>
    </Card>
  );
}
