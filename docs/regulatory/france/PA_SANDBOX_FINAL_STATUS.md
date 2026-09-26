# D2F Regulatory Simulation — Final Status

## Implemented

One isolated PA runtime with logical PAE/PAR nodes, synthetic tenants, Directory and Buyer simulators, lifecycle, e-reporting, PPF collection, replay, idempotency, unified trace and technical evidence reports.

## Simulated

Directory resolution, PA-to-PA transport, buyer delivery, lifecycle propagation and PPF regulatory-data collection use deterministic `sim://` adapters. They do not prove real AIFE, PPF or remote-PA interoperability.

## Real validation

- CBM-compatible canonical transaction validation (`2.1.0`).
- Flux 1 XSD, EN16931 and FNFE France Schematron.
- DGFiP external specifications V3.2 Flux 10 XSD.
- Annex 7 executable management rules already present in PA-D2F.
- Annuaire Flux 12/13/14 V3.2 XSD.

Flux 10/Annuaire Schematron is reported `NOT_APPLICABLE` when the frozen V3.2 source archive does not contain such an artefact.

## Blocked dependencies

- `PA_INTEGRATION_REQUEST_REGULATORY_RESULT`
- `PA_INTEGRATION_REQUEST_READINESS`
- `PA_INTEGRATION_REQUEST_COUNTRY_RUNTIME`
- `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`
- `PA_INTEGRATION_REQUEST_UI_ACCESS`

Status 212 and automatic payment-derived 10.2/10.4 generation remain `SIMULATION_BOUNDARY` until the public Payment Contract exists.

## Regulatory baseline

DGFiP external specifications V3.2 dated 2026-04-30, CBM public 2.1.0 and the versioned artefacts recorded in the repository regulatory matrix.

## APIs

- Scenario list and execution under `/sandbox/v1/scenarios`.
- Connection-isolated transaction, lifecycle and PPF views.
- Unified `/sandbox/v1/transactions/{transactionId}/trace`.
- Generated `/sandbox/v1/transactions/{transactionId}/evidence-report`.
- Existing Flux 1, Flux 10 and Annuaire validation routes.

## Scenarios

`DEMO-FR-001`–`DEMO-FR-010` plus synthetic `MATIC-DEMO`; see repository `SCENARIOS.md`.

## Evidence

Every unified trace event contains transaction/correlation/execution identifiers, derived message ID, actor, provenance, UTC timestamp, payload hash, result category and evidence reference. Reports state:

- `SIMULATION ENVIRONMENT`
- `NOT AN AIFE/PPF INTEROPERABILITY TEST`
- `REAL REGULATORY VALIDATION WHEN IDENTIFIED`
- `SIMULATED EXTERNAL INTEROPERABILITY`

## Security

No raw document or secret is returned by trace/report APIs. Data is connection-scoped and all fixtures are synthetic.

## Network isolation

`EXTERNAL_NETWORK_DISABLED=true`. Simulated adapters reject non-`sim://` destinations before transport. Tests prove `fetch` is not called.

## Rollback

Rollback application code to `v0.9.0`. Do not remove additive D1 `0003` tables.

## Known limitations

No real AIFE/PPF/remote-PA connection, accreditation claim, legal evidence status, shared Payment Contract, automatic 212 or Business/Platform embedded UI.

## Future real interoperability path

Expose and version the missing shared contracts, qualify production adapters independently, enable external networking only in a separately governed environment, then perform real AIFE/PA qualification. PA-D2F must remain a consumer of those public contracts.
