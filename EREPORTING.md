# E-reporting

`POST /sandbox/v1/validate/ereporting` accepts one DGFiP Flux 10 XML document and detects exactly one payload form:

- 10.1: detailed B2B international invoices;
- 10.2: invoice-level payments;
- 10.3: aggregated transactions;
- 10.4: aggregated payments.

The Worker executes the official DGFiP v3.2 `ereporting.xsd` graph and a first executable set of Annex 7 v1.9 rules, including transmission separation, PA/issuer identifiers, periods, dates, currencies, categories and total reconciliation. Every failure includes its DGFiP rule identifier and XML path.

The official v3.2 archive contains no Flux 10 Schematron file. The API therefore reports that stage as `NOT_APPLICABLE`; it does not label the Annex 7 implementation as an official Schematron.
