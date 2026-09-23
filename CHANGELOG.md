# Changelog

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
