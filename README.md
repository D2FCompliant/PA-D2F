# D2F PA Sandbox

Independent French e-invoicing and Peppol simulation product for D2F Business Suite, D2F Enterprise Platform and third-party integrations.

> **SANDBOX / TEST ONLY — this application is not an accredited Plateforme Agréée and must never be represented as one.**

## Implemented foundation (0.1.0)

- Independent Cloudflare Worker and D1 schema.
- External network access disabled by default.
- D2F Business Suite compatibility: `GET /health`, raw XML `POST /invoices`, `GET /invoices/{id}`, Bearer and configurable API-key authentication.
- Enterprise Platform compatibility foundation: CBM `2.1.0`, `X-D2F-Connection-Id`, mandatory idempotency for canonical submissions, immutable canonical events and tenant scoping.
- Lifecycle state machine including French status `212` for collection/payment simulation.
- Hash-chained test evidence.
- Permanent sandbox warning in UI and response headers.
- Structured validation errors without claiming unimplemented formal conformance.

The verified gaps and incremental delivery plan are in [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md).

## Node 22

All commands must run under Node 22:

```bash
node --version
npm ci
npm run check
```

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and replace every placeholder with a sandbox-only secret beginning with `d2f_sbx_`.
2. Apply the local D1 migration: `npx wrangler d1 migrations apply d2f-pa-sandbox-local --local`.
3. Start the Worker: `npm run dev`.

Never put production credentials or customer invoices in this sandbox.
