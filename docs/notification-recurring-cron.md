# Disabled recurring Day10 cron integration

This is local, default-disabled wiring, not activation or a deployment. The ordinary
standalone cron schedule, cache writes, GHL review mode, phone-write hold and sync
admission rules are unchanged. There is no new route, scheduler or migration.

## Exact callsite and lifetime

`scripts/sync-cron.ts` still awaits `runFullSync({ triggeredBy: "cron", entrypoint:
"standalone_cron" })`. `lib/sync.ts` invokes the new hook once after successful
admission, writer creation, `fetchAllClients`, `upsertClients` and the client-count
update, before starting either heavy job/visit feed. This preserves the first
ordinary Jobber token lifecycle. Notification reads never force a refresh.

`lib/notification-recurring-cron.ts` exposes the production hook with only the
entrypoint as input. The admitted sync owns its invocation. HTTP/manual entrypoints cannot load the
configuration, even if `triggeredBy` says cron. An absent mode or `disabled` returns
without policy/runtime imports, private configuration reads, provider/DB calls, logging or
writer changes. A bare `true` is invalid, not authorization.

For an enabled mode the hook awaits one service, including all outstanding work.
It never wraps that promise in a timeout race. The service's finite deadline stops
new operations; already running bounded adapters must settle before ownership can
be released. A process kill retains existing running/pending barriers.

## Private standing installation, separate authorized step

Nothing in this patch sets production variables or runs a live read/send. Before
activation an authorized deployer must provision a reviewed private installation
as the existing cron's Railway service variable **`FLEXX_RECURRING_DAY10_POLICY_JSON`**,
at most 32 KiB of UTF-8 JSON. This operator-controlled deployment value cannot be
supplied through HTTP, command arguments or another production hook caller. No
new file mount, volume or startup script is required. Do not commit the actual
account, quarantine identities, sender or footer into the repository.

The JSON envelope has exactly these keys:

- `version`: `1`.
- `deployment`: exactly `projectId`, `environmentId`, `serviceId`, `accountId`,
  `locationId`, all the actual reviewed values. `serviceId` identifies the existing
  standalone cron, not the web service.
- `policy`: the complete `RecurringDay10Policy` accepted by
  `installRecurringDay10Policy`. This is the authority installed from the reviewed
  private deployment configuration, never an approval flag in caller JSON.

Required policy fields are `accountId`, `locationId`, original `validFrom` and
`validUntil`, cohort `source-verified-open-homeowner-invoices`, the exact two-entry
quarantine (`jobberClientId`, `email`, `phone`), the original Day10 template
(`id`, `version`, `body` equal to `ORIGINAL_DAY10_SMS_BODY`), configured `sender`,
and the reviewed `nativeSms` receipt contract (`version: "2021-07-28"`,
`status: "pending"`, `receiptSource: "app"`, exact `suffix`). It also fixes
`channel: "sms"`, `dayPastDue: 10`, `timeZone: "America/Phoenix"`,
`window: "[09:00:00,09:15:00)"`, `missed: "no-catch-up"`, a reviewed integer
`maximumAdmissionsPerRun` and `action: "read-only"` or `"attempt"`.

Through that same authorized deployment boundary, provision:

- `FLEXX_RECURRING_DAY10_MODE`: absent/`disabled` by default; `read-only` or
  `attempt` only when that operation is authorized.
- `FLEXX_RECURRING_DAY10_POLICY_JSON`: the complete reviewed envelope above.
- `FLEXX_RECURRING_DAY10_POLICY_SHA256`: SHA-256 of the exact private UTF-8 value
  bytes, including whitespace. This is integrity binding, not authority by itself.
- `FLEXX_RECURRING_DAY10_ACCOUNT_ID`: the reviewed Jobber account, independently
  matching both the deployment envelope and standing policy.

Existing built-in Railway project, environment, service and nonempty deployment
metadata must match, as must `GHL_LOCATION_ID`. The deployed runtime independently
pins the already verified cron service and existing environment/project, requires
the existing credentials and preserves `SYNC_ADMISSION_MODE=cron_only`,
`GHL_INVOICE_WRITE_MODE=review`, `GHL_PHONE_WRITES_ENABLED=false`, and the generic
notification hold. Do not change the existing `0 * * * *` schedule. Setting only
the mode never suffices. Attempt mode cannot upgrade a read-only installed policy.
Environment changes during a run stop later operations; the installed policy is
immutable and its dates/content/limits are not extended.

This is standing cohort authorization, not a per-invoice or daily approval chore.
Every new service instance obtains fresh bounded inventory/source/identity/history
evidence. An old source or policy handle is never renewed. New invoices can qualify
under the standing policy; previously pending/unknown events cannot be retried.
Missing channel DND remains held. No email fallback, later milestone, fee,
suspension or Angie format is enabled by this hook.

## Failure visibility and barriers

The hook emits one bounded log line with fixed state/code labels and numeric
invoice, hold, admission and message-attempt counts. It never logs the policy,
destinations, source rows, provider payloads or raw exception/reason text.

- Missing/invalid private configuration: `held`, `policy_unavailable`, no service
  execution. Ordinary cache sync continues.
- Known service holds: a visible summary; no same-run reattempt. Non-current Day10
  inventory rows alone are not counted as notification failures.
- The other hourly runs' `outside_arizona_window_no_catch_up` result and a complete
  run with no current candidates are normal no-ops, not failure alerts.
- Service rejection, malformed result or any unknown event: await settlement,
  report the redacted issue and persist it in `SyncRun.errorMessage`, preserving it
  alongside later visit warnings or a sync failure. Then continue ordinary cache
  refresh. The event ledger's pending/unknown barrier is retained; the hook never
  retries it. A settled SMS uncertainty does not impose a blanket dashboard outage
  or manual sync unlock. The existing shared `SyncRunWriter` journal uncertainty
  still blocks admission exactly as before, independently of this hook.

The shared Prisma connection belongs to the standalone script, which disconnects
after the awaited sync. The hook never disconnects it midway through cache work.

## Synthetic validation

Run `node --import tsx --test tests/notification-recurring-cron.test.ts` for disabled
and HTTP no-op checks, installation hash/deployment/action binding, counts-only
reporting, settled unknown visibility without global blocking, pending-promise settlement, fresh service
creation, inert real-module import and actual callsite ordering. These tests have
no registry, database or provider calls. Run the full existing test suite and
`node_modules/.bin/tsc --noEmit` after combining the recurring service dependency.
