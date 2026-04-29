package atlasent

import "testing"

// White-box test for wireDecisionToDenied. Lives in package atlasent (not
// atlasent_test) because the function is intentionally unexported —
// it's forward-compat machinery that v1 callers never trigger. v1 wire
// only carries permitted bool; the v2 wire is expected to carry the
// decision string explicitly, at which point integration tests will
// exercise the full path.
func TestWireDecisionToDenied(t *testing.T) {
	for _, tc := range []struct {
		input string
		want  Decision
	}{
		{"hold", DecisionHold},
		{"HOLD", DecisionHold},
		{"escalate", DecisionEscalate},
		{"ESCALATE", DecisionEscalate},
		{"DENY", DecisionDeny},
		{"deny", DecisionDeny},
		{"unknown_future_value", DecisionDeny}, // unknown → deny (fail closed)
		{"", DecisionDeny},
	} {
		got := wireDecisionToDenied(tc.input)
		if got != tc.want {
			t.Errorf("wireDecisionToDenied(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

// lowercaseASCII is the ASCII helper backing wireDecisionToDenied.
// White-box-tested for parity with strings.ToLower on the ASCII subset
// the v1/v2 enums use.
func TestLowercaseASCII(t *testing.T) {
	for _, tc := range []struct {
		in, want string
	}{
		{"DENY", "deny"},
		{"hold", "hold"},
		{"MixedCASE", "mixedcase"},
		{"", ""},
		{"a1B2", "a1b2"}, // digits + bytes outside [A-Z] pass through
	} {
		if got := lowercaseASCII(tc.in); got != tc.want {
			t.Errorf("lowercaseASCII(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
