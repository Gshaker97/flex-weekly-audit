# Local extension: journal-owned next invoice

This extends local candidate de604fb; it is not deployed or activated. No database
schema, notification engine, execution-log API or mandatory execution-ID receipt
was added. `GHL_CYCLE_OWNERSHIP_ENABLED` defaults off.

## What is implemented and tested

- The existing version-1 SyncRun JSON journal can carry optional cycle metadata.
  Legacy intents parse unchanged and remain redacted from public sync responses.
- Confirmed first enrollment records stable owner/invoice/workflow/location
  ownership. Balance and due-date edits never create a fresh invoice identity.
- Durable prepare checks all retained journals under existing admitted-writer
  serialization. Previously attempted enrollment for the same invoice is rejected,
  even across runs or after outside card-stage changes. Pending outcomes and corrupt
  history remain held. No history truncation or automatic journal deletion is added.
- Existing fresh-source Paid exits may record paid/zero completion for their owned
  invoice. The normal all-owner payment guard is not loosened.
- A later, different, uniquely unpaid invoice may reuse an owned card only after
  its predecessor has a confirmed paid/zero journal and fresh source still reports
  that predecessor paid/zero. A new invoice present in the old Paid snapshot is
  rejected; this narrow path does not handle overlapping unpaid cycles.
- Reset requires fresh, exact native cleanup acknowledgment. It either proves
  terminal execution removal with the exact old date still present, or proves
  ordered native removal/clear with the exact card now blank. Blank date alone,
  Paid stage alone, zero amount alone, elapsed time and a static QA assertion do
  not constitute acknowledgment.
- Only the proven owned old due date can be replaced; the verified ordered-clear
  alternative allows a blank date descended from that owned cycle. The date PUT
  is independently journaled/read back before a separate Paid-to-Sent PUT.
- Sent uses the new invoice's actual positive balance. This operation NEVER emits
  a new Paid/zero write for an owner who currently has unpaid debt. The old Paid
  proof predates the new invoice; it is not a claim the owner remains debt-free.
- The confirmed reset creates the next invoice's ownership path. The existing
  date-before-Overdue helper can then enroll that invoice without another manual
  15-minute clearance entry. A successor can repeat the same process after its
  own confirmed Paid exit. The first cycle still requires the initial explicitly
  reviewed clearance; unknown legacy cycles are not silently adopted.
- All source/identity/card/field/inventory checks, duplicate and monetary holds,
  unknown-outcome barriers and no-retry behavior remain in force.

## Live dependencies not implemented or verified

1. **Native cleanup acknowledgment adapter.** `defaults.nativeCleanup` returns
   null. It must return truthful exact old-cycle evidence after a real cleanup,
   bound to the recorded enrollment and Paid journal IDs and pinned contract hash.
   A verified ordered-remove/clear contract may supply this without a new API;
   otherwise exact execution proof is required. No provider ordering is assumed.
   No successful native runtime trigger/order/clear trace has been supplied.
   Browser recovery alone does not establish those semantics.
2. **Durable identity coverage.** The reused source adapter is strict by default.
   The two historical omitted source owners still prevent complete identity
   coverage where relevant. No authorization establishes a durable quarantine
   policy. A future approved account/owner policy must retain fresh exact-null,
   no-linked-record and overlap checks; old expiry is not silently extended.
3. **Real per-send guards.** Current stage-only native guards do not demonstrate
   the existing policy's `freshPaymentAndChannelGuards` assertion. Source-paid
   checks before our writes cannot guarantee a payment did not arrive before a
   later native message. Actual supported native behavior must be established or
   the approved guard contract explicitly revised; this patch does neither.
4. **Approved native cleanup policy/inventory.** Optional `nativeReset` identifies
   the exact published cleanup workflow, verified contract hash and review
   evidence. Its full workflow inventory remains pinned and rechecked. There is
   no real policy or native contract supplied here.

The cleanup adapter's recent acknowledgment is captured immutably for one reset
attempt. After our date PUT, the code validates that captured acknowledgment's
original age rather than calling the adapter to rediscover a blank field. It
must not return an arbitrary fresh timestamp for an old assertion or treat a
subsequently populated date as a newly observed clear. The recorded evidence and
retained journal must explain the original acknowledgment; later source/card/
inventory checks must still pass. Missing or uncertain proof stays held.

Existing closure remains Draft. The original Late Fee workflow and its 34 retained
executions are untouched. Day11+ entry/backlog handling is separate and unchanged.
Existing pending/blocked journals require operator review, never automated release.

## Verification

Offline mocked provider/DB tests exercise old/new cycles across runs, exact old-date
replacement, proven clear, absent/stale/wrong cleanup proof, corruption, legacy
privacy, changed-source duplicates, post-date payment, timeout/restart, and initial
reviewed enrollment. No external calls or publication occurred. Commands:

- `node --import tsx --test tests/ghl-*.test.ts tests/invoice-*.test.ts tests/sync-writer-control.test.ts tests/observed-phone-prefix.test.ts tests/notification-recurring-cron.test.ts`
- `./node_modules/.bin/tsc --noEmit --incremental false`

## Provider-read cost and timing caveat

Synthetic tests do not establish live throughput or whole-cohort completion. A
successful reset performs four complete readiness reads, four full workflow
inventory checks, two native acknowledgment reads before the date mutation, two
PUTs, and two full-card readbacks. Each readiness read repeats fresh full source
identity and GHL contact populations, all invoice-pipeline cards, the complete
owner invoice set, exact full card and DATE metadata, plus pipeline references.
Those reads may paginate. An already-aligned subsequent enrollment still needs
three readiness reads; blank-date enrollment needs four. Ordinary sync preflight
adds its own reads outside these counts. No batching/cache/performance changes
were added. Rate limits or latency may exceed the 60-second captured-cleanup proof
window or source freshness deadline, which safely holds/blocks rather than
renewing proof, retrying a provider mutation, or claiming the cohort completed.


## Paid-hook review corrections

A confirmed `reset_stage` owns the successor invoice even before any reminder
enrollment. The Paid hook selects that latest ownership instead of an older
invoice's enrollment. Thus B paid while still Sent records paid B, never another
paid A claim and never a fabricated B enrollment. A later C reset uses B's
ownership plus paid proof and still requires its own native cleanup acknowledgment.
The legacy internal `oldEnrollmentJournalId`/`oldEnrollment` property names may
therefore identify an owned reset-stage entry; its phase remains explicit and is
not interpreted as evidence that Fixed enrolled that invoice.

A source due-date edit cannot block an otherwise verified Paid exit. Paid cycle
metadata retains the historical owned card date, while the immutable source
snapshot records the actual edited source date. Reset uses the stable invoice ID,
source paid/zero evidence, and exact original card-date/native-clear proof; it does
not falsify the source date to make it match the history.

If an already-paid card is externally moved back to Overdue while all source debt
remains paid/zero, the ordinary verified corrective Paid PUT can proceed without
another duplicate Paid cycle claim. Existing ownership and previous proof remain
intact. This does not authorize replaying enrollment.
