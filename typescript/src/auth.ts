/**
 * Auth helpers — token management and multi-IdP token refresh.
 *
 * Wire surface: /v1/auth/* endpoints in atlasent-api.
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * // Refresh using the default IdP
 * const tokens = await client.auth.refresh(currentRefreshToken);
 *
 * // Refresh using a specific IdP (multi-IdP orgs)
 * const tokens = await client.auth.refreshWithIdp("idp_okta_prod", currentRefreshToken);
 *
 * // List IdP connections
 * const connections = await client.auth.listIdpConnections();
 * ```
 */

/** A token response from the auth endpoints. */
export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope?: string;
  /** IdP that issued the token (populated on multi-IdP responses). */
  idpId?: string;
}

/** Wire shape for token responses. */
interface TokenResponseWire {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  idp_id?: string;
}

function wireToTokenResponse(w: TokenResponseWire): TokenResponse {
  return {
    accessToken: w.access_token,
    refreshToken: w.refresh_token,
    tokenType: w.token_type,
    expiresIn: w.expires_in,
    ...(w.scope !== undefined ? { scope: w.scope } : {}),
    ...(w.idp_id !== undefined ? { idpId: w.idp_id } : {}),
  };
}

/** An IdP connection record. */
export interface IdpConnection {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  isDefault: boolean;
  domains?: string[];
  createdAt: string;
}

/** Wire shape for an IdP connection. */
interface IdpConnectionWire {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  default: boolean;
  domains?: string[];
  created_at: string;
}

function wireToIdpConnection(w: IdpConnectionWire): IdpConnection {
  return {
    id: w.id,
    name: w.name,
    provider: w.provider,
    enabled: w.enabled,
    isDefault: w.default,
    ...(w.domains !== undefined ? { domains: w.domains } : {}),
    createdAt: w.created_at,
  };
}

/** Sub-client for token management and multi-IdP auth. */
export interface AuthSubClient {
  /**
   * Refresh an access token using the default IdP connection.
   *
   * ```ts
   * const tokens = await client.auth.refresh(currentRefreshToken);
   * ```
   */
  refresh(refreshToken: string): Promise<TokenResponse>;

  /**
   * Refresh an access token against a specific IdP connection.
   *
   * Use this in multi-IdP organisations where the caller needs to
   * specify which SSO connection to use for the token exchange.
   *
   * `idpId` corresponds to the connection ID returned by
   * `listIdpConnections()` (e.g. `"idp_okta_prod"`, `"idp_entra"`).
   *
   * ```ts
   * const tokens = await client.auth.refreshWithIdp(
   *   "idp_okta_prod",
   *   currentRefreshToken,
   * );
   * ```
   */
  refreshWithIdp(idpId: string, refreshToken: string): Promise<TokenResponse>;

  /**
   * List IdP connections available for this organisation.
   *
   * ```ts
   * const connections = await client.auth.listIdpConnections();
   * const primary = connections.find(c => c.isDefault);
   * ```
   */
  listIdpConnections(): Promise<IdpConnection[]>;
}

/**
 * Factory that returns the auth sub-client bound to a host client.
 * Called internally by AtlaSentClient; not part of the public constructor API.
 */
export function makeAuthClient(
  postFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
  getFn: <T>(path: string) => Promise<{ body: T }>,
): AuthSubClient {
  return {
    async refresh(refreshToken: string): Promise<TokenResponse> {
      const { body } = await postFn<TokenResponseWire>(
        "/v1/auth/token/refresh",
        { refresh_token: refreshToken, grant_type: "refresh_token" },
      );
      return wireToTokenResponse(body);
    },

    async refreshWithIdp(
      idpId: string,
      refreshToken: string,
    ): Promise<TokenResponse> {
      const path = `/v1/auth/idp/${encodeURIComponent(idpId)}/token/refresh`;
      const { body } = await postFn<TokenResponseWire>(path, {
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        idp_id: idpId,
      });
      return wireToTokenResponse(body);
    },

    async listIdpConnections(): Promise<IdpConnection[]> {
      const { body } = await getFn<{ connections: IdpConnectionWire[] }>(
        "/v1/auth/idp-connections",
      );
      return (body.connections ?? []).map(wireToIdpConnection);
    },
  };
}
