# PA_INTEGRATION_REQUEST_UI_ACCESS

Status: OPEN

## Need

Expose a `Regulatory Simulation Lab` entry from Business Suite and Enterprise Platform without changing their active regulatory profile or connector.

## Required public contract

- SSO assertion scoped to the approved sandbox connection.
- `companyContext` used only for display/correlation, never as a Business database key.
- isolated `sandboxTenantId` distinct from every Business tenant.
- optional `transactionId` and `correlationId` deep-link context.
- user language and return URL.
- explicit authorization scope such as `pa-sandbox:execute` / `pa-sandbox:read`.

## Safety

The integration must not change country, Country Pack, routing, SEF settings or production connectors. D2F Compliant d.o.o. remains `RS` / `RS_SEF`; France simulation opens as a separate tool.

## Proposed additive handoff

```json
{
  "audience": "d2f-pa-sandbox",
  "sandboxTenantId": "D2F-PAE-SIM",
  "companyContext": "opaque-display-context",
  "transactionId": "optional-uuid",
  "correlationId": "optional-uuid",
  "scope": ["pa-sandbox:execute", "pa-sandbox:read"]
}
```

No Business/Platform change is made by PA-D2F. The owning shared-product chantier must approve and publish the final SSO contract.
