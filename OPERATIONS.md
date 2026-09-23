# Operations

Runtime: Node 22 toolchain; Cloudflare Worker; independent D1 database.

Before a release: run generated binding-type check, TypeScript build, tests, D1 migration validation, Wrangler dry run, `git diff --check` and secret scan. Deploy the exact tested commit to the Sandbox environment, verify `/health`, then exercise a synthetic raw-XML submission and canonical idempotency replay.

External network access must remain off unless a separately approved, allowlisted test requires it.
