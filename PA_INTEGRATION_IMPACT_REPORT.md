# PA Integration Impact Report — Phase 1 checkpoint

## Scope

Add an off-by-default technical foundation for `DEMO-FR-PIPELINE-001`, without implementing Phase 2 regulatory behavior and without applying D1 migration or deploying.

## Files touched

- Runtime: `src/index.ts`, `src/simulation/*.ts`.
- Proposed PA-only schema: `migrations/0003_regulatory_simulation_foundation.sql`.
- Configuration/types: `wrangler.jsonc`, `worker-configuration.d.ts`.
- Tests: `tests/simulation-phase1.test.ts`.
- Documentation: `README.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `docs/codex/WORK_STATE.md`, `docs/regulatory/france/PA_REQUIREMENTS_MATRIX.md`, this report.

No file in CBM, Country Packs, Business Suite, Enterprise Platform or any connector repository is touched.

## Contracts

- Consumed unchanged: CBM canonical transaction/invoice `2.1.0`.
- Existing Canonical Event Envelope: unchanged and not forked.
- Not locally defined: Regulatory Result, readiness, Country Runtime, Payment Contract.
- Open boundaries: `PA_INTEGRATION_REQUEST_REGULATORY_RESULT`, `PA_INTEGRATION_REQUEST_READINESS`, `PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME`, `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`.

## API and flags

- Additive route: `POST /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions`.
- Default-off flags: `PA_DUAL_NODE_SIMULATION`, `DIRECTORY_SIMULATOR`, `PPF_SIMULATOR`, `LIFECYCLE_SIMULATION`.
- Safety invariant: `EXTERNAL_NETWORK_DISABLED=true`; only `sim://` adapter targets are accepted.

## D1 impact

- Binding: `DB` in PA-D2F only.
- Databases: local `d2f-pa-sandbox-local`; sandbox `d2f-pa-sandbox`.
- Proposed operations: three `CREATE TABLE` and two `CREATE INDEX` statements.
- Existing tables are not altered. There is no `DROP`, `TRUNCATE`, reset, seed or Business data access.
- The migration has not been applied.

## Risks and controls

- Concurrent duplicate submissions: existing D1 idempotency primary key remains the authoritative duplicate guard; the route returns an idempotent response for completed retries.
- Contract drift: blocked shared contracts stay explicit; no regulatory rule is copied.
- Tenant leakage: scenario storage is connection-scoped and its logical tenants are fixed synthetic identifiers.
- Network escape: adapter guard rejects external URLs before any transport.
- Existing behavior: all flags off leaves the Phase 1 route inaccessible and preserves 0.6.0 endpoints.

## Checkpoint validation

- Phase 1 targeted tests: 7/7 passed.
- TypeScript build and Wrangler types check: passed.
- Wrangler sandbox dry-run: passed, with all four new flags `false` and external network disabled.
- Full suite: 33/33 passed. The two e-reporting generation tests use a fixed UTC system clock; production generation remains unchanged. G7.43 is covered by an explicit valid timestamp and an explicit future rejection.

## Rollback

Application rollback to v0.6.0 is compatible because v0.6.0 does not read the proposed additive tables. Before migration application, rollback is simply removal of the Phase 1 code/config diff. No production rollback action is currently required because nothing has been deployed.
