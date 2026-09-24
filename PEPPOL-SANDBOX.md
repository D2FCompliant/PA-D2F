# Peppol sandbox

Planned flow: canonical regulatory service → transport adapter → Peppol Sandbox adapter.

The adapter will model participant scheme/ID, document type ID, process ID, discovery, endpoint, simulated AS4 evidence, acknowledgement and rejection. `EXTERNAL_NETWORK_DISABLED=true` is the hard default; external adapters require both an explicit allowlist and a non-production credential scope.

Business Suite and Enterprise Platform use the SI-to-PA contract and are not Peppol Access Points. D2F PA selects Peppol/AS4 for PA-to-PA transport when the participant, document profile and receiving Access Point are known. The sandbox actors `D2F_PA_SANDBOX_AP` and `SIMULATED_PAR` execute that route without external networking and return explicit test evidence; this is not Peppol certification.

The French PPF Directory and Concentrator remain separate obligations. Peppol transport does not replace Flux 1, 6, 10 or 13/14 responsibilities.
