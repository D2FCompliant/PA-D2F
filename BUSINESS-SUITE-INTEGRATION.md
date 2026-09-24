# Business Suite integration

Compatibility endpoints:

- `GET /health`
- `POST /invoices` with raw XML
- `GET /invoices/{id}`
- `POST /sandbox/v1/directory/resolve` for PA-owned BT-49 resolution
- `GET /sandbox/v1/invoices/{transactionId}/lifecycle` for the complete, immutable status history

Authentication supports `Authorization: Bearer …` and an API key whose header defaults to `x-api-key`. Accepted submissions return `id`, `remote_id` and `status`. If the legacy client omits `Idempotency-Key`, the payload SHA-256 becomes a deterministic compatibility key.

Gestion must not derive BT-49 from SIREN/SIRET. It asks the selected PA to resolve the recipient, writes the returned address into the structured invoice, submits it, then consumes the validation report, transaction/correlation identifiers and lifecycle events exposed by this contract.
