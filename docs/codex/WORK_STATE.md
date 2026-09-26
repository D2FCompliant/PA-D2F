# PA Regulatory Simulation — Work State

## Frozen baseline

- Repository: `/Volumes/Crucial X9/Codex/PA-D2F`
- Remote: `https://github.com/D2FCompliant/PA-D2F.git`
- Branch: `feature/pa-sandbox-foundation`
- Baseline tag/version: `v0.8.0` / `0.8.0`
- Baseline commit: `c4bce876c0b6240ecddd9b9e8d802792e3ce35bf`
- Shared reference commit: `696249b7f53dc7b1f77f0c0ae297e332ae863c88`
- CBM public contract: `2.1.0`

## Active scope

- Phase: Phase 3 Lifecycle Simulator implementation checkpoint; no release, migration or deployment authorized.
- Budget: MEDIUM, split into lifecycle contract reuse, targeted tests and checkpoint gates.
- Scenario: `DEMO-FR-PIPELINE-001`.
- New route: `POST /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions`.
- Release 0.8.0 commit: `c4bce876c0b6240ecddd9b9e8d802792e3ce35bf` (tag `v0.8.0`, pushed and deployed).
- Migration `0003_regulatory_simulation_foundation.sql` applied only to D1 `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- Release 0.8.0 deployment ID: `6f642c93-eb7f-4881-a02c-7a591be55bab`; rollback remains `v0.7.0` at `ff2cd75efe1cc9adacb00ed3469eacef22524fbe`.
- Additive read route: `GET /sandbox/v1/transactions/{transactionId}`.
- Phase 3 routes: `POST /sandbox/v1/transactions/{transactionId}/lifecycle-events` and `GET /sandbox/v1/transactions/{transactionId}/lifecycle`.

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
- `REQ-PA-P2-DIRECTORY-OUTCOMES`
- `REQ-PA-P2-PERSISTED-MESSAGES`
- `REQ-PA-P2-VALIDATION-BOUNDARIES`
- `REQ-PA-P2-REPLAY-RESUME`
- `REQ-PA-P2-NEGATIVE-SCENARIOS`
- `REQ-PA-P2-BUYER-SIMULATOR`
- `REQ-PA-P2-TRACE-API`
- `REQ-PA-P2-OPENAPI-CANDIDATE`
- `REQ-PA-P2-SANDBOX-ACTIVATION`
- `REQ-PA-P3-LIFECYCLE-CONTRACT`
- `REQ-PA-P3-LIFECYCLE-TRACE`
- `REQ-PA-P3-LIFECYCLE-REPLAY`
- `REQ-PA-P3-LIFECYCLE-NEGATIVE`
- `REQ-PA-P3-LIFECYCLE-API`
- `REQ-PA-P3-PAYMENT-BOUNDARY`
- `REQ-PA-P3-SANDBOX-ACTIVATION`

## Shared contracts consumed

- Canonical transaction/invoice shape: CBM `2.1.0`.
- Existing PA Canonical Event Envelope: unchanged, not extended by Phase 1.
- Existing PA lifecycle contract: `InvoiceState`, `canTransition`, `lifecycleEventType` and `REGULATORY_CODES`.
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
- `DEC-PA-005`: root/global feature defaults remain false; Phase 2 enables dual-node and directory simulation only in the explicit `sandbox` environment.
- `DEC-PA-006`: migration `0003` already stores all Phase 2 state; full message envelopes use the existing JSON payload column, so no migration `0004` is required.
- `DEC-PA-007`: retries add an `executionRunId` and preserve the existing transaction/correlation IDs.
- `DEC-PA-008`: Phase 3 delegates transition legality to the existing lifecycle contract; it does not define a second state machine.
- `DEC-PA-009`: documented supplier availability (203) and buyer-decision (205/207/208/210) status families define the temporary simulator actor policy.
- `DEC-PA-010`: Phase 3 persists lifecycle events as versioned JSON envelopes in the existing `0003` run/message tables; no migration `0004` is needed.

## D1 isolation

- Binding: `DB`.
- Development database: `d2f-pa-sandbox-local`.
- Sandbox database: `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- The binding is declared only in PA-D2F and is not shared with Business Suite, Enterprise Platform or D2F Compliant d.o.o.
- Applied migration: `migrations/0003_regulatory_simulation_foundation.sql`.
- Migration is additive; old 0.6.0 application code ignores the new tables, allowing application rollback.

## Feature flags

- Root/global: `PA_DUAL_NODE_SIMULATION=false`, `DIRECTORY_SIMULATOR=false`.
- Sandbox only: `PA_DUAL_NODE_SIMULATION=true`, `DIRECTORY_SIMULATOR=true`, `LIFECYCLE_SIMULATION=true`.
- `PPF_SIMULATOR=false`
- Root/global: `LIFECYCLE_SIMULATION=false`
- `EXTERNAL_NETWORK_DISABLED=true`

## Integration requests

- `PA_INTEGRATION_REQUEST_REGULATORY_RESULT`: OPEN.
- `PA_INTEGRATION_REQUEST_READINESS`: OPEN.
- `PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME`: OPEN.
- `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`: OPEN.

## Tests and gates

- Phase 1 and Phase 2 targeted tests: 15/15 PASS.
- Phase 1–3 targeted tests: 23/23 PASS.
- Wrangler types: generated with Node 22.
- TypeScript build: PASS.
- Wrangler types check: PASS.
- Wrangler sandbox dry-run: PASS with dual-node/directory enabled only in `env.sandbox`; no publication performed.
- Full PA suite: 49/49 PASS. The two time-dependent e-reporting tests freeze the test runtime at `2026-09-26T10:00:00Z` and validate at `2026-09-26T12:00:00Z`; production continues to use the real server time.
- G7.43 invariant: a report timestamp at 09:00Z passes against a 12:00Z clock, while 13:00Z is rejected with `F10-G7.43-FUTURE`.
- Migration: APPLIED to PA Sandbox D1 only; schema verification PASS.
- Phase 2 migration: NONE.
- Local-only D1 emulator was initialized through existing migrations `0001`–`0003`; no remote migration was applied.
- Phase 2 deployment: VERIFIED on release 0.8.0.
- Phase 3 migration: NONE.
- Phase 3 deployment: NOT PERFORMED.

## Next exact action

Await explicit validation of the Phase 3 checkpoint before any commit, release or deployment. Do not start Phase 4.
