package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Request body for {@code POST /v1-verify-permit}.
 *
 * <p>Verifies that a previously issued permit token is valid, unexpired,
 * and matches the expected action type and actor. Single-use: the token
 * is consumed on a successful verify.</p>
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class VerifyPermitRequest {

    @JsonProperty("permit_token")
    private String permitToken;

    @JsonProperty("action_type")
    private String actionType;

    @JsonProperty("actor_id")
    private String actorId;

    public VerifyPermitRequest() {}

    public VerifyPermitRequest(String permitToken, String actionType, String actorId) {
        this.permitToken = permitToken;
        this.actionType = actionType;
        this.actorId = actorId;
    }

    public String getPermitToken() { return permitToken; }
    public void setPermitToken(String permitToken) { this.permitToken = permitToken; }

    public String getActionType() { return actionType; }
    public void setActionType(String actionType) { this.actionType = actionType; }

    public String getActorId() { return actorId; }
    public void setActorId(String actorId) { this.actorId = actorId; }
}
