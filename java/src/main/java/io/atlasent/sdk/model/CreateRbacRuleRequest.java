package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * Request body for {@code POST /v1/rbac-rules}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class CreateRbacRuleRequest {

    @JsonProperty("org_id")
    private String orgId;

    @JsonProperty("role")
    private String role;

    /**
     * Condition object. Must include a {@code "type"} key identifying the
     * condition family: {@code "time_window"}, {@code "environment"}, or
     * {@code "risk_score"}.
     */
    @JsonProperty("condition")
    private Map<String, Object> condition;

    /**
     * Effect when condition matches: {@code "restrict"} or {@code "allow_additional"}.
     */
    @JsonProperty("effect")
    private String effect;

    public CreateRbacRuleRequest() {}

    public CreateRbacRuleRequest(String orgId, String role, Map<String, Object> condition, String effect) {
        this.orgId = orgId;
        this.role = role;
        this.condition = condition;
        this.effect = effect;
    }

    public String getOrgId() { return orgId; }
    public void setOrgId(String orgId) { this.orgId = orgId; }

    public String getRole() { return role; }
    public void setRole(String role) { this.role = role; }

    public Map<String, Object> getCondition() { return condition; }
    public void setCondition(Map<String, Object> condition) { this.condition = condition; }

    public String getEffect() { return effect; }
    public void setEffect(String effect) { this.effect = effect; }
}
