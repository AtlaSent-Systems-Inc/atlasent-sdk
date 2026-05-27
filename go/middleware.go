package atlasent

import (
	"context"
	"encoding/json"
	"net/http"
)

type contextKey string

// PermitContextKey is the context key under which the Permit is stored
// after a successful Protect call.
const PermitContextKey contextKey = "atlasent_permit"

// MiddlewareOptions configures Middleware behaviour.
type MiddlewareOptions struct {
	// ActionFn returns the action name for a given request.
	// If nil, the "X-AtlaSent-Action" header is used.
	ActionFn func(r *http.Request) string
	// SubjectFn returns the subject for a given request.
	// If nil, the "X-AtlaSent-Subject" header is used.
	SubjectFn func(r *http.Request) string
	// OnDeny is called before writing the 403 response.
	OnDeny func(r *http.Request, err *DeniedError)
}

// Middleware returns an http.Handler middleware that calls Protect before
// passing the request to next. On deny it writes 403 JSON. On success it
// injects the Permit into the request context under PermitContextKey.
func (c *Client) Middleware(opts *MiddlewareOptions) func(http.Handler) http.Handler {
	if opts == nil {
		opts = &MiddlewareOptions{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			action := r.Header.Get("X-AtlaSent-Action")
			if opts.ActionFn != nil {
				action = opts.ActionFn(r)
			}
			subject := r.Header.Get("X-AtlaSent-Subject")
			if opts.SubjectFn != nil {
				subject = opts.SubjectFn(r)
			}

			permit, err := c.Protect(r.Context(), ProtectRequest{
				Action: action,
				Agent:  subject,
			})
			if err != nil {
				w.Header().Set("Content-Type", "application/json")
				if denied, ok := err.(*DeniedError); ok {
					if opts.OnDeny != nil {
						opts.OnDeny(r, denied)
					}
					w.WriteHeader(http.StatusForbidden)
					json.NewEncoder(w).Encode(map[string]string{ //nolint:errcheck
						"error":         "denied",
						"reason":        denied.Reason,
						"evaluation_id": denied.EvaluationID,
					})
					return
				}
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(map[string]string{"error": "internal"}) //nolint:errcheck
				return
			}

			ctx := context.WithValue(r.Context(), PermitContextKey, permit)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
