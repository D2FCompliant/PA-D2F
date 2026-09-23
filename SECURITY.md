# Security

- Sandbox-only credentials use the `d2f_sbx_` prefix.
- Secrets are Worker secrets or `.dev.vars`; none belong in source control.
- D1 records are scoped by authenticated connection and tenant.
- Credential comparison avoids early-exit string comparison.
- Raw XML forbids DTD/entity declarations.
- Evidence stores hashes and controlled envelopes; logs do not print payloads or credentials.
- `EXTERNAL_NETWORK_DISABLED=true` is the default and must be visible in the portal and health response.
- Production documents must never be copied automatically.
