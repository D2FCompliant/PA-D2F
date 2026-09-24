# D2F PA regulatory flow contract

The executable source of truth is `src/regulatory-coverage.ts` and the public endpoint is `GET /sandbox/v1/regulatory/coverage`.

The matrix covers Flux 1 through 14. It distinguishes:

- `IMPLEMENTED`: the committed official artefact and its executable controls are present;
- `PARTIAL`: useful controls exist but production parity is not demonstrated;
- `BLOCKED_OFFICIAL_ARTIFACT`: the flow is declared and must fail closed until the official contract, profile, agreement or qualification evidence is present.

Flux 2 is selected for UBL, CII or Factur-X domestic B2B exchange. Flux 3 requires a bilateral agreement and an identified, versioned structured profile. Flux 6 carries the standard lifecycle; Flux 7 is conditional and requires an agreed non-CDAR lifecycle profile. Flux 8 and 9 feed the applicable Flux 10 e-reporting paths. Flux 11–14 cover enterprise/PA Directory consultation and PPF Directory exchange.

The sandbox simulates a receiving PA, PPF/Concentrator and Directory so integrations can execute end to end. Every simulation response states `testEvidence: true` and `externalNetworkCalled: false`; it is not accreditation evidence.

Business Suite and Enterprise Platform use the SI-to-PA contract. They do not implement Peppol transport directly. The PA routing plan selects Peppol/AS4 as the preferred PA-to-PA network when the receiving participant and Access Point are discoverable; a versioned bilateral route remains possible where the legal and interoperability framework allows it. French Directory, Concentrator and regulatory reporting obligations remain separate from Peppol delivery.
