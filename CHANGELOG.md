# Changelog

## 0.9.0 — 2026-09-26

### Added

- Extend the synthetic PAE → Directory Simulator → PAR → Buyer pipeline with connection-isolated lifecycle events and technical evidence.
- Add additive lifecycle event and lifecycle trace routes with idempotent replay, duplicate-event protection and resumable PAR-to-PAE propagation.
- Expose explicit simulated actor, lifecycle-contract source, UTC timestamp, payload hash and simulated-interoperability provenance for each lifecycle event.

### Safety

- Enable lifecycle simulation only in the explicit sandbox environment; root defaults remain disabled and PPF simulation remains off.
- Keep status 212 behind `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`; a blocked 212 persists no successful lifecycle event or execution run.
- Reuse the existing additive `0003` tables; no D1 migration is added and all external network access remains disabled.

## 0.8.0 — 2026-09-26

### Added

- Execute the synthetic PAE → Directory Simulator → PAR → Buyer Simulator pipeline with eight persistent trace messages.
- Add deterministic directory outcomes, controlled PAR/Buyer failures, idempotent replay and resumable execution runs.
- Add the connection-isolated `GET /sandbox/v1/transactions/{transactionId}` trace route and OpenAPI 0.8.0 contract.

### Safety

- Activate dual-node and directory simulation only in the explicit sandbox environment.
- Keep PPF and lifecycle simulation disabled and block every non-`sim://` target before transport.
- Reuse the existing additive `0003` tables; no D1 migration is added.

## 0.7.0 — 2026-09-26

### Added

- Add a disabled-by-default PAE/PAR orchestration foundation for the synthetic `DEMO-FR-PIPELINE-001` scenario.
- Add synthetic tenant isolation, transaction/correlation/execution identifiers, idempotent replay and simulation provenance.
- Add network guards that reject any non-`sim://` target with `EXTERNAL_NETWORK_BLOCKED` before transport.
- Add an additive D1 migration for PA Sandbox simulation transactions, runs and messages.

### Safety

- Preserve 0.6.0 behavior while all new flags are off.
- Do not implement or duplicate shared Regulatory Result, readiness, Country Runtime or Payment contracts.
- Do not read or modify the D2F Compliant d.o.o. Business profile or its `RS_SEF` configuration.

## 0.6.0 — 2026-09-25

### Added

- Return French supplier delivery statuses `202` and `203` from the existing sandbox lifecycle transitions.
- Return buyer decision statuses `205` approved, `207` disputed, `208` suspended and `210` refused.
- Keep status `212` reserved for the existing collection/payment simulation.

### Safety

- These codes belong only to the isolated French PA Sandbox lifecycle and do not modify the Serbian SEF connector.

Support: D2F-REL-36300
Functional commit: 86ba72990ceb8e77b70339b56a63543c80532ec7

## 0.5.2 — 2026-09-25

### Fixed

- Add the Platform-facing sandbox directory registration and resolution routes.
- Resolve synthetic recipients at SIREN or SIRET grain while preserving tenant and connected-company isolation.
- Validate identifier formats, activation periods and required electronic-address provenance.

### Database

- Migration `0002_directory_api.sql` adds the connection scope, address scheme, source reference, status and update timestamp required by the directory API.

Support: D2F-REL-36207
Functional commit: f132ad50bc793ef86a7911810688429acb1166c4

## 0.5.1 — 2026-09-25

### Added

- Accept canonical `D2F_REGULATORY_BATCH_V1` source batches from Enterprise Platform.
- Generate and validate PA-owned Flux 10.1, 10.2, 10.3 and 10.4 documents.
- Aggregate B2C transactions, preserve source-record links and return generated-document fingerprints.
- Preserve idempotent validation evidence without claiming an external PPF delivery.

### Tests

- B2C source invoices aggregate into a valid Flux 10.3.
- Collected payments generate valid Flux 10.2 and 10.4 documents, including invoices from an earlier period.

Support: D2F-REL-36205
Functional commit: db90df34d4c49d5899fa880041ce2569667b20d0

## 0.5.0 — 2026-09-25

### Fixed

- Validate incoming Flux 2 UBL invoices with the official OASIS UBL 2.1 runtime schema instead of the structurally different DGFiP Flux 1 schema.
- Keep Flux 1 validation and generation separate from the incoming invoice validation pipeline.
- Ignore macOS AppleDouble metadata when producing the immutable runtime XSD bundles.

### Tests

- A complete French invoice must pass OASIS UBL 2.1, EN 16931 and FNFE controls end to end.

Support: D2F-REL-36000
Functional commit: d4fc65f

## 0.4.0 — 2026-09-23

### Added

- Expose a tenant-isolated operations console with the structured Flux 1 metadata, XSD/EN 16931/Schematron stages, rule-level errors and simulated PPF result.
- Preserve the original validation report while the invoice advances through its sandbox lifecycle.
- Expose only legal next lifecycle states and record immutable transitions through delivery, availability, approval and French status 212 (`PAID` / encaissée).

### Security

- Operation listings never return invoice XML or credentials and remain scoped by the authenticated tenant.

Support: D2F-001064
Functional commit: bde392f5876dcf59f77d6bd31986b05ab09d5e20

## 0.3.0 — 2026-09-23

### Added

- Validate and classify e-reporting Flux 10.1, 10.2, 10.3 and 10.4 with the official DGFiP v3.2 XSD graph.
- Return traceable Annex 7 v1.9 management-rule failures for transmission metadata, periods, identifiers, currencies, categories and totals.
- Validate Annuaire Flux 12, 13 and 14 with the official DGFiP v3.2 XSD graph.
- Persist immutable validation evidence and simulate PPF acceptance/rejection without external network access.

### Compliance

- Report Flux 10 and Annuaire Schematron stages as not applicable because the official DGFiP v3.2 archive does not publish those artefacts; Flux 1 retains real EN 16931/FNFE Schematron execution.

Support: D2F-001064

## 0.2.7 — 2026-09-23

### Fixed

- Initialize the libxml2 runtime explicitly before loading its synchronous wrappers, removing the unsupported Worker module-level await cycle.
- Apply the compatibility patch reproducibly during installation and fail safely if the pinned libxml2-wasm 0.7.2 layout changes.

Support: D2F-001064

## 0.2.6 — 2026-09-23

### Fixed

- Correct the Emscripten callback signature-byte lookup used to select the precompiled Worker adapter modules.

Support: D2F-001064

## 0.2.5 — 2026-09-23

### Fixed

- Precompile the three libxml2 callback adapters used by Emscripten (`vii`, `ii`, `iiii`) so Cloudflare never needs forbidden runtime WebAssembly code generation.

Support: D2F-001064

## 0.2.4 — 2026-09-23

### Fixed

- Import the official embedded libxml2 binary as a Cloudflare `CompiledWasm` module instead of compiling bytecode at request time, which Workers forbids.
- Preserve the exact libxml2 WebAssembly payload (`SHA-256 148c89deb5f8baeaaf0e50c5f6bbe73b1ea7ff74a462f476cb8b03a5102d8332`).

Support: D2F-001064

## 0.2.3 — 2026-09-23

### Fixed

- Map SaxonJS Node runtime's two deliberate global bindings to explicit Worker globals during bundling, avoiding strict-module startup errors without altering the official Schematron engine or compiled rules.

Support: D2F-001064

## 0.2.2 — 2026-09-23

### Fixed

- Defer the libxml2 WebAssembly engine initialization until a Flux 1 validation request, so the Cloudflare Worker can start without an unsettled module-level await.
- Keep the DGFiP XSD, EN 16931 and France Schematron stages intact and awaited before returning the validation result.

Support: D2F-001064

## 0.2.1 — 2026-09-23

### Fixed

- Force the Emscripten `libxml2-wasm` bundle to use its WebAssembly Worker path when Cloudflare Node compatibility exposes a synthetic `process` global.
- Preserve Node.js 22 behavior for local tests and build tooling while preventing the unsupported runtime `createRequire()` call in the deployed Worker.

Support: D2F-001064

## 0.2.0 — 2026-09-23

### Added

- Real DGFiP Flux 1 XSD validation using the committed official schema graph.
- EN 16931 and FNFE France Schematron execution with structured failed-rule feedback.
- Core Flux 1 business-term extraction, including BT-49, and isolated PPF submission simulation.
- Idempotent `/sandbox/v1/validate/flux1` endpoint with immutable transaction evidence and an OpenAPI contract.

### Security

- XML parsing disables external network access, DTD and entity expansion.
- The simulator refuses missing BT-49 values instead of fabricating routing data.

Support: D2F-001064

## 0.1.0 — 2026-09-23

### Added

- Independent Worker/D1 foundation and legacy D2F PA compatibility routes.
- Tenant-scoped idempotency, event evidence and lifecycle simulation including code 212.
- DGFiP v3.2 XSD/Flux 1 artefacts and FNFE 1.4.0.04 Schematron/XSLT baselines.
- Node 22 GitHub CI foundation.
