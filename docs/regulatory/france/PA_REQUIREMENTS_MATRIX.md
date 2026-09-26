# PA Phase 1 Requirements Matrix

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

Regulatory Result, readiness, Country Runtime and Payment Contract remain external integration requests. A result at those boundaries is `SIMULATION_BOUNDARY`, not a regulatory interpretation.
