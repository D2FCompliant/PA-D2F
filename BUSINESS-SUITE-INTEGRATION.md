# Business Suite integration

Compatibility endpoints:

- `GET /health`
- `POST /invoices` with raw XML
- `GET /invoices/{id}`

Authentication supports `Authorization: Bearer …` and an API key whose header defaults to `x-api-key`. Accepted submissions return `id`, `remote_id` and `status`. If the legacy client omits `Idempotency-Key`, the payload SHA-256 becomes a deterministic compatibility key.
