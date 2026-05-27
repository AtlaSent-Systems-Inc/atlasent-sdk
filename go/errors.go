package atlasent

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// Error is the base error type for all AtlaSent SDK errors.
type Error struct {
	Message    string `json:"message"`
	Code       string `json:"code"`
	StatusCode int    `json:"-"`
	RequestID  string `json:"-"`
}

func (e *Error) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("atlasent: %s (code=%s)", e.Message, e.Code)
	}
	return "atlasent: " + e.Message
}

// DeniedError is returned by Protect when the action is denied.
type DeniedError struct {
	Decision     string
	EvaluationID string
	Reason       string
	AuditHash    string
}

func (e *DeniedError) Error() string {
	return fmt.Sprintf("atlasent: denied (decision=%s reason=%q)", e.Decision, e.Reason)
}

// IsDenied returns true if err is a *DeniedError.
func IsDenied(err error) bool {
	_, ok := err.(*DeniedError)
	return ok
}

func apiError(resp *http.Response) error {
	body, _ := io.ReadAll(resp.Body)
	var payload struct {
		Error   string `json:"error"`
		Message string `json:"message"`
		Code    string `json:"code"`
	}
	_ = json.Unmarshal(body, &payload)
	msg := payload.Error
	if msg == "" {
		msg = payload.Message
	}
	if msg == "" {
		msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return &Error{
		Message:    msg,
		Code:       payload.Code,
		StatusCode: resp.StatusCode,
		RequestID:  resp.Header.Get("X-Request-ID"),
	}
}
