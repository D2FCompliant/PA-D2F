# Enterprise Platform integration

The adapter preserves CBM `d2f.cbm.v2` version `2.1.0`. `POST /api/v1/transactions` requires `X-D2F-Connection-Id` and a 16–200 character `Idempotency-Key`. Tenant and legal-entity context come from authenticated headers/context, not the submitted business payload.

Sandbox events use the current D2F canonical event-envelope fields. No `d2f.cbm.v3` has been introduced.
