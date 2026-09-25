# Directory sandbox

Migration `0001_initial.sql` establishes tenant-scoped directory storage for SIREN, SIRET, electronic addresses, legal entities/establishments, reception PA, routing identifier, activation period and status.

The Platform-facing test API is available through `PUT /sandbox/v1/directory/entries` and `POST /sandbox/v1/directory/resolve`. Entries are isolated by tenant and connected company and accept both SIREN and SIRET. This data is synthetic and must never be represented as the AIFE/DGFiP production directory.

The sandbox validation route `POST /sandbox/v1/validate/annuaire/{flow}` executes the official DGFiP v3.2 XSD for Flux 12, 13 or 14 and reports structural and supported Annex 7 date-period rules. It validates documents only; it does not call or impersonate the production Annuaire.
