# PA Regulatory Simulation — Work State

## Frozen baseline

- Repository: `/Volumes/Crucial X9/Codex/PA-D2F`
- Remote: `https://github.com/D2FCompliant/PA-D2F.git`
- Branch: `feature/pa-sandbox-foundation`
- Baseline tag/version: `v1.0.0` / `1.0.0`
- Final implementation commit: `b64a34f` (`feat(pa-sandbox): complete regulatory simulation lab`)
- Rollback tag/commit: `v0.9.0` / `b0876adc4ccd28c584b1b2c7f175e22d66d47c4e`
- Shared reference commit: `696249b7f53dc7b1f77f0c0ae297e332ae863c88`
- CBM public contract: `2.1.0`

## Active scope

- Phase: Final 1.0.0 implementation complete; Phase 4 committed at `f81e80c`, unified trace/demos/docs committed at `b64a34f`.
- Budget: MEDIUM, split into existing e-reporting validation reuse, simulated transport, targeted tests and checkpoint gates.
- Scenario: `DEMO-FR-PIPELINE-001`.
- New route: `POST /sandbox/v1/scenarios/DEMO-FR-PIPELINE-001/executions`.
- Release 0.9.0 commit: `b0876adc4ccd28c584b1b2c7f175e22d66d47c4e` (tag `v0.9.0`).
- Migration `0003_regulatory_simulation_foundation.sql` applied only to D1 `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- Release metadata: `0.9.0`; rollback remains `v0.8.0` at `c4bce876c0b6240ecddd9b9e8d802792e3ce35bf`.
- Additive read route: `GET /sandbox/v1/transactions/{transactionId}`.
- Phase 3 routes: `POST /sandbox/v1/transactions/{transactionId}/lifecycle-events` and `GET /sandbox/v1/transactions/{transactionId}/lifecycle`.
- Phase 4 routes: `POST /sandbox/v1/transactions/{transactionId}/ppf-submissions` and `GET /sandbox/v1/transactions/{transactionId}/ppf-submissions`.

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
- `REQ-PA-P4-PPF-COLLECTOR`
- `REQ-PA-P4-FLOW-10-1`
- `REQ-PA-P4-FLOW-10-3`
- `REQ-PA-P4-PAYMENT-BOUNDARY`
- `REQ-PA-P4-REAL-VALIDATION`
- `REQ-PA-P4-TECHNICAL-EVENTS`
- `REQ-PA-P4-IDEMPOTENCE-REPLAY`
- `REQ-PA-P4-PPF-API`
- `REQ-PA-P4-SANDBOX-ACTIVATION`
- `REQ-PA-FINAL-UNIFIED-TRACE`
- `REQ-PA-FINAL-DEMO-CATALOG`
- `REQ-PA-FINAL-OPENAPI`
- `REQ-PA-FINAL-UI-BOUNDARY`

## Shared contracts consumed

- Canonical transaction/invoice shape: CBM `2.1.0`.
- Existing PA Canonical Event Envelope: unchanged, not extended by Phase 1.
- Existing PA lifecycle contract: `InvoiceState`, `canTransition`, `lifecycleEventType` and `REGULATORY_CODES`.
- Existing PA e-reporting generator and DGFiP V3.2 XSD / Annex 7 validator for Flux 10.1–10.4.
- Existing `PpfReportingAdapter`, extended additively and implemented only as `SimulatedPpfReportingAdapter` over `sim://`.
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
- `DEC-PA-011`: the PPF Simulator is a regulatory-data collector only; it never routes an invoice and is not a PAR.
- `DEC-PA-012`: only explicit synthetic classifications drive generated 10.1/10.3 scenarios; no Country Runtime is recreated.
- `DEC-PA-013`: 10.2/10.4 generation remains blocked by the shared Payment Contract, while explicitly supplied payloads may use the existing V3.2 validation and simulated transport.
- `DEC-PA-014`: PPF submission metadata, hashes, validation results and technical events fit the existing `0003` JSON storage; raw XML is not persisted and no migration `0004` is needed.

## D1 isolation

- Binding: `DB`.
- Development database: `d2f-pa-sandbox-local`.
- Sandbox database: `d2f-pa-sandbox` (`b082f7af-bf47-4e3a-b24b-956cb0d2a2b2`).
- The binding is declared only in PA-D2F and is not shared with Business Suite, Enterprise Platform or D2F Compliant d.o.o.
- Applied migration: `migrations/0003_regulatory_simulation_foundation.sql`.
- Migration is additive; old 0.6.0 application code ignores the new tables, allowing application rollback.

## Feature flags

- Root/global: `PA_DUAL_NODE_SIMULATION=false`, `DIRECTORY_SIMULATOR=false`, `PPF_SIMULATOR=false`, `LIFECYCLE_SIMULATION=false`, `EXTERNAL_NETWORK_DISABLED=true`.
- Sandbox only: `PA_DUAL_NODE_SIMULATION=true`, `DIRECTORY_SIMULATOR=true`, `PPF_SIMULATOR=true`, `LIFECYCLE_SIMULATION=true`, `EXTERNAL_NETWORK_DISABLED=true`.

## Integration requests

- `PA_INTEGRATION_REQUEST_REGULATORY_RESULT`: OPEN.
- `PA_INTEGRATION_REQUEST_READINESS`: OPEN.
- `PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME`: OPEN.
- `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`: OPEN.
- `PA_INTEGRATION_REQUEST_UI_ACCESS`: OPEN.

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
- Phase 3 deployment: VERIFIED on release 0.9.0 (baseline supplied and validated before Phase 4).
- Phase 4 targeted tests: 35/35 PASS across Phases 1–4; Phase 4 alone: 12/12 PASS.
- Phase 4 full PA suite: 61/61 PASS.
- Phase 4 TypeScript build: PASS.
- Phase 4 Wrangler types: regenerated with Node 22; `types:check` PASS.
- Phase 4 Cloudflare dry-run: NOT PERFORMED; execution environment rejected possible private bundle egress and no deployment/egress was authorized for this checkpoint.
- Phase 4 migration: NONE; existing `0003` tables only.
- Phase 4 deployment: NOT PERFORMED.
- Final targeted tests: 49/49 PASS.
- Final full PA suite: 76/76 PASS.
- Final TypeScript build: PASS.
- Final Wrangler types check: PASS.
- Final Cloudflare sandbox dry-run: PASS for `d2f-pa-sandbox`, with `PPF_SIMULATOR=true`, all other sandbox simulators enabled and `EXTERNAL_NETWORK_DISABLED=true`.
- Final `git diff --check`: PASS.
- Final migration: NONE; existing `0003` tables only.

## Next exact action

No sandbox implementation remains. Maintain the four shared-contract requests plus UI access request, and consume them additively when public contracts become available; real AIFE/PPF/PA interoperability remains outside this isolated sandbox.
