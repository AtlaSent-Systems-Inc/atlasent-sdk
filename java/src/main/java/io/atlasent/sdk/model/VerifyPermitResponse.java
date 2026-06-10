package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response body from {@code POST /v1-verify-permit}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class VerifyPermitResponse {

    /**
     * Whether the permit token passed all verification checks.
     * Gate on this field before executing the protected action.
     */
    @JsonProperty("valid")
    private boolean valid;

    /**
     * Outcome string: {@code "verified"}, {@code "denied"}, {@code "expired"},
     * {@code "not_found"}, or {@code "error"}.
     */
    @JsonProperty("outcome")
    private String outcome;

    /**
     * Machine-readable error code when verification fails.
     * Null on success.
     */
    @JsonProperty("verify_error_code")
    private String verifyErrorCode;

    /**
     * Human-readable reason for failed verification.
     * Null on success.
     */
    @JsonProperty("reason")
    private String reason;

    public VerifyPermitResponse() {}

    public boolean isValid() { return valid; }
    public void setValid(boolean valid) { this.valid = valid; }

    public String getOutcome() { return outcome; }
    public void setOutcome(String outcome) { this.outcome = outcome; }

    public String getVerifyErrorCode() { return verifyErrorCode; }
    public void setVerifyErrorCode(String verifyErrorCode) { this.verifyErrorCode = verifyErrorCode; }

    public String getReason() { return reason; }
    public void setReason(String reason) { this.reason = reason; }
}
