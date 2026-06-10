package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * A dynamic RBAC rule scoped to an organization.
 *
 * <p>Rules layer conditional restrictions or expansions on top of the base
 * role-permission matrix. A rule fires when its {@link #condition} evaluates
 * to true at evaluation time; the {@link #effect} controls whether it
 * restricts ({@code "restrict"}) or expands ({@code "allow_additional"}) access.</p>
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class RbacRule {

    @JsonProperty("id")
    private String id;

    @JsonProperty("org_id")
    private String orgId;

    @JsonProperty("role")
    private String role;

    /**
     * Condition object. The {@code "type"} key identifies the condition family:
     * {@code "time_window"}, {@code "environment"}, or {@code "risk_score"}.
     */
    @JsonProperty("condition")
    private Map<String, Object> condition;

    /**
     * Effect when condition matches: {@code "restrict"} or {@code "allow_additional"}.
     */
    @JsonProperty("effect")
    private String effect;

    @JsonProperty("created_at")
    private String createdAt;

    @JsonProperty("updated_at")
    private String updatedAt;

    public RbacRule() {}

    public String getId() { return id; }
    public void setId(String id) { this.id = id; }

    public String getOrgId() { return orgId; }
    public void setOrgId(String orgId) { this.orgId = orgId; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public Map<String, Object> getCondition() { return condition; }
    public void setCondition(Map<String, Object> condition) { this.condition = condition; }

    public String getEffect() { return effect; }
    public void setEffect(String effect) { this.effect = effect; }

    public String getCreatedAt() { return createdAt; }
    public void setCreatedAt(String createdAt) { this.createdAt = createdAt; }

    public String getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(String updatedAt) { this.updatedAt = updatedAt; }
}
