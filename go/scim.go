package atlasent

import (
	"context"
	"fmt"
	"net/url"
)

// SCIM schema URNs.
const (
	SCIMUserSchema    = "urn:ietf:params:scim:schemas:core:2.0:User"
	SCIMGroupSchema   = "urn:ietf:params:scim:schemas:core:2.0:Group"
	SCIMPatchOpSchema = "urn:ietf:params:scim:api:messages:2.0:PatchOp"
)

// SCIMListResponse is the SCIM 2.0 list response envelope.
type SCIMListResponse struct {
	Schemas      []string `json:"schemas"`
	TotalResults int      `json:"totalResults"`
	StartIndex   int      `json:"startIndex"`
	ItemsPerPage int      `json:"itemsPerPage"`
	Resources    []any    `json:"Resources"`
}

// SCIMListUsersResponse is the typed list response for users.
type SCIMListUsersResponse struct {
	Schemas      []string   `json:"schemas"`
	TotalResults int        `json:"totalResults"`
	StartIndex   int        `json:"startIndex"`
	ItemsPerPage int        `json:"itemsPerPage"`
	Resources    []SCIMUser `json:"Resources"`
}

// SCIMUser is the SCIM 2.0 User resource.
type SCIMUser struct {
	Schemas     []string          `json:"schemas,omitempty"`
	ID          string            `json:"id,omitempty"`
	UserName    string            `json:"userName"`
	DisplayName string            `json:"displayName,omitempty"`
	Active      bool              `json:"active,omitempty"`
	Emails      []SCIMEmail       `json:"emails,omitempty"`
	Name        *SCIMName         `json:"name,omitempty"`
	Groups      []SCIMGroupRef    `json:"groups,omitempty"`
	Meta        *SCIMMeta         `json:"meta,omitempty"`
	Extensions  map[string]any    `json:"-"`
}

// SCIMEmail is an email value in a SCIM User.
type SCIMEmail struct {
	Value   string `json:"value"`
	Type    string `json:"type,omitempty"`
	Primary bool   `json:"primary,omitempty"`
}

// SCIMName is the name component in a SCIM User.
type SCIMName struct {
	Formatted  string `json:"formatted,omitempty"`
	GivenName  string `json:"givenName,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
}

// SCIMGroupRef is a group reference embedded on a user.
type SCIMGroupRef struct {
	Value   string `json:"value"`
	Display string `json:"display,omitempty"`
}

// SCIMMeta is the SCIM metadata block.
type SCIMMeta struct {
	ResourceType string `json:"resourceType,omitempty"`
	Created      string `json:"created,omitempty"`
	LastModified string `json:"lastModified,omitempty"`
	Location     string `json:"location,omitempty"`
	Version      string `json:"version,omitempty"`
}

// SCIMListParams holds query parameters for list operations.
type SCIMListParams struct {
	OrgID      string
	Filter     string
	StartIndex int
	Count      int
}

// SCIMPatchOp is a single RFC 7644 PatchOp operation.
type SCIMPatchOp struct {
	Op    string `json:"op"`
	Path  string `json:"path,omitempty"`
	Value any    `json:"value,omitempty"`
}

// SCIMClient is the top-level SCIM client exposing Users and Groups sub-clients.
type SCIMClient struct {
	Users  *SCIMUsersClient
	Groups *SCIMGroupsClient
	// unexported fields
	users  *SCIMUsersClient
	groups *SCIMGroupsClient
}

// SCIMUsersClient wraps /scim/v2/{orgId}/Users endpoints.
type SCIMUsersClient struct {
	c *Client
}

// List lists provisioned SCIM users.
func (u *SCIMUsersClient) List(ctx context.Context, params SCIMListParams) (SCIMListUsersResponse, error) {
	path := scimUsersPath(params.OrgID) + scimQueryString(params.Filter, params.StartIndex, params.Count)
	var resp SCIMListUsersResponse
	if err := u.c.get(ctx, path, &resp); err != nil {
		return SCIMListUsersResponse{}, fmt.Errorf("atlasent: scim.users.list: %w", err)
	}
	return resp, nil
}

// Create provisions a new SCIM user.
func (u *SCIMUsersClient) Create(ctx context.Context, orgID string, user SCIMUser) (SCIMUser, error) {
	if len(user.Schemas) == 0 {
		user.Schemas = []string{SCIMUserSchema}
	}
	var out SCIMUser
	if err := u.c.post(ctx, scimUsersPath(orgID), user, &out); err != nil {
		return SCIMUser{}, fmt.Errorf("atlasent: scim.users.create: %w", err)
	}
	return out, nil
}

// Update replaces a SCIM user (full replacement, PUT).
func (u *SCIMUsersClient) Update(ctx context.Context, orgID, userID string, user SCIMUser) (SCIMUser, error) {
	if len(user.Schemas) == 0 {
		user.Schemas = []string{SCIMUserSchema}
	}
	var out SCIMUser
	path := fmt.Sprintf("%s/%s", scimUsersPath(orgID), url.PathEscape(userID))
	resp, err := u.c.do(ctx, "PUT", path, user)
	if err != nil {
		return SCIMUser{}, fmt.Errorf("atlasent: scim.users.update: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if err := decodeResponse(resp, &out); err != nil {
		return SCIMUser{}, fmt.Errorf("atlasent: scim.users.update: %w", err)
	}
	return out, nil
}

// Delete deprovisions a SCIM user.
func (u *SCIMUsersClient) Delete(ctx context.Context, orgID, userID string) error {
	path := fmt.Sprintf("%s/%s", scimUsersPath(orgID), url.PathEscape(userID))
	resp, err := u.c.do(ctx, "DELETE", path, nil)
	if err != nil {
		return fmt.Errorf("atlasent: scim.users.delete: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode >= 400 {
		return apiError(resp)
	}
	return nil
}

// SCIMGroupsClient wraps /scim/v2/{orgId}/Groups endpoints.
type SCIMGroupsClient struct {
	c *Client
}

// List lists provisioned SCIM groups.
func (g *SCIMGroupsClient) List(ctx context.Context, params SCIMListParams) (SCIMListResponse, error) {
	path := scimGroupsPath(params.OrgID) + scimQueryString(params.Filter, params.StartIndex, params.Count)
	var resp SCIMListResponse
	if err := g.c.get(ctx, path, &resp); err != nil {
		return SCIMListResponse{}, fmt.Errorf("atlasent: scim.groups.list: %w", err)
	}
	return resp, nil
}

// Create provisions a new SCIM group.
func (g *SCIMGroupsClient) Create(ctx context.Context, orgID string, group map[string]any) (map[string]any, error) {
	schemas, _ := group["schemas"].([]any)
	if len(schemas) == 0 {
		group["schemas"] = []string{SCIMGroupSchema}
	}
	var out map[string]any
	if err := g.c.post(ctx, scimGroupsPath(orgID), group, &out); err != nil {
		return nil, fmt.Errorf("atlasent: scim.groups.create: %w", err)
	}
	return out, nil
}

// Update replaces a SCIM group (full replacement, PUT).
func (g *SCIMGroupsClient) Update(ctx context.Context, orgID, groupID string, group map[string]any) (map[string]any, error) {
	path := fmt.Sprintf("%s/%s", scimGroupsPath(orgID), url.PathEscape(groupID))
	var out map[string]any
	if err := g.c.put(ctx, path, group, &out); err != nil {
		return nil, fmt.Errorf("atlasent: scim.groups.update: %w", err)
	}
	return out, nil
}

// Delete deprovisions a SCIM group.
func (g *SCIMGroupsClient) Delete(ctx context.Context, orgID, groupID string) error {
	path := fmt.Sprintf("%s/%s", scimGroupsPath(orgID), url.PathEscape(groupID))
	resp, err := g.c.do(ctx, "DELETE", path, nil)
	if err != nil {
		return fmt.Errorf("atlasent: scim.groups.delete: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck
	if resp.StatusCode >= 400 {
		return apiError(resp)
	}
	return nil
}

// ─── helpers ─────────────────────────────────────────────────────────────────

func scimUsersPath(orgID string) string {
	return fmt.Sprintf("/scim/v2/%s/Users", url.PathEscape(orgID))
}

func scimGroupsPath(orgID string) string {
	return fmt.Sprintf("/scim/v2/%s/Groups", url.PathEscape(orgID))
}

func scimQueryString(filter string, startIndex, count int) string {
	params := url.Values{}
	if filter != "" {
		params.Set("filter", filter)
	}
	if startIndex > 0 {
		params.Set("startIndex", fmt.Sprintf("%d", startIndex))
	}
	if count > 0 {
		params.Set("count", fmt.Sprintf("%d", count))
	}
	if len(params) == 0 {
		return ""
	}
	return "?" + params.Encode()
}
