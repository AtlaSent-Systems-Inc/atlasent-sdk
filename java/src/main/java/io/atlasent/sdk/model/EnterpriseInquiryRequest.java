package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * Request body for the public {@code POST /v1/enterprise-inquiry} endpoint.
 *
 * <p>No API key is required for this call — use
 * {@link io.atlasent.sdk.AtlaSentClient#submitEnterpriseInquiry} as a static
 * helper from pre-auth marketing pages or sign-up flows.</p>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class EnterpriseInquiryRequest {

    @JsonProperty("company_name")
    private String companyName;

    @JsonProperty("company_size")
    private String companySize;

    @JsonProperty("industry")
    private String industry;

    @JsonProperty("use_cases")
    private List<String> useCases;

    @JsonProperty("contact_name")
    private String contactName;

    @JsonProperty("contact_email")
    private String contactEmail;

    /**
     * Intended deployment posture: {@code "saas"}, {@code "self_hosted"}, or
     * {@code "air_gapped"}.
     */
    @JsonProperty("deployment_posture")
    private String deploymentPosture;

    /** Optional free-text notes from the prospect. */
    @JsonProperty("notes")
    private String notes;

    public EnterpriseInquiryRequest() {}

    public String getCompanyName() { return companyName; }
    public void setCompanyName(String companyName) { this.companyName = companyName; }

    public String getCompanySize() { return companySize; }
    public void setCompanySize(String companySize) { this.companySize = companySize; }

    public String getIndustry() { return industry; }
    public void setIndustry(String industry) { this.industry = industry; }

    public List<String> getUseCases() { return useCases; }
    public void setUseCases(List<String> useCases) { this.useCases = useCases; }

    public String getContactName() { return contactName; }
    public void setContactName(String contactName) { this.contactName = contactName; }

    public String getContactEmail() { return contactEmail; }
    public void setContactEmail(String contactEmail) { this.contactEmail = contactEmail; }

    public String getDeploymentPosture() { return deploymentPosture; }
    public void setDeploymentPosture(String deploymentPosture) { this.deploymentPosture = deploymentPosture; }

    public String getNotes() { return notes; }
    public void setNotes(String notes) { this.notes = notes; }
}
