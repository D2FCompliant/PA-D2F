# PA Regulatory Simulation Requirements Matrix

| Requirement ID | Source | Implementation | Evidence |
|---|---|---|---|
| REQ-PA-ARCH-DUAL-NODE | Phase 1 §5 | One `PhaseOneScenarioEngine`, fixed PAE/PAR logical nodes | `simulation-phase1.test.ts` logical isolation |
| REQ-PA-ARCH-ADAPTERS | Phase 1 §6 | Directory, remote PA, PPF and temporary validation adapter interfaces | Typecheck and scenario test |
| REQ-PA-TRACE-IDS | Phase 1 §8 | Stable transaction/correlation IDs; per-run execution ID | replay test |
| REQ-PA-IDEMPOTENCE | Phase 1 §9 | connection-scoped idempotency key and response replay | duplicate and execution replay test |
| REQ-PA-PROVENANCE | Phase 1 §10 | explicit provenance union and step provenance | scenario result assertions |
| REQ-PA-NETWORK-BLOCK | Phase 1 §7 | target guard rejects non-`sim://` before transport | fetch spy remains unused |
| REQ-PA-FEATURE-FLAGS | Phase 1 §11 | four flags default false | disabled route and health non-regression test |
| REQ-PA-TENANT-ISOLATION | Phase 1/addendum §7 | Business tenant input mapped to synthetic context | isolation and connection-scope test |
| REQ-PA-BUSINESS-PROFILE-PROTECTION | Business addendum | no Business storage/imports; synthetic fixtures only | RS/SEF/profile boundary test |
| REQ-PA-DEMO-FR-PIPELINE-001 | Phase 1 §16 | PAE → directory → PAR → buyer delivery | happy-path scenario test |
| REQ-PA-P2-DIRECTORY-OUTCOMES | Phase 2 §2 | Deterministic simulated directory with eight outcomes and simulated provenance | directory outcome matrix test |
| REQ-PA-P2-PERSISTED-MESSAGES | Phase 2 §3 | Eight typed message envelopes persisted with transaction, correlation, run, sequence and UTC timestamp | happy-path and trace tests |
| REQ-PA-P2-VALIDATION-BOUNDARIES | Phase 2 §5 | Real canonical validation separated from simulated directory and remote PA evidence | happy-path evidence assertions |
| REQ-PA-P2-REPLAY-RESUME | Phase 2 §7 | Idempotent request replay and resumable runs after Directory, PAR or temporary failure | replay and resume tests |
| REQ-PA-P2-NEGATIVE-SCENARIOS | Phase 2 §8 | Directory block, temporary remote failure, duplicate message suppression and PAR rejection | negative scenario tests |
| REQ-PA-P2-BUYER-SIMULATOR | Phase 2 §9 | Isolated internal buyer adapter with delivered or temporary-failure outcome | happy-path and network guard tests |
| REQ-PA-P2-TRACE-API | Phase 2 §11 | Connection-scoped sanitized trace under `/sandbox/v1/transactions/{transactionId}` | trace persistence and isolation test |
| REQ-PA-P2-OPENAPI-CANDIDATE | Phase 2 §12 | Additive OpenAPI 0.8.0 candidate paths, examples and errors | typecheck and OpenAPI source review |
| REQ-PA-P2-SANDBOX-ACTIVATION | Phase 2 §1/§13 | Dual-node and directory flags enabled only in `env.sandbox`; global defaults remain false | configuration regression review |

Regulatory Result, readiness, Country Runtime and Payment Contract remain external integration requests. A result at those boundaries is `SIMULATION_BOUNDARY`, not a regulatory interpretation.
