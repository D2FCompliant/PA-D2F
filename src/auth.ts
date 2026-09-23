import { constantTimeEqual } from "./crypto";
import type { AuthContext } from "./types";

type AuthEnv = {
  API_KEY_HEADER: string;
  LEGACY_API_KEY?: string;
  LEGACY_BEARER_TOKEN?: string;
  ENTERPRISE_BEARER_TOKEN?: string;
};

function headerValue(request: Request, name: string): string {
  return request.headers.get(name)?.trim() ?? "";
}

export function authenticate(request: Request, env: AuthEnv, enterprise = false): AuthContext | null {
  const authorization = headerValue(request, "authorization");
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const expectedBearer = enterprise ? env.ENTERPRISE_BEARER_TOKEN : env.LEGACY_BEARER_TOKEN;
  const apiKeyHeader = env.API_KEY_HEADER || "x-api-key";
  const apiKey = headerValue(request, apiKeyHeader);

  const authMode = expectedBearer && bearer && constantTimeEqual(expectedBearer, bearer)
    ? "bearer"
    : !enterprise && env.LEGACY_API_KEY && apiKey && constantTimeEqual(env.LEGACY_API_KEY, apiKey)
      ? "api-key"
      : null;
  if (!authMode) return null;

  const connectionId = headerValue(request, "x-d2f-connection-id") || "legacy-business-suite";
  const tenantId = headerValue(request, "x-d2f-tenant-id") || connectionId;
  const legalEntityId = headerValue(request, "x-d2f-legal-entity-id") || null;
  return {
    connectionId,
    tenantId,
    legalEntityId,
    scopes: enterprise ? ["transactions:read", "transactions:write", "events:read", "events:write", "routing:read", "evidence:read"] : ["legacy:invoices"],
    authMode
  };
}
