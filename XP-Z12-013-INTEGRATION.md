# XP Z12-013 integration

The formal XP Z12-013 namespace is deliberately not implemented in 0.1.0. The official DGFiP v3.2 archive was inspected and does not include that SI↔PA OpenAPI artifact. The included public-directory Swagger must not be mislabeled as XP Z12-013.

Acceptance gate:

1. Obtain the official applicable AFNOR Swagger/OpenAPI artifact.
2. Record source, version, publication/activation date and SHA-256.
3. Import it unchanged under `regulatory/official/afnor/xp-z12-013/`.
4. Generate contract tests from the artifact.
5. Implement the exact route names and schemas.
6. Keep simulation controls exclusively under `/sandbox/v1`.
