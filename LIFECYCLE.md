# Invoice lifecycle

Lifecycle is an explicit state machine; no free-text status mutation is allowed. Events retain occurrence/recording times, source, correlation, causation, regulatory code, full payload hash and evidence-chain hash.

The legacy compatibility lifecycle can emit the sandbox French status code `212` after an allowed transition. Phase 3 Regulatory Simulation does not emit or extend `212`: payment remains a `SIMULATION_BOUNDARY` blocked by `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`. A direct `RECEIVED → PAID` transition remains rejected as out of order.
