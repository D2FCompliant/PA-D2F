# OASIS UBL 2.1 runtime schemas

- Source: `https://docs.oasis-open.org/ubl/os-UBL-2.1/UBL-2.1.zip`
- Release: OASIS Universal Business Language 2.1, 4 November 2013
- Imported subset: `xsdrt/common/*.xsd`, `xsdrt/maindoc/UBL-Invoice-2.1.xsd`, `xsdrt/maindoc/UBL-CreditNote-2.1.xsd`
- Archive SHA-256: `60b80d76394a8a2add90723ecb8e0e2e9d826775de9749df37a72d60703f86ed`
- Purpose: validate incoming Flux 2 UBL syntax before EN 16931 and French FNFE Schematron controls.

The DGFiP Flux 1 schemas remain separate. They must not be used as the structural schema for the incoming Flux 2 invoice.
