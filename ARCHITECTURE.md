# Architecture

D2F PA Sandbox is an independent Cloudflare Worker backed by its own D1 database. Public versioned contracts are the only integration boundary with D2F Business Suite and Enterprise Platform. External regulatory and Peppol networks are disabled by default.

The target validation path is transport, XML parsing, official DGFiP XSD, EN16931, French profile/Schematron, business rules, routing and sandbox scenario evaluation. Every transaction produces immutable hash-chained evidence.
