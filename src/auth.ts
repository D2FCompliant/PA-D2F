import { timingSafeEqual } from "./crypto";
import type { AuthContext } from "./types";

export function authenticate(request: Request, env: Env, enterpriseOnly = false): AuthContext | null {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const apiKey = request.headers.get(env.API_KEY_HEADER || "x-api-key")?.trim() ?? "";
  const enterprise = Boolean(bearer && env.ENTERPRISE_BEARER_TOKEN && timingSafeEqual(bearer, env.ENTERPRISE_BEARER_TOKEN));
  const legacyBearer = Boolean(bearer && env.LEGACY_BEARER_TOKEN && timingSafeEqual(bearer, env.LEGACY_BEARER_TOKEN));
  const legacyKey = Boolean(apiKey && env.LEGACY_API_KEY && timingSafeEqual(apiKey, env.LEGACY_API_KEY));
  if (enterpriseOnly ? !enterprise : !(enterprise || legacyBearer || legacyKey)) return null;
  return {
    connectionId: request.headers.get("x-d2f-connection-id")?.trim() || "legacy-business-suite",
    tenantId: request.headers.get("x-d2f-tenant-id")?.trim() || "sandbox-default",
    legalEntityId: request.headers.get("x-d2f-legal-entity-id")?.trim() || null,
    scopes: enterprise ? ["transactions:write", "traces:read", "lifecycle:write"] : ["legacy:invoices"],
    authMode: legacyKey ? "api-key" : "bearer"
  };
}
