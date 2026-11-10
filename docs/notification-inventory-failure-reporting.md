# Inventory failure reporting

Local-only diagnostic change against commit `721ac5e1d396fa216e07054571c3aab924f91f81`, tree `8187d3426ad53b9983153af1cdaad56d881e423a`. No source-audit transport, query, request options, pacing, retries, limits, coverage, source authorization or activation change.

## Output contract

- An incomplete inventory still has `coverage: partial-held`, the existing fixed hold, no rows, no published invoice count, and no terminal-page claim. It now has optional `failure: { code, facts }` metadata.
- The read-only coordinator carries the same safe metadata in `inventory.failure` and stops before population, planning or per-invoice reads. Attempts and reservations remain zero; send capability and rollout readiness remain false.
- The existing token/preflight checks remain outside the inventory pagination catch. They still throw before a provider query. The coordinator retains its existing held / `not_read` outcome and fixed hold while adding sanitized failure metadata for that inventory-call failure.
- Successful and disabled reports omit `failure`; no source/planner/activation decision depends on the diagnostic code or facts.

`notificationInventoryFailure` accepts only native Errors with an own data `name` of `AuditFailure`, an explicitly allowlisted code, and an own non-array, non-proxy facts object. It deliberately does not use constructor identity: the same source loaded through ESM and CJS can create distinct `AuditFailure` constructors. This structural diagnostic recognition is not an authentication or capability boundary.

Only own data facts named `pages`, `invoices`, `bytes`, `httpStatus`, `expiryRemainingMinutes`, `requiredMinutes`, and `graphqlErrorCount` survive, and only when their value is a finite number or boolean. The copied result is frozen. Unknown codes, arbitrary errors, malformed error fields and unrecognized shapes produce `INVENTORY_UNEXPECTED_FAILURE` with empty facts. Error messages, stacks, causes, IDs, headers, response bodies, string facts, accessors and arbitrary keys are not read or copied.

The fixed local checks are labeled `INVENTORY_SCOPE_OR_DEADLINE` and `INVENTORY_ACCOUNT_CHANGED`; their conditions and hold behavior are unchanged. `pages` in the snapshot remains the existing count of returned queries, not necessarily validated pages. A failure's allowlisted `facts.pages` can instead be the paginator's validated-page count. Neither count publishes partial invoices.

`SOURCE_RETRIES_EXHAUSTED` alone does not distinguish HTTP 429, HTTP 5xx or GraphQL throttling. The original transport's code is retained without inferring a provider cause or adding a response observer. This patch does not establish the cause of a prior production hold.

## Local verification

All fixtures, credentials, HTTP responses and invoice identities are synthetic. The regression suite loads the unchanged real transport through a separate tsx CJS graph, proves that its errors fail the other graph's `instanceof AuditFailure`, and checks safe metadata after a successful first page followed by failure. Cases include authorization, HTTP 400/429/503, GraphQL errors/throttling, invalid JSON and network failure. Partial rows remain unavailable, with one attempt per request and no retries. The coordinator also rejects downstream reads after a held inventory.

Other tests cover all allowlisted codes, getters/proxies/inherited fields, nonfinite or string facts, unknown errors, frozen copies, pagination failures, account/location/deadline drift, token startup failure, successful output omission and the 12,500-record ceiling. Run:

```sh
node --import tsx --test tests/notification-inventory.test.ts tests/notification-inventory-failure.test.mjs tests/notification-recurring-coordinator.test.ts
node --import tsx --test --test-concurrency=1 tests/*.test.ts tests/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js lib/notification-inventory.ts lib/notification-recurring-coordinator.ts tests/notification-inventory.test.ts tests/notification-inventory-failure.test.mjs tests/notification-recurring-coordinator.test.ts --no-eslintrc --config node_modules/eslint-config-next/core-web-vitals.js
git diff --check
```

No provider call, real customer-data inspection, credential retrieval, database operation, npm install, production build, publication or deployment is part of this local validation. The local runtime is Node 24.22.1; synthetic mixed-loader coverage is not a production Node 22 test.

Validated results: 166/166 focused tests, 1,539/1,539 full repository tests, TypeScript, targeted ESLint and diff whitespace checks passed. An independent read-only review found no blocking issue and reran the 41/41 new failure-reporting tests successfully.
