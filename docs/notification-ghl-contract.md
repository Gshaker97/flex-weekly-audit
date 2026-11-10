# Disabled GHL message contract and read-only adapter

This candidate adds only `lib/notification-ghl-contract.ts` and its local tests. It does not wire into a cron, route, dispatcher, database, or live account. Every production-send capability flag remains false. This module does not contain a POST transport; a separate unwired, explicitly reviewed candidate is described in [notification-ghl-transport.md](notification-ghl-transport.md). No provider calls, credentials, account reads, migrations, workflow activation, or deployment were performed for these changes.

The module has two different boundaries:

- Pure parsers and inert outbound request descriptors, usable with synthetic fixtures.
- An optional, explicitly injected **GET-only** reader. Constructing it is inert. Calling its named read methods would make real reads if a real client and credential were supplied. This implementation is checked with in-memory fake clients. The narrow native-SMS parsing update below is informed by a separately authorized single live test, not by additional provider calls from this change.

## Pinned public contract

Public official documentation was checked on November 9, 2026:

- [Contact response](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/contacts/get-contact/): wrapped `contact`, exact `id` and `locationId`, primary and additional destinations, global `dnd`, and capitalized `dndSettings.SMS` / `dndSettings.Email`.
- [Send request and acceptance](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/conversations/send-a-new-message/): `POST /conversations/messages`, version `2021-07-28`, `SMS` / `Email`, explicit sender/recipient fields, and returned message/conversation IDs. No invoice field or usable idempotency contract is documented.
- [Generic message receipt](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/conversations/get-message/): root object with identity, channel, direction, body, status and optional SMS sender/recipient. `messageType` lists `TYPE_SMS` while an example says `SMS`; this implementation accepts only the documented enum spelling. The numeric type alone is not used to infer SMS. Known conflicting numeric call, email, and voicemail values are rejected. The separately observed native-SMS envelope additionally requires numeric type `2`.
- [Individual email receipt](https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/conversations/get-email-by-id/): separate individual `id`, `threadId`, sender, recipient array, subject, body, and status. A thread receipt is not an individual email receipt.

These sources establish serialization, not authorization or live-account correctness. Local bindings, sender validation, runtime account/scope verification and review references must come from separately trusted evidence. Parser success cannot authenticate a forged network response or prove that an injected client honored its arguments.

## Recipient and sender

`parseGhlRecipient({version, body, expected})` requires the exact version, contact wrapper and expected contact/location. The destination is supplied explicitly, must already be canonical, and must exactly match the contact's primary or documented associated destination. It never reformats a telephone number, guesses a country code, lowercases an email, changes local-part case, or switches channels. Email syntax is deliberately conservative: a bare single address with a lowercase domain. Valid addresses outside this subset remain held pending review.

Allowed requires global DND **false** and the selected channel status **inactive**. HighLevel explicitly states that an omitted global `dnd` means false and that this applies consistently across APIs in its [versioned ContactDndUpdate contract](https://marketplace.gohighlevel.com/docs/2021-07-28/webhook/ContactDndUpdate/). Only an absent property receives that documented default; a present null, string or otherwise malformed value holds. No equivalent default is documented for omitted `dndSettings.SMS` or `dndSettings.Email`, so missing channel settings still hold. Active/permanent blocks. Malformed, incompatible lowercase keys, or unknown settings hold. Inbound DND never substitutes for outbound suppression. An SMS block cannot select email automatically. The code does not clear DND or apply transactional-email bypasses. This parser reports suppression evidence, not affirmative consent.

Positive parse results are frozen and recorded privately by identity. A fabricated or copied `{state:'allowed'}` result cannot satisfy request construction. This protects accidental object substitution, not a malicious caller that controls the original evidence. Only the required recipient binding is retained, not the raw contact or unrelated personal data.

Construction also requires a sender review bound to the exact account, location, channel, sender, and `conversations/message.write` scope, with explicit approved/validated flags and an evidence reference. No workflow, default sender, contact owner or provider fallback is inferred. Those flags are trusted input assertions, not proof this module independently obtained. This module does not independently perform real sender validation or obtain applicable authorization; those remain separately trusted inputs.

## Outbound construction only

`buildGhlMessageRequest` holds by default. An explicit `reviewed-construction-only` review can produce a disabled descriptor with `status:"pending"` and no `subType`. A separately authorized single native-SMS test on November 9, 2026 observed HTTP 201 acceptance and a later exact-message delivered receipt for this request form. That observation is narrow: it does not verify Email live semantics, other accounts, retry safety, or general rollout readiness. The builder still requires the explicit review, refuses delivered/read/failed request claims, and never silently omits status.

The descriptor fixes origin, route, method and version. Its allowlisted body contains only the necessary single-contact SMS or email fields. Text or HTML is preserved byte-for-byte; its SHA-256 must match the local binding. Email subject is explicit. There are no attachments, CC/BCC, appointment or invoice substitutions, template defaults, future schedules, replies, or thread reuse. The descriptor has no credential field, Authorization header, callback or network action. The separate transport candidate refuses it without an additional opaque review handle and the original durable-ledger reservation.

The descriptor declares one maximum attempt and no automatic retry. A test-local fake POST boundary checks serialization and uncertain responses; it is **not** a production transport or proof of durable exactly-once behavior. Future dispatch still requires the independently reviewed gate, durable ledger, fresh source/DND checks, final reservation, and an implementation that performs no retries after 429, timeout, 5xx, lost acknowledgment or other uncertainty.

## Acceptance and receipts

`parseGhlAcceptance` binds a validated 200 response, or 201 for SMS only, and its exact IDs to an authentic in-process construction result. Missing/malformed IDs, unknown outcome fields, unsupported statuses, inappropriate multiple IDs or conflicting individual-email IDs stay unknown. Returned queuing text is not delivery evidence. The optional individual email ID is never inferred from the thread ID; without it, acceptance may be recorded but email delivery remains unverified.

`parseGhlMessageReceipt` and `parseGhlEmailReceipt` require a genuine parser-created acceptance result. They bind exposed provider IDs, contact/location/conversation, outbound origin, exact content hash and type, exact sender and destination, and valid creation time. Documented root receipts require `source:"api"`. The native-SMS variant accepts only an outer object whose keys are `message` and nonempty string `traceId`, with a plain inner message object, `source:"app"`, `type:2` and `messageType:"TYPE_SMS"`. Competing root receipt fields, alternative/nested envelopes, arbitrary sources, and Email wrappers hold. Required canonical fields cannot be supplied through aliases. Available known identity aliases and account identity must agree with the original binding. An exposed `dateUpdated` must be a valid timestamp between creation and observation; it is not asserted to be a delivery timestamp. Email additionally binds the individual ID to its separate thread and exact subject/single-recipient audience. Missing optional SMS addresses hold rather than guessing. Display-name email `from` formats currently hold if they do not exactly equal the reviewed bare sender. A content hash or `source:'api'` alone never proves invoice attribution.

Status handling is deliberately channel-specific:

- Pending/scheduled: pending, not delivered.
- Sent: dispatched, not delivered.
- Delivered: provider-recorded delivery only when all identity checks match. It is not proof a person read an SMS or that email reached an inbox.
- Failed/undelivered: failure, with no retry permission.
- SMS opt-out: suppression, not success.
- Email opened/read: engagement signal only, not proof a human read it.
- Connected, unrecognized statuses, and channel-inapplicable statuses: unknown. `clicked` and `opt_out` are absent from the individual-email endpoint's current enum, so that endpoint holds them.

### Narrow native-SMS observation and exact suffix review

The captured GET response was HTTP 200 with root `{message:{...},traceId:string}`. Its inner string fields were `altId`, `body`, `contactId`, `contentType`, `conversationId`, `dateAdded`, `dateUpdated`, `direction`, `from`, `id`, `locationId`, `messageType`, `source`, `status`, and `to`; `type` was number 2 and `attachments` was empty. `contentType:"text/plain"` and valid millisecond UTC creation/update timestamps were **present**. `error`, `meta` and `updatedAt` were absent. There is no missing-content-type or missing-creation-time exception. `altId` is not substituted for the original message ID.

The POST evidence retained HTTP 201 plus string message and conversation IDs, but not the full raw response key inventory. Tests cover the parser's constrained synthetic 201 response shape; they are **not** a replay of a complete captured POST response. Unknown outcome fields, errors and malformed or contradictory IDs remain unknown, non-retryable and never delivery-confirmed. Email 201 remains unsupported.

The real SMS receipt body contained the approved text plus a separately verified exact compliance/sender suffix. The private source evidence, including its original body, stays outside this repository. The provider documents [automatic opt-out and sender-info updates](https://help.gohighlevel.com/support/solutions/articles/155000006771-set-up-automatic-opt-out-and-sender-info-updates-in-messaging-compliance) and its [LC Phone messaging policy](https://help.gohighlevel.com/support/solutions/articles/48001213941-lc-phone-messaging-policy). These support reviewing actual configured behavior, not assuming a universal footer. Settings and timing can change.

Exact body matching is the default. An optional `smsReceiptSuffixPolicy` is separately trusted evidence with mode `reviewed-exact-native-sms-suffix`, version, SMS channel, app source, exact account/location/sender, literal suffix, and evidence reference. The builder validates and snapshots it and precomputes the hash of the original body plus that exact suffix. Only the native-SMS receipt may match that additional full-body hash. Extra/changed/repeated footers, altered original content, mismatched policies, unknown sources and other channels hold. No trimming, prefix acceptance, regular-expression normalization or inferred suffix is used. The policy does not modify outbound content, grant consent, bypass construction/send approval, or authorize retries. A caller must establish the policy from trusted account-specific evidence; a response body cannot authorize its own normalization.

A nonempty error contradicting a positive state produces unknown. Exact raw status/error/message/body evidence is retained in a private WeakMap and available only through `inspectGhlPrivateEvidence` for trusted audit handling. It is absent from normal JSON serialization; callers must never log or publish it. Non-JSON accessors/cycles or otherwise malformed evidence cannot manufacture a successful result.

`reconcileGhlReceipts` is pure, not a polling scheduler. It allows ordered pending → sent → delivered and pending/sent → failure. It holds identity conflicts, incompatible outcomes, status regression, out-of-order observations and any unknown result. A later good response cannot erase a prior identity failure. No reconciliation grants permission to resend. All results keep `invoiceAttributionVerified:false`; linking the message to the immutable invoice remains the durable local ledger's responsibility.

Receipt `dateAdded` is creation time, **not** a status-change timestamp. The code does not invent such a timestamp. Observation order comes from the trusted reader's clock. These parser-created handles are intentionally process-local; restart reconciliation would need a separately reviewed durable evidence-loading contract, which this candidate does not supply.

## GET-only reader

`createGhlReadOnlyReader` accepts an explicitly injected fetch-compatible function, credential, account/location, scopes and clock. There is no ambient fetch or environment-secret import. Named methods are limited to:

- `readContact(expected)` → `GET /contacts/{contactId}`.
- `readMessageReceipt(acceptance)` → `GET /conversations/messages/{messageId}` for SMS.
- `readEmailReceipt(acceptance)` → `GET /conversations/messages/email/{individualId}`.

All calls use the fixed HTTPS origin, version header, validated/encoded ID path, `redirect:'error'`, and an AbortSignal. The reader checks its configured account/location and required scope before calling the injected client. Scopes are caller assertions: obtaining a credential or proving its actual scope/location is outside this module.

Responses must expose streaming reads. They are bounded at 2,000,000 bytes and 8,192 nonempty chunks, use strict UTF-8 decoding, and have a default five-second deadline (explicitly configurable from 1 to 30,000 ms). Oversized, malformed, absent, stalled or inaccessible streams hold. Cancellation is best-effort; abort/deadline is not proof an arbitrary injected client canceled its underlying socket. No exception, credential, raw response or provider error is logged. Each invocation makes at most one GET and has no automatic retry. There is no built-in polling, webhook configuration, or scheduler.

Contact parsing does not establish freshness. The calling source adapter must record independent source/contact observation times and expiry, re-read immediately before any separately authorized future send, and enforce the existing timing and eligibility gate. A successful GET cannot make the source read and future send atomic.

## Verification and remaining gates

Only synthetic fixtures and in-memory fake HTTP/streams are used:

```sh
node --import tsx --test tests/notification-ghl-contract.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Coverage includes SMS-only 201 acceptance, the strict observed SMS envelope, missing and contradictory fields/aliases, exact bound suffix policies and mutated footers, private unmodified body evidence, wrong/missing/forged identity, global/channel DND, wrong versions, associated destination checks, sender/scope drift, exact SMS and email serialization, malformed acceptance, non-retryable unknown responses, distinct email/thread IDs, delayed receipts and conflicts, private raw errors, exact GET requests, denied scope, redirects, byte limits, malformed UTF-8, and hanging reads. No installed software, network request, server, database, migration, credential issuance, account modification, send, activation or deployment is required by these checks.

Before broader real sending, resolve any remaining channel-specific contract questions (Email is live-unverified), verify real sender identity and runtime scope, authorize actual content/audiences/timing, approve the database/schema and uncertain-outcome path, independently review and integrate the separate one-attempt transport candidate at a trusted call site, and authorize the specific live test or rollout. This candidate does not supply or imply any of those approvals.
