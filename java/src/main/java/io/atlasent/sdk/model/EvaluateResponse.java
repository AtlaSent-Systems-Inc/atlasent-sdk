package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response body from {@code POST /v1-evaluate}.
 *
 * <p>The {@link #decision} field is the authoritative outcome.
 * A {@code "deny"} decision is returned as a normal response, never thrown
 * as an exception — AtlaSent is fail-closed.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class EvaluateResponse {

    /**
     * Authorization decision: {@code "allow"}, {@code "deny"}, or {@code "hold"}.
     */
    @JsonProperty("decision")
    private String decision;

    /**
     * Single-use permit token ({@code pt_...}) issued when decision is {@code "allow"}.
     * Null on deny/hold.
     */
    @JsonProperty("permit_token")
    private String permitToken;

    /**
     * Unique request identifier for correlation with audit logs.
     */
    @JsonProperty("request_id")
    private String requestId;

    /**
     * ISO-8601 timestamp at which the permit token expires.
     * Null when no permit was issued.
     */
    @JsonProperty("expires_at")
    private String expiresAt;

    /**
     * Denial detail block — populated when decision is {@code "deny"} or {@code "hold"}.
     * Null on allow.
     */
    @JsonProperty("denial")
    private DenialDetail denial;

    public EvaluateResponse() {}

    public String getDecision() { return decision; }
    public void setDecision(String decision) { this.decision = decision; }

    public String getPermitToken() { return permitToken; }
    public void setPermitToken(String permitToken) { this.permitToken = permitToken; }

    public String getRequestId() { return requestId; }
    public void setRequestId(String requestId) { this.requestId = requestId; }

    public String getExpiresAt() { return expiresAt; }
    public void setExpiresAt(String expiresAt) { this.expiresAt = expiresAt; }

    public DenialDetail getDenial() { return denial; }
    public void setDenial(DenialDetail denial) { this.denial = denial; }

    /**
     * Returns {@code true} if the decision is {@code "allow"}.
     */
    public boolean isAllowed() {
        return "allow".equals(decision);
    }

    /**
     * Structured denial detail returned when a request is denied or held.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class DenialDetail {

        @JsonProperty("code")
        private String code;

        @JsonProperty("reason")
        private String reason;

        public DenialDetail() {}

        public String getCode() { return code; }
        public void setCode(String code) { this.code = code; }

        public String getReason() { return reason; }
        public void setReason(String reason) { this.reason = reason; }
    }
}
