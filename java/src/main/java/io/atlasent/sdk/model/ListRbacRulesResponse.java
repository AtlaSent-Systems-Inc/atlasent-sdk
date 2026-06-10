package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * Response body from {@code GET /v1/rbac-rules}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ListRbacRulesResponse {

    @JsonProperty("rules")
    private List<RbacRule> rules;

    @JsonProperty("total")
    private int total;

    public ListRbacRulesResponse() {}

    public List<RbacRule> getRules() { return rules; }
    public void setRules(List<RbacRule> rules) { this.rules = rules; }

    public int getTotal() { return total; }
    public void setTotal(int total) { this.total = total; }
}
