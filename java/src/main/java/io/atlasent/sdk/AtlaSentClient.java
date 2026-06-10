package io.atlasent.sdk;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.atlasent.sdk.model.CreateRbacRuleRequest;
import io.atlasent.sdk.model.EnterpriseInquiryRequest;
import io.atlasent.sdk.model.EnterpriseInquiryResponse;
import io.atlasent.sdk.model.EvaluateRequest;
import io.atlasent.sdk.model.EvaluateResponse;
import io.atlasent.sdk.model.GetApprovalSlaResponse;
import io.atlasent.sdk.model.ListRbacRulesOptions;
import io.atlasent.sdk.model.ListRbacRulesResponse;
import io.atlasent.sdk.model.RbacRule;
import io.atlasent.sdk.model.VerifyPermitRequest;
import io.atlasent.sdk.model.VerifyPermitResponse;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HTTP client for the AtlaSent execution-time authorization API.
 *
 * <p>Wraps the AtlaSent REST API using Java 11's built-in
 * {@link java.net.http.HttpClient}. All network I/O is synchronous (blocking).
 * For async use, wrap calls in a {@link java.util.concurrent.CompletableFuture}
 * or submit them to an executor.</p>
 *
 * <h3>Fail-closed guarantee</h3>
 * <p>A clean policy DENY is returned as a normal {@link EvaluateResponse}
 * (never thrown). {@link AtlaSentException} is thrown only for network errors,
 * timeouts, non-2xx HTTP responses, and malformed JSON.</p>
 *
 * <h3>Quick start</h3>
 * <pre>{@code
 * AtlaSentClient client = new AtlaSentClient(
 *     AtlaSentClientOptions.builder()
 *         .apiKey("ask_live_...")
 *         .build()
 * );
 *
 * EvaluateRequest req = new EvaluateRequest(
 *     "production.deploy",
 *     "user_abc123",
 *     Map.of("environment", "prod")
 * );
 * EvaluateResponse resp = client.evaluate(req);
 *
 * if (!resp.isAllowed()) {
 *     throw new SecurityException("Action blocked: " + resp.getDecision());
 * }
 * // ... execute the protected action
 * }</pre>
 */
public class AtlaSentClient {

    private final String apiKey;
    private final String baseUrl;
    private final HttpClient httpClient;
    private final ObjectMapper mapper;

    /**
     * Constructs a new AtlaSentClient.
     *
     * @param options client configuration — must include a non-null API key
     */
    public AtlaSentClient(AtlaSentClientOptions options) {
        this.apiKey = options.getApiKey();
        this.baseUrl = options.getBaseUrl().replaceAll("/$", "");
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(options.getTimeoutSeconds()))
                .build();
        this.mapper = new ObjectMapper();
    }

    // -------------------------------------------------------------------------
    // Core authorization methods
    // -------------------------------------------------------------------------

    /**
     * Evaluates an authorization request and returns a decision.
     *
     * <p>Maps to {@code POST /v1-evaluate}. A DENY decision is returned
     * as a normal response, never thrown.</p>
     *
     * <p>Required scope: {@code evaluate:write}</p>
     *
     * @param request the evaluate request
     * @return the authorization decision response
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public EvaluateResponse evaluate(EvaluateRequest request) throws AtlaSentException {
        return post("/v1-evaluate", request, EvaluateResponse.class);
    }

    /**
     * Verifies a previously issued permit token.
     *
     * <p>Maps to {@code POST /v1-verify-permit}. Single-use: the token is
     * consumed on a successful verification. Gate on
     * {@link VerifyPermitResponse#isValid()} before executing the protected
     * action.</p>
     *
     * <p>Required scope: {@code verify:execute}</p>
     *
     * @param request the verify-permit request
     * @return the verification result
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public VerifyPermitResponse verifyPermit(VerifyPermitRequest request) throws AtlaSentException {
        return post("/v1-verify-permit", request, VerifyPermitResponse.class);
    }

    // -------------------------------------------------------------------------
    // RBAC rules
    // -------------------------------------------------------------------------

    /**
     * Lists dynamic RBAC rules for an organization.
     *
     * <p>Maps to {@code GET /v1/rbac-rules?org_id=...}</p>
     *
     * <p>Required scope: {@code rbac:read}</p>
     *
     * @param orgId   organization UUID
     * @param options optional pagination parameters (may be null)
     * @return paginated list of RBAC rules
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public ListRbacRulesResponse listRbacRules(String orgId, ListRbacRulesOptions options)
            throws AtlaSentException {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("org_id", orgId);
        if (options != null) {
            if (options.getLimit() != null) {
                params.put("limit", String.valueOf(options.getLimit()));
            }
            if (options.getOffset() != null) {
                params.put("offset", String.valueOf(options.getOffset()));
            }
            if (options.getCursor() != null) {
                params.put("cursor", options.getCursor());
            }
        }
        return get("/v1/rbac-rules", params, ListRbacRulesResponse.class);
    }

    /**
     * Creates a new dynamic RBAC rule.
     *
     * <p>Maps to {@code POST /v1/rbac-rules}.</p>
     *
     * <p>Required scope: {@code rbac:write}</p>
     *
     * @param request the rule definition
     * @return the created rule
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public RbacRule createRbacRule(CreateRbacRuleRequest request) throws AtlaSentException {
        // API returns { "rule": { ... } }
        RbacRuleEnvelope envelope = post("/v1/rbac-rules", request, RbacRuleEnvelope.class);
        return envelope.getRule();
    }

    /**
     * Deletes a dynamic RBAC rule by ID.
     *
     * <p>Maps to {@code DELETE /v1/rbac-rules/{id}}.</p>
     *
     * <p>Required scope: {@code rbac:write}</p>
     *
     * @param id the rule UUID
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public void deleteRbacRule(String id) throws AtlaSentException {
        delete("/v1/rbac-rules/" + id);
    }

    // -------------------------------------------------------------------------
    // Approval SLA
    // -------------------------------------------------------------------------

    /**
     * Retrieves approval SLA statistics for an organization.
     *
     * <p>Maps to {@code GET /v1/approvals/sla?org_id=...&days=...}.</p>
     *
     * <p>Required scope: {@code audit:read}</p>
     *
     * @param orgId organization UUID
     * @param days  look-back window in days (null uses server default of 30)
     * @return SLA statistics response
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public GetApprovalSlaResponse getApprovalSla(String orgId, Integer days) throws AtlaSentException {
        Map<String, String> params = new LinkedHashMap<>();
        params.put("org_id", orgId);
        if (days != null) {
            params.put("days", String.valueOf(days));
        }
        return get("/v1/approvals/sla", params, GetApprovalSlaResponse.class);
    }

    // -------------------------------------------------------------------------
    // Static: enterprise inquiry (no auth required)
    // -------------------------------------------------------------------------

    /**
     * Submits an enterprise enrollment inquiry without requiring an API key.
     *
     * <p>Maps to {@code POST /v1/enterprise-inquiry}. Intended for pre-auth
     * marketing pages or sign-up flows before the customer has been provisioned.</p>
     *
     * @param baseUrl the AtlaSent API base URL (e.g. {@code "https://api.atlasent.io"})
     * @param request inquiry form data
     * @return server-assigned inquiry ID and submission timestamp
     * @throws AtlaSentException on non-2xx response, network error, or parse failure
     */
    public static EnterpriseInquiryResponse submitEnterpriseInquiry(
            String baseUrl, EnterpriseInquiryRequest request) throws AtlaSentException {

        ObjectMapper staticMapper = new ObjectMapper();
        HttpClient staticClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();

        String url = baseUrl.replaceAll("/$", "") + "/v1/enterprise-inquiry";
        String body;
        try {
            body = staticMapper.writeValueAsString(request);
        } catch (JsonProcessingException e) {
            throw new AtlaSentException(0, "Failed to serialize EnterpriseInquiryRequest: " + e.getMessage(), e);
        }

        HttpRequest httpRequest = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        HttpResponse<String> response;
        try {
            response = staticClient.send(httpRequest, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AtlaSentException(0, "Network error during submitEnterpriseInquiry: " + e.getMessage(), e);
        }

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new AtlaSentException(
                    response.statusCode(),
                    "EnterpriseInquiry POST failed (" + response.statusCode() + "): " + response.body()
            );
        }

        try {
            return staticMapper.readValue(response.body(), EnterpriseInquiryResponse.class);
        } catch (JsonProcessingException e) {
            throw new AtlaSentException(
                    response.statusCode(),
                    "Failed to parse EnterpriseInquiryResponse: " + e.getMessage(), e
            );
        }
    }

    // -------------------------------------------------------------------------
    // Private HTTP helpers
    // -------------------------------------------------------------------------

    /**
     * Sends an authenticated POST request and parses the JSON response body.
     */
    <T> T post(String path, Object body, Class<T> responseType) throws AtlaSentException {
        String jsonBody;
        try {
            jsonBody = mapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new AtlaSentException(0, "Failed to serialize request: " + e.getMessage(), e);
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(jsonBody))
                .build();

        return sendAndParse(request, responseType);
    }

    /**
     * Sends an authenticated GET request with optional query parameters and
     * parses the JSON response body.
     */
    <T> T get(String path, Map<String, String> params, Class<T> responseType) throws AtlaSentException {
        String url = baseUrl + path;
        if (params != null && !params.isEmpty()) {
            url = url + "?" + buildQueryString(params);
        }

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Authorization", "Bearer " + apiKey)
                .GET()
                .build();

        return sendAndParse(request, responseType);
    }

    /**
     * Sends an authenticated DELETE request. Throws on non-2xx (including 404).
     */
    void delete(String path) throws AtlaSentException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl + path))
                .header("Authorization", "Bearer " + apiKey)
                .DELETE()
                .build();

        HttpResponse<String> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AtlaSentException(0, "Network error on DELETE " + path + ": " + e.getMessage(), e);
        }

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new AtlaSentException(
                    response.statusCode(),
                    "AtlaSent API error " + response.statusCode() + " on DELETE " + path + ": " + response.body()
            );
        }
    }

    private <T> T sendAndParse(HttpRequest request, Class<T> responseType) throws AtlaSentException {
        HttpResponse<String> response;
        try {
            response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (IOException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            throw new AtlaSentException(0, "Network error: " + e.getMessage(), e);
        }

        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new AtlaSentException(
                    response.statusCode(),
                    "AtlaSent API error " + response.statusCode() + ": " + response.body()
            );
        }

        try {
            return mapper.readValue(response.body(), responseType);
        } catch (JsonProcessingException e) {
            throw new AtlaSentException(
                    response.statusCode(),
                    "Failed to parse response as " + responseType.getSimpleName() + ": " + e.getMessage(), e
            );
        }
    }

    /**
     * Builds a URL-encoded query string from a map of parameters.
     * Keys and values are percent-encoded using {@link java.net.URLEncoder}.
     */
    static String buildQueryString(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (sb.length() > 0) {
                sb.append('&');
            }
            sb.append(encodeComponent(entry.getKey()))
              .append('=')
              .append(encodeComponent(entry.getValue()));
        }
        return sb.toString();
    }

    private static String encodeComponent(String value) {
        try {
            return java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20");
        } catch (java.io.UnsupportedEncodingException e) {
            // UTF-8 is always supported
            throw new IllegalStateException("UTF-8 not supported", e);
        }
    }

    // -------------------------------------------------------------------------
    // Internal response envelope types
    // -------------------------------------------------------------------------

    /**
     * Unwraps the {@code { "rule": {...} }} envelope returned by POST /v1/rbac-rules.
     */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
    private static class RbacRuleEnvelope {
        @com.fasterxml.jackson.annotation.JsonProperty("rule")
        private RbacRule rule;

        public RbacRule getRule() { return rule; }
        public void setRule(RbacRule rule) { this.rule = rule; }
    }
}
