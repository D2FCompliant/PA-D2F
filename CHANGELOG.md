# Changelog

## 0.5.0 — 2026-09-24

### Added

- Publish a fail-closed coverage matrix for Flux 1–14, including conditional Flux 3 and Flux 7 interoperability agreements.
- Classify canonical invoices and build an explicit SI → D2F PA → receiving PA → recipient dispatch plan with the parallel Flux 1, 6 and 10 obligations.
- Simulate the receiving PA, PPF/Concentrator and Directory end to end while marking every result as sandbox-only test evidence.
- Provision and resolve idempotent, tenant-isolated synthetic Directory routes without inventing BT-49.
- Return exact source, PA or interoperability blockers before any dispatch.

### Compliance

- A sandbox-success verdict is kept distinct from production readiness. Partial or missing official contracts never produce a production-compliant claim.

Support: D2F-001072

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
