package atlasent

import (
	"fmt"
	"time"
)

// ErrorCode is the coarse classification of an AtlaSentError.
type ErrorCode string

const (
	CodeInvalidAPIKey ErrorCode = "invalid_api_key"
	CodeForbidden     ErrorCode = "forbidden"
	CodeRateLimited   ErrorCode = "rate_limited"
	CodeTimeout       ErrorCode = "timeout"
	CodeNetwork       ErrorCode = "network"
	CodeBadResponse   ErrorCode = "bad_response"
	CodeBadRequest    ErrorCode = "bad_request"
	CodeServerError   ErrorCode = "server_error"
)

// AtlaSentError is the single error type returned by all client methods.
// Inspect Code to branch on cause; Status is 0 for transport-level failures.
type AtlaSentError struct {
	Code       ErrorCode
	Status     int
	Message    string
	RequestID  string
	RetryAfter *time.Duration // only set for rate_limited
}

func (e *AtlaSentError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("atlasent: %s (HTTP %d): %s", e.Code, e.Status, e.Message)
	}
	return fmt.Sprintf("atlasent: %s: %s", e.Code, e.Message)
}
