# Directory sandbox

Migration `0001_initial.sql` establishes tenant-scoped directory storage for SIREN, SIRET, electronic addresses, legal entities/establishments, reception PA, routing identifier, activation period and status.

The data is synthetic and must never be represented as the AIFE/DGFiP production directory.

`POST /sandbox/v1/directory/resolve` exposes the PA-side recipient-routing contract used by D2F Enterprise Platform and D2F Gestion. The request supplies SIREN/SIRET and an optional service code. The response returns BT-49, the reception platform, directory version/source evidence and an explicit `RESOLVED`, `NOT_FOUND` or `AMBIGUOUS` state. It applies SIRET before SIREN and never fabricates a production address. An authenticated caller may explicitly request `simulateIfMissing: true`; the PA then provisions a deterministic `SBX-FR-*` address marked synthetic, with `externalNetworkCalled: false`, valid only inside the tenant sandbox.

This sandbox mirror is populated only with synthetic/imported test data. A production PA would synchronize the real PPF directory under its AIFE/DGFiP agreement; the sandbox keeps external production-network access disabled.

The sandbox validation route `POST /sandbox/v1/validate/annuaire/{flow}` executes the official DGFiP v3.2 XSD for Flux 12, 13 or 14 and reports structural and supported Annex 7 date-period rules. It validates documents only; it does not call or impersonate the production Annuaire.
