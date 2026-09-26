# PA Regulatory Simulation — Work State

## Frozen baseline

- Repository: `/Volumes/Crucial X9/Codex/PA-D2F`
- Remote: `https://github.com/D2FCompliant/PA-D2F.git`
- Branch: `feature/pa-sandbox-foundation`
- Baseline tag/version: `v0.6.0` / `0.6.0`
- Baseline commit: `073acf6286bf7ce760f7b09301949ff9f1cf052a`
- Shared reference commit: `696249b7f53dc7b1f77f0c0ae297e332ae863c88`
- CBM public contract: `2.1.0`

## Active scope

- Phase: Phase 1 release 0.7.0 checkpoint; implementation and D1 sandbox migration complete, deployment pending gates.
- Budget: MEDIUM, split into foundation, targeted tests, checkpoint gates.
- Scenario: `DEMO-FR-PIPELINE-001`.
- New route: `POST /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions`.
- Phase 1 commit: `b2dda627aa8911e8e175d39b770dec5ac33c0933` (pushed to `origin/feature/pa-sandbox-foundation`).
- Migration `0003_regulatory_simulation_foundation.sql` applied only to D1 `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- Release metadata target: `0.7.0`; deployment not yet performed.

## Requirements

- `REQ-PA-ARCH-DUAL-NODE`
- `REQ-PA-ARCH-ADAPTERS`
- `REQ-PA-TRACE-IDS`
- `REQ-PA-IDEMPOTENCE`
- `REQ-PA-PROVENANCE`
- `REQ-PA-NETWORK-BLOCK`
- `REQ-PA-FEATURE-FLAGS`
- `REQ-PA-TENANT-ISOLATION`
- `REQ-PA-BUSINESS-PROFILE-PROTECTION`
- `REQ-PA-DEMO-FR-PIPELINE-001`

## Shared contracts consumed

- Canonical transaction/invoice shape: CBM `2.1.0`.
- Existing PA Canonical Event Envelope: unchanged, not extended by Phase 1.
- Integration Hub reference: commit `696249b7f53dc7b1f77f0c0ae297e332ae863c88`.

## Protected files and systems

- All files outside `/Volumes/Crucial X9/Codex/PA-D2F`.
- Entire shared CBM/Country Packs/Business Suite/Enterprise Platform repository.
- Country Pack runtimes, connector implementations and shared regulatory artefacts.
- D2F Compliant d.o.o. Business data, tenant, users, permissions, connections and `RS_SEF` configuration.

## Decisions

- `DEC-PA-001`: PAE and PAR are logical nodes sharing one runtime.
- `DEC-PA-002`: Business tenant input is mapped to isolated `D2F-PAE-SIM`, never used for Business data access.
- `DEC-PA-003`: adapter targets must be `sim://`; external targets fail with `EXTERNAL_NETWORK_BLOCKED` before transport.
- `DEC-PA-004`: unavailable public contracts return `SIMULATION_BOUNDARY`; no local definitive contract is invented.
- `DEC-PA-005`: all new feature flags default to false and 0.6.0 routes remain unchanged.

## D1 isolation

- Binding: `DB`.
- Development database: `d2f-pa-sandbox-local`.
- Sandbox database: `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- The binding is declared only in PA-D2F and is not shared with Business Suite, Enterprise Platform or D2F Compliant d.o.o.
- Applied migration: `migrations/0003_regulatory_simulation_foundation.sql`.
- Migration is additive; old 0.6.0 application code ignores the new tables, allowing application rollback.

## Feature flags

- `PA_DUAL_NODE_SIMULATION=false`
- `DIRECTORY_SIMULATOR=false`
- `PPF_SIMULATOR=false`
- `LIFECYCLE_SIMULATION=false`
- `EXTERNAL_NETWORK_DISABLED=true`

## Integration requests

- `PA_INTEGRATION_REQUEST_REGULATORY_RESULT`: OPEN.
- `PA_INTEGRATION_REQUEST_READINESS`: OPEN.
- `PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME`: OPEN.
- `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`: OPEN.

## Tests and gates

- Phase 1 targeted tests: 7/7 PASS.
- Wrangler types: generated with Node 22.
- TypeScript build: PASS.
- Wrangler types check: PASS.
- Wrangler sandbox dry-run: PASS; no publication performed.
- Full PA suite: 33/33 PASS. The two time-dependent e-reporting tests now freeze the test runtime at `2026-09-26T10:00:00Z` and validate at `2026-09-26T12:00:00Z`; production continues to use the real server time.
- G7.43 invariant: a report timestamp at 09:00Z passes against a 12:00Z clock, while 13:00Z is rejected with `F10-G7.43-FUTURE`.
- Migration: APPLIED to PA Sandbox D1 only; schema verification PASS.
- Deployment: NOT PERFORMED.

## Next exact action

Run the 0.7.0 gates, create the release commit and tag, deploy only the PA Sandbox Worker, then run the prescribed smoke tests. Do not start Phase 2.
