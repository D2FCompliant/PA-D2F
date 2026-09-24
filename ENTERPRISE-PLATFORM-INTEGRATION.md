# Enterprise Platform integration

The adapter preserves CBM `d2f.cbm.v2` version `2.1.0`. `POST /api/v1/transactions` requires `X-D2F-Connection-Id` and a 16–200 character `Idempotency-Key`. Tenant and legal-entity context come from authenticated headers/context, not the submitted business payload.

Sandbox events use the current D2F canonical event-envelope fields. No `d2f.cbm.v3` has been introduced.

Platform owns the routing orchestration. It calls `POST /sandbox/v1/directory/resolve` for the D2F PA Sandbox, receives the PA-owned BT-49 plus directory evidence, enriches the canonical transaction, then submits the generated structured invoice. `GET /sandbox/v1/invoices/{transactionId}/lifecycle`, `/sandbox/v1/operations` and `/sandbox/v1/traces/{transactionId}` expose respectively the consumable lifecycle, the operations dashboard and immutable technical evidence.

The same Platform contract can be adapted to an accredited PA endpoint later. Business Suite must not access the sandbox directory database directly.
