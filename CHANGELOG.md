# Changelog

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
