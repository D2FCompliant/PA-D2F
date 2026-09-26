# Invoice lifecycle

Lifecycle is an explicit state machine; no free-text status mutation is allowed. Events retain occurrence/recording times, source, correlation, causation, regulatory code, full payload hash and evidence-chain hash.

Neither the final Regulatory Simulation API nor the legacy compatibility lifecycle emits status `212`. Payment remains a `SIMULATION_BOUNDARY` blocked by `PA_INTEGRATION_REQUEST_PAYMENT_CONTRACT`; no successful payment event or execution run is persisted. The existing code mapping remains reserved for future consumption of the public shared contract.
