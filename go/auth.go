package atlasent

import (
	"context"
	"fmt"
	"net/url"
)

// TokenResponse is the response from a token refresh operation.
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope,omitempty"`
	IDPID        string `json:"idp_id,omitempty"`
}

// AuthClient wraps the /v1/auth/* token management endpoints.
type AuthClient struct {
	c *Client
}

// Refresh refreshes an access token using the default IdP connection.
//
//	tokens, err := client.Auth.Refresh(ctx, currentRefreshToken)
func (a *AuthClient) Refresh(ctx context.Context, refreshToken string) (TokenResponse, error) {
	var out TokenResponse
	if err := a.c.post(ctx, "/v1/auth/token/refresh", map[string]any{
		"refresh_token": refreshToken,
		"grant_type":    "refresh_token",
	}, &out); err != nil {
		return TokenResponse{}, fmt.Errorf("atlasent: auth.refresh: %w", err)
	}
	return out, nil
}

// RefreshWithIdP refreshes an access token against a specific IdP connection.
// Use this in multi-IdP organisations where the caller needs to specify which
// SSO connection to use for the token exchange.
//
// idpID corresponds to the connection ID returned by
// GET /v1/auth/idp-connections (e.g. "idp_okta_prod", "idp_entra").
//
//	tokens, err := client.Auth.RefreshWithIdP(ctx, "idp_okta_prod", currentRefreshToken)
func (a *AuthClient) RefreshWithIdP(ctx context.Context, idpID, refreshToken string) (TokenResponse, error) {
	if idpID == "" {
		return TokenResponse{}, &Error{Message: "idpID is required", Code: "bad_request"}
	}
	var out TokenResponse
	path := fmt.Sprintf("/v1/auth/idp/%s/token/refresh", url.PathEscape(idpID))
	if err := a.c.post(ctx, path, map[string]any{
		"refresh_token": refreshToken,
		"grant_type":    "refresh_token",
		"idp_id":        idpID,
	}, &out); err != nil {
		return TokenResponse{}, fmt.Errorf("atlasent: auth.refresh_with_idp: %w", err)
	}
	return out, nil
}

// ListIdPConnections lists the IdP connections available for this organisation.
//
//	connections, err := client.Auth.ListIdPConnections(ctx)
func (a *AuthClient) ListIdPConnections(ctx context.Context) ([]IdPConnection, error) {
	var resp struct {
		Connections []IdPConnection `json:"connections"`
	}
	if err := a.c.get(ctx, "/v1/auth/idp-connections", &resp); err != nil {
		return nil, fmt.Errorf("atlasent: auth.list_idp_connections: %w", err)
	}
	return resp.Connections, nil
}

// IdPConnection describes a single SSO/IdP connection for an organisation.
type IdPConnection struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Provider    string `json:"provider"`
	Enabled     bool   `json:"enabled"`
	Default     bool   `json:"default"`
	Domains     []string `json:"domains,omitempty"`
	CreatedAt   string `json:"created_at"`
}
