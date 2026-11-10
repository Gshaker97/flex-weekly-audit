# Disabled configured-SMS-sender read adapter

`lib/notification-sender.ts` is an unwired reader, tested only with synthetic credentials, numbers and in-memory HTTP streams. This change adds no call site, provider/account read, connection, send, scheduler, database/schema change, activation or deployment. Its factory is inert. Supplying a real client and calling `read` would perform one real GET and requires separately authorized use.

## Contract and evidence provenance

The [official List active numbers documentation](https://marketplace.gohighlevel.com/docs/ghl/phone-system/active-numbers/) was checked on November 9, 2026. It specifies `GET /phone-system/numbers/location/{locationId}`, `Version: v3`, a sub-account credential with `phonenumbers.read`, and a success envelope containing `status`, `statusCode`, `message`, and `data`. The payload documents number identity, capabilities, default selection, account status, pagination and optional total. This is not the message-send API version or write scope.

A separately authorized prior read supplied this **sanitized projection**, not a complete retained response:

```json
{
  "data": {
    "numbers": [{
      "phoneNumber": "[redacted E.164 number]",
      "isDefaultNumber": true,
      "capabilities": { "fax": false, "mms": true, "sms": true, "voice": true }
    }],
    "page": 0,
    "pageSize": 100,
    "accountStatus": "active",
    "isUnderLc": true
  }
}
```

That read used `page=0&pageSize=100&skipNumberPool=false`. The captured projection explicitly lacked own properties `data.total`, `data.locationId`, and the number's `locationId`. It did not capture a complete/has-more/next-page flag, A2P fields, or the success-envelope fields. Uninspected fields remain unknown. The parser requires the **documented** success envelope; the projection alone does not establish that the prior read met every new parser requirement. Tests use a synthetic envelope from the documentation and a synthetic number in the observed field layout. No real credential, full number, account ID or response is in these files.

## Narrow API and trust boundary

`createNotificationSenderReader(options)` accepts an explicit GET-only fetch-compatible function, credential, account/location, read scopes and clock. The client must expose a response URL, redirected flag and byte stream. There is no global fetch, environment-secret lookup, account discovery, credential creation, or automatic retry.

`reader.read({ accountId, locationId, expectedNumber })` checks the exact local bindings and required read scope before IO. It uses only the fixed HTTPS origin and route with `page=0&pageSize=100&skipNumberPool=false`. No number search filter, excluded pool fallback, alternate endpoint, follow-up page, or implicit sender is used. The caller's credential/account/location/scope association must be independently verified. Strings and TypeScript types cannot authenticate that association or an injected client. This adapter does not acquire or attest the credential's actual permissions.

Only the exact canonical E.164 `phoneNumber` supplied by the caller can match. The reader never normalizes a returned number or selects by default status, owner, friendly name, forwarding number, or a legacy alias. Missing, malformed or duplicate matching rows hold. Malformed unrelated number identities also hold because they might conceal another match. A non-default number can produce a fact when it exactly matches the explicit expected number. The exact match requires boolean `capabilities.sms === true` and `data.accountStatus === 'active'`. A different spelling, missing value, string boolean or suspended account holds.

`isUnderLc`, default status and non-SMS capabilities are retained only as booleans when present; absence becomes `null`, never false or an assumed value. Optional location echoes, if supplied, must match. The account remains explicitly caller-bound and location explicitly request-path-bound, even if response echoes happen to be present. Missing total stays `null`. A supplied total must be a safe integer at least as large as the observed row count. It does not trigger pagination or grant completeness.

The fact says exactly one matching entry was observed **in this page**. `inventoryComplete: null` and `globalUniquenessVerified: false` remain unchanged even when a total is supplied. Missing pagination metadata does not become a claim of globally unique inventory. The adapter cannot rule out conflicting entries on unobserved pages. Any consumer that requires global uniqueness or a complete inventory must hold until independently reviewed evidence establishes it.

## Handles, freshness and non-permissions

A successful read returns a frozen, process-local opaque handle. Ordinary result serialization includes neither the number nor credentials. `inspectNotificationSender(handle)` is a private trusted inspection seam which returns the immutable facts, including the exact number, only for an original fresh handle. Never log or publish this inspection result. Copies, JSON-reconstructed handles, expiry, invalid clocks and backward clock movement cannot reissue a fact.

Observation time is captured **before** the actual GET, with expiry exactly 60 seconds later. Slow reads cannot refresh that start time. A read finishing at or after expiry holds. Inspection uses the original injected clock and does not extend validity; an invalidated handle cannot revive if the clock later moves backward. These timestamps still depend on a trusted running clock. A retained inspection object is a snapshot, not proof it is still current: consumers must inspect the original handle again at their decision boundary.

The facts do not authorize use of the number or prove message-write scope. They explicitly retain `senderApproved: false`, `writeScopeVerified: false`, `a2pRegistration: null`, `deliveryVerified: false`, `consentVerified: false`, and `productionSendCapability: false`. Read scope, account active status, default selection, SMS capability and LC management are not evidence of A2P registration, recipient consent, send acceptance or delivery. No sender-review or transport authorization handle is minted. Caller approval, message-write scope, content/audience/timing review, recipient suppression, ledger protection and any future integration remain independent gates.

## Bounded IO and failure behavior

Each invocation performs at most one GET. Request redirects are disabled and any followed redirect or changed final response URL holds. Only HTTP 200 is parsed. Responses are bounded at 1,000,000 bytes, 2,048 nonempty byte chunks and 100 rows. Decoding is strict UTF-8, including across chunk boundaries. Invalid JSON, malformed streams and absent bodies hold. The default deadline is five seconds, configurable only from 1 to 30,000 ms. It bounds waiting for both headers and the body, including clients that ignore abort. Cancellation is best effort and does not prove an arbitrary client closed its underlying socket. There is no retry after failure, timeout, redirect, 429 or 5xx; a late completion cannot mint a fact after the deadline result.

Errors and result reasons contain no credential, raw response, provider message or number. Only minimal typed facts are retained in a private WeakMap. This module has no logger or raw-response inspection API.

## Local verification

```sh
node --import tsx --test tests/notification-sender.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

Tests cover exact serialization, inert construction, scope/binding rejection, configuration snapshots, absent fields, number aliases/default fallback, duplicate and malformed rows, capability/account failures, optional echoes/totals, forged handles, expiry/backward clocks, redirects and HTTP failures, byte/chunk bounds, UTF-8, malformed streams, hanging fetch/body/cancellation and no late issuance or retry. All IO is fake. No production readiness or live-provider test is claimed.
