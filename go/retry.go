package atlasent

import (
	"math"
	"math/rand"
	"time"
)

// RetryPolicy controls how the client retries transient failures.
// Zero values for numeric fields fall back to the defaults.
type RetryPolicy struct {
	// MaxAttempts is the total number of tries including the first.
	// 1 disables retries entirely. Default: 3.
	MaxAttempts int
	// BaseDelay is the initial back-off duration. Default: 250ms.
	BaseDelay time.Duration
	// MaxDelay caps the per-attempt sleep before jitter. Default: 7s.
	MaxDelay time.Duration
}

// OnRetryContext is passed to Options.OnRetry before each retry sleep.
type OnRetryContext struct {
	// Attempt is zero-indexed: 0 before the second try, 1 before the third, …
	Attempt int
	// Error is the error that caused the retry.
	Error error
	// Delay is how long the client will sleep before the next attempt.
	Delay time.Duration
	// Path is the API path that was called (e.g. "/v1-evaluate").
	Path string
}

var defaultPolicy = RetryPolicy{
	MaxAttempts: 3,
	BaseDelay:   250 * time.Millisecond,
	MaxDelay:    7 * time.Second,
}

func mergePolicy(p RetryPolicy) RetryPolicy {
	if p.MaxAttempts < 1 {
		p.MaxAttempts = defaultPolicy.MaxAttempts
	}
	if p.BaseDelay <= 0 {
		p.BaseDelay = defaultPolicy.BaseDelay
	}
	if p.MaxDelay <= 0 {
		p.MaxDelay = defaultPolicy.MaxDelay
	}
	if p.MaxDelay < p.BaseDelay {
		p.MaxDelay = p.BaseDelay
	}
	return p
}

// isRetryable reports whether err warrants a retry.
// Only AtlaSentErrors with transient codes are retried; anything else
// (including programmer errors from bad inputs) propagates immediately.
func isRetryable(err error) bool {
	aerr, ok := err.(*AtlaSentError)
	if !ok {
		return false
	}
	switch aerr.Code {
	case CodeNetwork, CodeTimeout, CodeRateLimited, CodeServerError, CodeBadResponse:
		return true
	}
	return false
}

// computeBackoff returns how long to sleep before retry attempt (0-indexed).
// Uses capped-exponential full-jitter backoff (AWS recommended scheme).
// If err carries a Retry-After hint it is used as a floor.
func computeBackoff(attempt int, policy RetryPolicy, err error) time.Duration {
	exp := attempt
	if exp > 30 {
		exp = 30
	}
	ceiling := time.Duration(math.Min(
		float64(policy.MaxDelay),
		float64(policy.BaseDelay)*math.Pow(2, float64(exp)),
	))
	jittered := time.Duration(rand.Float64() * float64(ceiling))

	if aerr, ok := err.(*AtlaSentError); ok && aerr.RetryAfter != nil && *aerr.RetryAfter > jittered {
		return *aerr.RetryAfter
	}
	return jittered
}
