package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response body from {@code POST /v1/enterprise-inquiry}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class EnterpriseInquiryResponse {

    @JsonProperty("id")
    private String id;

    @JsonProperty("submitted_at")
    private String submittedAt;

    public EnterpriseInquiryResponse() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getSubmittedAt() { return submittedAt; }
    public void setSubmittedAt(String submittedAt) { this.submittedAt = submittedAt; }
}
