package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/**
 * Request body for {@code POST /v1-evaluate}.
 *
 * <p>Mirror of the TypeScript {@code EvaluateRequest} wire type.</p>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class EvaluateRequest {

    @JsonProperty("action_type")
    private String actionType;

    @JsonProperty("actor_id")
    private String actorId;

    @JsonProperty("context")
    private Map<String, Object> context;

    /**
     * Optional: supply a previously issued permit token to re-verify
     * without re-evaluating the full policy. When present the API
     * verifies the token and returns the same decision.
     */
    @JsonProperty("permit_token")
    private String permitToken;

    public EvaluateRequest() {}

    public EvaluateRequest(String actionType, String actorId, Map<String, Object> context) {
        this.actionType = actionType;
        this.actorId = actorId;
        this.context = context;
    }

    public String getActionType() { return actionType; }
    public void setActionType(String actionType) { this.actionType = actionType; }

    public String getActorId() { return actorId; }
    public void setActorId(String actorId) { this.actorId = actorId; }

    public Map<String, Object> getContext() { return context; }
    public void setContext(Map<String, Object> context) { this.context = context; }

    public String getPermitToken() { return permitToken; }
    public void setPermitToken(String permitToken) { this.permitToken = permitToken; }
}
