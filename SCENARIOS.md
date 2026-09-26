# Scenarios

All scenarios use synthetic data, the same PA runtime and `sim://` adapters. Execute them with `POST /sandbox/v1/scenarios/{scenarioId}/executions`.

| Scenario | Demonstration | Expected result |
|---|---|---|
| `DEMO-FR-001` | FR→FR full path | lifecycle approved; domestic reporting contract boundary documented |
| `DEMO-FR-002` | Missing mandatory canonical buyer | canonical validation rejection |
| `DEMO-FR-003` | Unknown directory recipient | directory rejection |
| `DEMO-FR-004` | Lifecycle to APPROVED | approved |
| `DEMO-FR-005` | FR→foreign Flux 10.1 | PPF accepted |
| `DEMO-FR-006` | France B2C Flux 10.3 | PPF accepted |
| `DEMO-FR-007` | PPF reject, correction, replay | rejected then accepted; replay idempotent |
| `DEMO-FR-008` | Temporary PAR failure | same transaction resumed |
| `DEMO-FR-009` | Invalid lifecycle | deterministic rejection |
| `DEMO-FR-010` | Payment / 212 | Payment Contract `SIMULATION_BOUNDARY` |
| `MATIC-DEMO` | Synthetic integrator journey | PAE/PAR/lifecycle plus Flux 10.1 evidence |

Every scenario is deterministic, API-executable and visible in the unified trace.
