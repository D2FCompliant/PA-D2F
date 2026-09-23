# D2F contract gap analysis

Date: 2026-09-23
Source repository inspected read-only: `/Users/patricegleizes/Documents/Codex/2026-08-11/re/d2f-platform-src`
Source commit: `0089d08f9f1096ab0d0f3a7dd0563a92aebc0f46`
Live source system: `https://gestion.d2fcompliant.org`

## Executive result

D2F already exposes two different integration surfaces that must be preserved:

1. Business Suite uses a generic PA connector based on raw invoice XML, simple Bearer/API-key authentication and normalized `id`/`remote_id`/`status` responses.
2. Enterprise Platform uses CBM `d2f.cbm.v2` version `2.1.0`, connection-scoped OAuth-style credentials, idempotency keys, execution plans, canonical events, webhooks and evidence.

The Sandbox must adapt both surfaces into one engine. It must not force either client to adopt the Sandbox's internal data model.

## Evidence inspected

| Source | Verified behavior | Sandbox response |
|---|---|---|
| `lib/integrations.ts` | HTTPS PA base URL; Bearer or configurable API-key; default `/health`, `/invoices`, `/invoices/:id`; raw body transmission; normalized response; persisted transmission receipt | Compatibility routes implemented in 0.1.0 |
| `Electron/connectors/fr_pdp.js` | Raw UBL XML `application/xml`; two retries; 30-second submit timeout; default paths; response normalization | Wire contract preserved; retries remain client-side |
| `Electron/connectors/peppol_ap.js` | Provider API receives JSON with base64 UBL and Peppol routing metadata | Adapter required in increment 3 |
| `Electron/inbound/webhook/server.js` | `POST /inbound/invoices`; HMAC SHA-256 over raw body; `X-Filename`, `X-Source-Name`, `X-Message-Id`, `X-Conversation-Id` | Signing primitive implemented; outbound delivery queue/API pending increment 2 |
| `Electron/inbound/sftp/poller.js` | XML polling, max-file batch, process-after-success move, copy/delete fallback | Optional SFTP fixture pending increment 4 |
| `platform/contracts/openapi/integration-hub.v1.*` | API 1.1.0; `X-D2F-Connection-Id`; 16–200 char idempotency key; transaction/event/webhook/evidence surfaces | Canonical transaction entry point implemented; remaining surfaces incremental |
| `platform/contracts/models/canonical-business-model.v2.schema.json` | Model ID `d2f.cbm.v2`, version `2.1.0`; connector-to-CBM transformation principle | Version preserved; no invented CBM v3 |
| `platform/contracts/events/event-envelope.v1.schema.json` | Full event envelope with producer, subject, context, actor, trace, contract, security, payload, metadata | Implemented for sandbox-generated events |
| `lib/integration-hub-core.ts` | Existing provider ID is `provider.d2f.sandbox`; French lifecycle maps `PAYMENT_RECEIVED` to regulatory code 212 | Provider identity and 212 mapping preserved |

## Normative baseline

- DGFiP external specifications: v3.2, dated 2026-04-30.
- Official archive contains v3.2 XSD sets and public directory Swagger `ppf-openapi-annuaire-api-public-1.11.0-openapi.json`.
- AFNOR XP Z12-012, XP Z12-013 and XP Z12-014 are the applicable common-base standards referenced by DGFiP.
- Peppol BIS Billing 3.0: May 2026 release, mandatory from 2026-08-17 according to OpenPeppol's published documentation.

### Critical formal API gap

The DGFiP v3.2 public archive does **not** contain the official XP Z12-013 SI↔PA OpenAPI artifact. It contains the PPF public directory API, which is a different interface. No XP Z12-013 route will be invented from memory. The normative namespace remains blocked until the official AFNOR Swagger/OpenAPI artifact is obtained and its checksum recorded.

## Capability gaps

| Capability | Existing D2F contract | 0.1.0 | Remaining work |
|---|---|---:|---|
| Legacy health / submit / status | Explicit | Done | Contract integration tests against Business Suite fixture |
| Bearer and API-key auth | Explicit | Done | Credential issuance/rotation portal |
| CBM 2.1 mapping | Explicit | Foundation | Full schema validation and bidirectional mappings |
| Connection/tenant isolation | Explicit | Done at persistence boundary | RBAC and credential tables |
| Idempotency | Explicit in Hub | Done for submissions | Expiry/retention policy and concurrency stress tests |
| UBL/CII/Factur-X | Required | Detection only | XSD, EN 16931, CIUS France, EXTENDED-CTC-FR and Factur-X extraction |
| Directory simulation | Required | Schema only | CRUD, migrations and routing scenarios |
| Lifecycle incl. 212 | Existing mapping | State machine done | CDAR documents, optional-status policy and callbacks |
| HMAC callbacks | Existing inbound convention | Primitive done | Queue, retries, history, duplicate/delay faults |
| Peppol | Existing provider adapter | Not yet | Participant lookup and safe simulated AP/AS4 evidence |
| E-reporting | Country Pack capability | Not yet | v3.2 transaction/payment/report XSD scenarios |
| Fault injection | Sandbox-only | Not yet | Namespaced fault policy with production-proof guard |
| Evidence | Hub evidence exists | Hash chain done | Archive export and readable report |
| SFTP | Existing Electron poller | Not yet | Optional local fixture |
| XP Z12-013 | Required official artifact | Blocked | Import official artifact; implement exact routes unchanged |

## Increment plan

1. Foundation: independent repository, API/database boundary, compatibility adapters, security kill switch, idempotency, events/evidence, lifecycle and gap analysis.
2. Directory + webhook delivery: tenant-admin CRUD, routing decisions, HMAC delivery queue, retry/idempotency tests.
3. Validation + Peppol: official XSD/Schematron execution, Factur-X extraction, simulated SMP/AP routing and evidence.
4. E-reporting + SFTP + fault injection: DGFiP v3.2 structures, optional channel fixture and full scenario catalogue.
5. XP Z12-013: import the official AFNOR OpenAPI artifact and implement exact normative routes without Sandbox controls in that namespace.
