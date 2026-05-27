package atlasent_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/atlasent-systems-inc/atlasent-sdk/go/v2"
)

func newTestClient(t *testing.T, mux *http.ServeMux) *atlasent.Client {
	t.Helper()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return atlasent.New(atlasent.Options{
		APIKey:  "ask_test_testkey123",
		BaseURL: srv.URL,
	})
}

func TestProtect_Allow(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1-evaluate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"decision":     "allow",
			"permit_token": "tok_abc",
			"audit_hash":   "deadbeef",
			"reason":       "policy allows",
		})
	})
	mux.HandleFunc("/v1-verify-permit", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"valid":       true,
			"permit_hash": "hashxyz",
			"timestamp":   "2026-05-27T00:00:00Z",
		})
	})

	client := newTestClient(t, mux)
	permit, err := client.Protect(context.Background(), atlasent.ProtectRequest{
		Agent:  "test-agent",
		Action: "production.deploy",
		Context: map[string]any{"environment": "production"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if permit.PermitID != "tok_abc" {
		t.Errorf("PermitID = %q, want %q", permit.PermitID, "tok_abc")
	}
}

func TestProtect_Deny(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1-evaluate", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"decision": "deny",
			"reason":   "insufficient approval",
		})
	})

	client := newTestClient(t, mux)
	_, err := client.Protect(context.Background(), atlasent.ProtectRequest{
		Agent:  "test-agent",
		Action: "production.deploy",
	})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if !atlasent.IsDenied(err) {
		t.Errorf("expected DeniedError, got %T: %v", err, err)
	}
}

func TestNew_PanicsWithoutAPIKey(t *testing.T) {
	deferred := func() {
		r := recover()
		if r == nil {
			t.Error("expected panic, got none")
		}
	}
	defer deferred()
	atlasent.New(atlasent.Options{})
}

func TestEvidenceBundles_Create(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/evidence-bundles", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"bundle_id":   "bnd_123",
			"org_id":      "org_xyz",
			"incident_id": "inc_abc",
			"status":      "pending",
			"created_at":  "2026-05-27T00:00:00Z",
		})
	})

	client := newTestClient(t, mux)
	bundle, err := client.EvidenceBundles.Create(context.Background(), atlasent.EvidenceBundleCreateRequest{
		IncidentID: "inc_abc",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bundle.BundleID != "bnd_123" {
		t.Errorf("BundleID = %q, want %q", bundle.BundleID, "bnd_123")
	}
}

func TestSCIM_Users_List(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/scim/v2/org_xyz/Users", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"totalResults": 1,
			"startIndex":   1,
			"itemsPerPage": 1,
			"Resources": []map[string]any{
				{"id": "usr_1", "userName": "alice@example.com"},
			},
		})
	})

	client := newTestClient(t, mux)
	resp, err := client.SCIM.Users.List(context.Background(), atlasent.SCIMListParams{
		OrgID: "org_xyz",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.TotalResults != 1 {
		t.Errorf("TotalResults = %d, want 1", resp.TotalResults)
	}
}

func TestAuth_RefreshWithIdP(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/auth/idp/idp_okta/token/refresh", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
			"access_token":  "new_access",
			"refresh_token": "new_refresh",
			"token_type":    "Bearer",
			"expires_in":    3600,
			"idp_id":        "idp_okta",
		})
	})

	client := newTestClient(t, mux)
	tokens, err := client.Auth.RefreshWithIdP(context.Background(), "idp_okta", "old_refresh")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if tokens.AccessToken != "new_access" {
		t.Errorf("AccessToken = %q, want %q", tokens.AccessToken, "new_access")
	}
}
