package atlasent

import (
	"context"
	"fmt"
	"net/url"
)

// EvidenceBundle represents a compliance evidence bundle.
type EvidenceBundle struct {
	BundleID       string         `json:"bundle_id"`
	OrgID          string         `json:"org_id"`
	IncidentID     string         `json:"incident_id"`
	Status         string         `json:"status"`
	IncludedPermits []string       `json:"included_permits"`
	IncludeOverrides bool         `json:"include_overrides"`
	Format         string         `json:"format"`
	CreatedAt      string         `json:"created_at"`
	ExpiresAt      string         `json:"expires_at"`
	DownloadURL    string         `json:"download_url,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
}

// EvidenceBundleCreateRequest is the input to EvidenceBundles.Create.
type EvidenceBundleCreateRequest struct {
	// IncidentID is the incident or investigation ID this bundle belongs to.
	IncidentID string `json:"incident_id"`
	// IncludedPermits filters which permits to include in the bundle.
	// When empty, all permits for the incident are included.
	IncludedPermits []string `json:"included_permits,omitempty"`
	// IncludeOverrides controls whether override events are included.
	IncludeOverrides bool `json:"include_overrides,omitempty"`
}

// EvidenceBundleClient wraps the /v1/evidence-bundles endpoints.
type EvidenceBundleClient struct {
	c *Client
}

// Create creates a new evidence bundle for the given incident.
//
//	bundle, err := client.EvidenceBundles.Create(ctx, atlasent.EvidenceBundleCreateRequest{
//		IncidentID:       "inc_abc123",
//		IncludeOverrides: true,
//	})
func (e *EvidenceBundleClient) Create(ctx context.Context, req EvidenceBundleCreateRequest) (EvidenceBundle, error) {
	var bundle EvidenceBundle
	if err := e.c.post(ctx, "/v1/evidence-bundles", req, &bundle); err != nil {
		return EvidenceBundle{}, fmt.Errorf("atlasent: evidence_bundles.create: %w", err)
	}
	return bundle, nil
}

// Get retrieves an evidence bundle by ID.
func (e *EvidenceBundleClient) Get(ctx context.Context, bundleID string) (EvidenceBundle, error) {
	if bundleID == "" {
		return EvidenceBundle{}, &Error{Message: "bundleID is required", Code: "bad_request"}
	}
	var bundle EvidenceBundle
	path := fmt.Sprintf("/v1/evidence-bundles/%s", url.PathEscape(bundleID))
	if err := e.c.get(ctx, path, &bundle); err != nil {
		return EvidenceBundle{}, fmt.Errorf("atlasent: evidence_bundles.get: %w", err)
	}
	return bundle, nil
}

// Download downloads the evidence bundle in the requested format.
// Supported formats: "json", "pdf".
func (e *EvidenceBundleClient) Download(ctx context.Context, bundleID, format string) ([]byte, error) {
	if bundleID == "" {
		return nil, &Error{Message: "bundleID is required", Code: "bad_request"}
	}
	if format == "" {
		format = "json"
	}
	path := fmt.Sprintf("/v1/evidence-bundles/%s/download?format=%s",
		url.PathEscape(bundleID), url.QueryEscape(format))
	data, err := e.c.getBytes(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("atlasent: evidence_bundles.download: %w", err)
	}
	return data, nil
}
