# E-reporting

`POST /sandbox/v1/validate/ereporting` accepts one DGFiP Flux 10 XML document and detects exactly one payload form:

- 10.1: detailed B2B international invoices;
- 10.2: invoice-level payments;
- 10.3: aggregated transactions;
- 10.4: aggregated payments.

The Worker executes the official DGFiP v3.2 `ereporting.xsd` graph and a first executable set of Annex 7 v1.9 rules, including transmission separation, PA/issuer identifiers, periods, dates, currencies, categories and total reconciliation. Every failure includes its DGFiP rule identifier and XML path.

The official v3.2 archive contains no Flux 10 Schematron file. The API therefore reports that stage as `NOT_APPLICABLE`; it does not label the Annex 7 implementation as an official Schematron.

## Canonical source ingestion

`POST /sandbox/v1/ingest/ereporting` accepts a `D2F_REGULATORY_BATCH_V1` JSON batch from Enterprise Platform. The compatible solution supplies traceable source invoices, payments, tax breakdowns and the reporting period; it does not manufacture the regulatory XML.

The PA boundary owns the following operations:

- select the applicable Flux 10.1, 10.2, 10.3 and 10.4 payloads from the declared obligations;
- aggregate B2C transactions and collections;
- generate the DGFiP XML documents;
- execute the XSD and Annex 7 controls;
- retain the request, generated-document fingerprints, validation evidence and idempotent response;
- schedule and submit accepted reports to the PPF in a production PA implementation.

The sandbox never claims an external PPF delivery. Its `ppfSimulation` is evidence of a local validation outcome only.

The legal reporting cadence is not hard-coded as a universal 24-hour interval. Enterprise Platform calculates the applicable closed period from the issuer's French VAT regime, while the PA remains responsible for regulatory aggregation, deadlines, retries and PPF submission. Source applications may hand off events more frequently, but a source-data handoff must not be displayed as a completed Flux 10 transmission.
