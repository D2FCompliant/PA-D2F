# Peppol sandbox

Planned flow: canonical regulatory service → transport adapter → Peppol Sandbox adapter.

The adapter will model participant scheme/ID, document type ID, process ID, discovery, endpoint, simulated AS4 evidence, acknowledgement and rejection. `EXTERNAL_NETWORK_DISABLED=true` is the hard default; external adapters require both an explicit allowlist and a non-production credential scope.
