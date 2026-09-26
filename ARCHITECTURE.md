# Architecture

D2F PA Sandbox is an independent Cloudflare Worker backed by its own D1 database. Public versioned contracts are the only integration boundary with D2F Business Suite and Enterprise Platform. External regulatory and Peppol networks are disabled by default.

The target validation path is transport, XML parsing, official DGFiP XSD, EN16931, French profile/Schematron, business rules, routing and sandbox scenario evaluation. Every transaction produces immutable hash-chained evidence.

## Phase 1 simulation boundary

PAE and PAR are logical roles served by one runtime. They are separated by fixed synthetic tenant, endpoint, queue and credential references; no second regulatory engine is introduced. Scenario orchestration depends on public or temporary adapter interfaces (`DirectoryAdapter`, `RemotePaAdapter`, `PpfReportingAdapter`, `RegulatoryValidationAdapter`). External targets are rejected before transport when `EXTERNAL_NETWORK_DISABLED=true`.

The Phase 1 scenario records `transactionId`, stable end-to-end `correlationId` and per-attempt `executionRunId`. Replaying an existing transaction creates a new run, not a second business transaction. Missing shared Regulatory Result, readiness, Country Runtime and Payment contracts remain explicit integration requests; the runtime reports `SIMULATION_BOUNDARY` instead of inventing regulatory meaning.
