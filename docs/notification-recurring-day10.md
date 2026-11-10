# Disabled automatic Day10 binding

This local follow-on starts at frozen `2cdc49bb01378702163c9a8b7c455cec131db29a`. It has not been published, deployed, activated, or run with production credentials. All development executions used synthetic IO. No migration, provider send, fee, suspension, or collections action was performed.

## Concrete execution

`createRecurringDay10Service()` is an exact no-op, including throwing policy/runtime getters. Attempt mode also returns before runtime acquisition outside `[09:00:00,09:15:00)` America/Phoenix. There is no catch-up. Explicit read-only mode can inspect the real flow at any time but cannot reserve or send.

Inside the window, one exhausted invoice discovery query identifies current Day10 candidates, then one genuine shared source population is read. Only those Day10 candidates receive exact source/sender/DND/history checks. Inventory discovery alone never authorizes sending. The service uses the actual source/inventory adapters and `createNotificationRunner`, not a parallel sender:

1. Real discovery and original batch capability generate current source pins. Exact owner/cache/contact/quarantine/invoice reads issue an opaque v2 source capability.
2. Installed standing policy and matching current primary SMS identity derive each exact immutable Event. The template is the original approved Day10 SMS constant, with no monetary substitution or currency requirement, and no claimed enforcement facts.
3. The existing runner reads exact configured SMS sender, native suffix policy, recipient/DND, accessible GHL history and independent local ledger. It rereads the source before admission, durably reserves the immutable event, then rereads source, sender, identity, DND and history again before the transport marks pending and makes at most one POST.
4. Every source refresh remains tied to the original batch and original five-minute population expiry. A cloned or v1 source cannot enter the v2 path. Earlier external observations are not re-stamped.
5. The original durable ledger retains event and homeowner-contact/day uniqueness. Two current Day10 invoices for one contact both hold. Unimplemented Day15/20/25/30 entries do not falsely block Day10, but any existing durable contact/day claim still applies. Unknown outcomes stop the batch; no auto-retry, reclaim, release, or catch-up exists.

The source/DND adapters remain unchanged in meaning: missing SMS DND is held, not inferred allowed; no Email fallback; missing tags do not block common Day10. Configured sender is reread at every evidence phase, including after reservation. The native footer is an exact receipt suffix, not appended to the outbound message body.

## Trusted standing policy, not per-invoice approval

`installRecurringDay10Policy()` is the privileged authenticated application/operator installation boundary. Its input is **not** browser/request JSON. Validation and a generated policy digest establish schema/integrity/provenance only; they do not authenticate who called the function. It must only be invoked after the operator/configuration boundary has established authority. Only its original process-local opaque handle is accepted by the service. A boolean, reference string, clone, or serialized handle cannot substitute.

The policy pins account/location, source-verified open homeowner cohort, the exact reviewed quarantine pair, exact original Day10 body and template ID/version, explicit sender, exact native suffix and verified pending/app contract, SMS channel, due-date Day10, Arizona window, no catch-up, finite validity, action, and maximum admissions per run. It contains no invoice list, selected customer phone, currency assertion, or extra approval-reference strings.

Each **new invocation** derives a fresh finite read request under that standing policy. The actual population reader rechecks source active/archive identity coverage, both omitted identities' continued absence and zero cache links. Thus existing short read-scope/omission freshness is not a daily approval chore. No existing source or inventory capability is renewed or extended. Any changed/reappeared quarantine identity holds the run.

Admission budget is burned before database reserve IO, including uncertain acknowledgment. Candidate count above the configured maximum holds the entire current cohort rather than silently selecting a first subset. Every discovered row remains represented by an ordinal; unprocessed current candidates remain explicit after a stop. The returned result contains no identifiers, destinations, balance, body, credential, exception text, or provider payload beyond the existing runner's bounded structured transport result. Callers should log only aggregate safe counts/status, not nested transport data.

## Real deployment binding

`deployedRecurringDay10Runtime(handle, scope, mode)` validates the original policy, scope, and quarantine pins, then uses the existing no-refresh Jobber reader and real deployed inventory/source adapters. `verifyRecurringDay10DeploymentHolds` pins the standalone cron service `ee3a4c67-8b0c-48d2-871d-e20bed336c4a`, environment `bc72bc2d-9a4c-494d-8bee-9ca782db1240`, existing project, deployment, location and credential continuity. Legacy web-pilot/read-inspection behavior stays web-only by default.

Existing holds remain mandatory: `GHL_INVOICE_WRITE_MODE=review`, `GHL_PHONE_WRITES_ENABLED=false`, `SYNC_ADMISSION_MODE=cron_only`, and legacy `GHL_NOTIFICATIONS_ENABLED` must not be true. They are not changed by this patch. Existing Jobber auth must have at least 900 seconds remaining; this bootstrap does not refresh/save tokens.

The source cache operations run in read-only transactions with 1-second acquisition, 2.5-second statement and 5-second transaction limits. Auth, history and ledger operations retain their bounded transactions. Provider readers and one-attempt transport retain their bounded requests. Service timeout stops future IO and awaits the in-flight operation's settlement; it does not race-return and release the cron writer while a reservation or POST is unresolved. Injected runtimes must honor the same bounded-operation/no-retry contract.

## Integration and minimum activation inputs

The callable composition for an already authenticated installed policy is:

```ts
const service = createRecurringDay10Service({
  mode,
  policy: installed,
  runtime: scope => deployedRecurringDay10Runtime(installed, scope, mode),
});
const result = await service.run();
```

The companion default-disabled hook belongs inside the existing admitted standalone cron run after the first ordinary client fetch/upsert has made tokens available, and **before** the long invoice/job/cache feed refresh. Await it without an outer timeout race. Unknown outcomes stop this notification batch and retain its event ledger fence. Drain all in-flight IO before continuing; a settled unknown does not stop independent cache refresh. Actual shared SyncWriterBlockedError/journal uncertainty retains its existing global barrier. Keep the existing hourly cron schedule: the local window gate makes other hours inert. A 09:00 run that reaches the hook too late holds rather than catching up.

Activation still requires separately authorized publication/deployment and installation of actual trusted policy values: exact account/location and reviewed quarantine pair, original template identity, real configured sender, observed exact native suffix/contract, policy validity, action limit and selected action. These are one standing service configuration, not manual invoice or daily approval files. The companion hook/configuration module owns its deployment mode/integrity pins. No values are guessed or auto-enabled here. This follow-on does not alter the currently live release.

Provider unfiltered-query default status scope and account-wide cache-only omission coverage are still not proven. The service makes no whole-account coverage claim, never marks missing invoices paid/deleted, and does not clear unresolved records. Existing selected-owner completeness checks continue to hold missing cached source invoices.

## Explicitly pending, independent of Day10

Later Day15/20/25/30 conditional wording and genuine invoice-bound effect facts remain pending. Email transport remains unverified. Angie Day21 must use the actual approved internal recipient/routing and content; a new daily digest is **not** a user requirement and is not introduced here. None of these is a prerequisite to finishing this disabled Day10 binding.

## Verification

Run `node --import tsx --test tests/notification-recurring-day10.test.ts`, the entire `tests/*.test.ts tests/*.test.mjs` suite, TypeScript, targeted ESLint, and `git diff --check`. The new synthetic tests cover original/v2 source authenticity and freshness, multiple owners/invoices, no repeated all-contact scans, SMS identity and DND, prior attempts, final source balance/date/identity changes, sender/footer binding, durable unknown/timeout outcomes, cooperative deadline drain, daily standing-policy reuse, capacity/action limits, runtime cron pins and read-only SQL/HTTP guards. None contacts a real provider.
