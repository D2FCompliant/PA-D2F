# Fault injection

Fault injection will exist only under `/sandbox/v1` and will require a dedicated sandbox scope. Production connectors cannot import or enable it. External networking remains disabled regardless of a requested fault scenario.

Planned faults: HTTP 400/401/403/404/409/422/429/500/502/503, timeout, connection reset, malformed JSON/XML, invalid signature, duplicate/delayed callback, wrong IDs and missing acknowledgement.
