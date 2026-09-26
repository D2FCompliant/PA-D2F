# D2F PA Sandbox

Independent French e-invoicing and Peppol simulation product for D2F Business Suite, D2F Enterprise Platform and third-party integrations.

> **SANDBOX / TEST ONLY — this application is not an accredited Plateforme Agréée and must never be represented as one.**

## Implemented sandbox (0.9.0)

- Independent Cloudflare Worker and D1 schema.
- External network access disabled by default.
- D2F Business Suite compatibility: `GET /health`, raw XML `POST /invoices`, `GET /invoices/{id}`, Bearer and configurable API-key authentication.
- Enterprise Platform compatibility foundation: CBM `2.1.0`, `X-D2F-Connection-Id`, mandatory idempotency for canonical submissions, immutable canonical events and tenant scoping.
- Lifecycle state machine including French supplier delivery and buyer-decision statuses `202`, `203`, `205`, `207`, `208`, `210`, plus `212` for collection/payment simulation.
- Hash-chained test evidence.
- Permanent sandbox warning in UI and response headers.
- The legacy compatibility route remains structural-only and does not overstate its validation scope.
- `POST /sandbox/v1/validate/flux1` runs the committed DGFiP Flux 1 XSD, EN 16931 rules and FNFE France Schematron, then returns every failed rule with its severity and path.
- Flux 1 extraction exposes the core business terms used by the simulator, including BT-49, totals and parties.
- PPF behavior is simulated locally and never calls an external production network or invents a missing BT-49.
- `POST /sandbox/v1/validate/ereporting` classifies Flux 10.1, 10.2, 10.3 and 10.4, runs the official DGFiP v3.2 XSD graph and returns traceable Annex 7 rule failures.
- `PUT /sandbox/v1/directory/entries` and `POST /sandbox/v1/directory/resolve` expose the synthetic, tenant-and-company-scoped directory used by Platform tests at SIREN or SIRET grain.
- `POST /sandbox/v1/validate/annuaire/{flow}` validates Annuaire Flux 12, 13 and 14 against the official v3.2 XSD graph.
- The API explicitly reports `NOT_APPLICABLE` for Flux 10/Annuaire Schematron because the official DGFiP v3.2 archive does not publish those Schematron artefacts. Invoice Flux 1 continues to execute the official EN 16931 and FNFE France Schematrons.

The verified gaps and incremental delivery plan are in [docs/GAP-ANALYSIS.md](docs/GAP-ANALYSIS.md).

## Phase 2 regulatory simulation

The additive route `POST /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions` runs an isolated synthetic PAE → simulated directory → PAR → buyer-delivery pipeline. The connection-scoped `GET /sandbox/v1/transactions/{transactionId}` route exposes its sanitized persisted trace. The pipeline uses the shared canonical transaction shape and explicitly returns `SIMULATION_BOUNDARY` where a public shared regulatory contract is not yet available.

The route remains disabled in root/default configuration and is enabled only in `env.sandbox` through `PA_DUAL_NODE_SIMULATION=true` and `DIRECTORY_SIMULATOR=true`. `PPF_SIMULATOR` remains `false`. `EXTERNAL_NETWORK_DISABLED=true` is mandatory; the Phase 2 adapters accept only `sim://` targets.

Only synthetic tenants `D2F-PAE-SIM` and `D2F-PAR-SIM` are used. A Business tenant header never becomes a data-access key for this scenario, and the real D2F Compliant d.o.o. profile is neither read nor modified.

## Phase 3 lifecycle simulation

In `env.sandbox`, `LIFECYCLE_SIMULATION=true` extends the pipeline with technical lifecycle events propagated from the simulated buyer through PAR to PAE. The root/default value remains `false`. The additive lifecycle routes preserve connection isolation, idempotency and technical evidence provenance without claiming AIFE interoperability.

Status 212 remains outside Phase 3 execution and returns `SIMULATION_BOUNDARY` while `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT` is open. A blocked 212 creates no successful lifecycle event or execution run.

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
