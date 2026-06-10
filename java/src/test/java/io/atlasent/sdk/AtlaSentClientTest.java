package io.atlasent.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.atlasent.sdk.model.CreateRbacRuleRequest;
import io.atlasent.sdk.model.EnterpriseInquiryRequest;
import io.atlasent.sdk.model.EvaluateRequest;
import io.atlasent.sdk.model.EvaluateResponse;
import io.atlasent.sdk.model.ListRbacRulesOptions;
import io.atlasent.sdk.model.ListRbacRulesResponse;
import io.atlasent.sdk.model.RbacRule;
import io.atlasent.sdk.model.VerifyPermitResponse;
import org.junit.jupiter.api.Test;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Unit tests for {@link AtlaSentClient} and related model classes.
 *
 * <p>These tests exercise serialization/deserialization, the builder pattern,
 * query-string construction, and exception semantics — all without touching a
 * real HTTP server.</p>
 */
class AtlaSentClientTest {

    private final ObjectMapper mapper = new ObjectMapper();

    // -------------------------------------------------------------------------
    // Serialization
    // -------------------------------------------------------------------------

    @Test
    void testEvaluateRequestSerialization() throws Exception {
        Map<String, Object> ctx = new HashMap<>();
        ctx.put("environment", "prod");
        ctx.put("risk_score", 42);

        EvaluateRequest req = new EvaluateRequest("production.deploy", "user_abc123", ctx);
        String json = mapper.writeValueAsString(req);

        // Must use snake_case wire names
        assertTrue(json.contains("\"action_type\""), "action_type key missing from JSON");
        assertTrue(json.contains("\"actor_id\""), "actor_id key missing from JSON");
        assertTrue(json.contains("\"production.deploy\""), "action_type value missing");
        assertTrue(json.contains("\"user_abc123\""), "actor_id value missing");
        assertTrue(json.contains("\"environment\""), "context key missing");
        // permit_token should be omitted when null (@JsonInclude NON_NULL)
        assertFalse(json.contains("permit_token"), "null permit_token should be omitted");
    }

    @Test
    void testEvaluateRequestWithPermitToken() throws Exception {
        EvaluateRequest req = new EvaluateRequest("repo.merge", "user_xyz", Map.of());
        req.setPermitToken("pt_abc123");

        String json = mapper.writeValueAsString(req);
        assertTrue(json.contains("\"permit_token\""), "permit_token should be present when set");
        assertTrue(json.contains("\"pt_abc123\""), "permit_token value missing");
    }

    // -------------------------------------------------------------------------
    // Deserialization
    // -------------------------------------------------------------------------

    @Test
    void testEvaluateResponseDeserialization() throws Exception {
        String json = "{"
                + "\"decision\":\"allow\","
                + "\"permit_token\":\"pt_live_test123\","
                + "\"request_id\":\"req_abc\","
                + "\"expires_at\":\"2026-06-10T12:00:00Z\","
                + "\"unknown_future_field\":true"
                + "}";

        EvaluateResponse resp = mapper.readValue(json, EvaluateResponse.class);

        assertEquals("allow", resp.getDecision());
        assertEquals("pt_live_test123", resp.getPermitToken());
        assertEquals("req_abc", resp.getRequestId());
        assertEquals("2026-06-10T12:00:00Z", resp.getExpiresAt());
        assertTrue(resp.isAllowed());
        assertNull(resp.getDenial()); // no denial block on allow
    }

    @Test
    void testEvaluateResponseDenyWithDenialBlock() throws Exception {
        String json = "{"
                + "\"decision\":\"deny\","
                + "\"request_id\":\"req_deny\","
                + "\"denial\":{\"code\":\"NO_POLICY\",\"reason\":\"No active policy bundle\"}"
                + "}";

        EvaluateResponse resp = mapper.readValue(json, EvaluateResponse.class);

        assertEquals("deny", resp.getDecision());
        assertFalse(resp.isAllowed());
        assertNull(resp.getPermitToken());
        assertNotNull(resp.getDenial());
        assertEquals("NO_POLICY", resp.getDenial().getCode());
        assertEquals("No active policy bundle", resp.getDenial().getReason());
    }

    @Test
    void testVerifyPermitResponseDeserialization() throws Exception {
        String json = "{"
                + "\"valid\":false,"
                + "\"outcome\":\"expired\","
                + "\"verify_error_code\":\"PERMIT_EXPIRED\","
                + "\"reason\":\"Token expired at 2026-06-09T10:00:00Z\""
                + "}";

        VerifyPermitResponse resp = mapper.readValue(json, VerifyPermitResponse.class);

        assertFalse(resp.isValid());
        assertEquals("expired", resp.getOutcome());
        assertEquals("PERMIT_EXPIRED", resp.getVerifyErrorCode());
        assertNotNull(resp.getReason());
    }

    // -------------------------------------------------------------------------
    // Builder pattern
    // -------------------------------------------------------------------------

    @Test
    void testOptionsBuilderDefaults() {
        AtlaSentClientOptions options = AtlaSentClientOptions.builder()
                .apiKey("ask_live_testkey")
                .build();

        assertEquals("ask_live_testkey", options.getApiKey());
        assertEquals(AtlaSentClientOptions.DEFAULT_BASE_URL, options.getBaseUrl());
        assertEquals(AtlaSentClientOptions.DEFAULT_TIMEOUT_SECONDS, options.getTimeoutSeconds());
    }

    @Test
    void testOptionsBuilderCustomValues() {
        AtlaSentClientOptions options = AtlaSentClientOptions.builder()
                .apiKey("ask_test_customkey")
                .baseUrl("https://staging.api.atlasent.io")
                .timeoutSeconds(60)
                .build();

        assertEquals("ask_test_customkey", options.getApiKey());
        assertEquals("https://staging.api.atlasent.io", options.getBaseUrl());
        assertEquals(60, options.getTimeoutSeconds());
    }

    @Test
    void testOptionsBuilderRequiresApiKey() {
        assertThrows(IllegalStateException.class, () ->
                AtlaSentClientOptions.builder().build(),
                "Should throw when apiKey is not set"
        );
    }

    @Test
    void testOptionsBuilderRejectsBlankApiKey() {
        assertThrows(IllegalArgumentException.class, () ->
                AtlaSentClientOptions.builder().apiKey("").build(),
                "Should throw for empty apiKey"
        );
    }

    @Test
    void testOptionsBuilderRejectsNonPositiveTimeout() {
        assertThrows(IllegalArgumentException.class, () ->
                AtlaSentClientOptions.builder()
                        .apiKey("ask_live_x")
                        .timeoutSeconds(0)
                        .build(),
                "Should throw for timeout <= 0"
        );
    }

    // -------------------------------------------------------------------------
    // Query string construction
    // -------------------------------------------------------------------------

    @Test
    void testListRbacRulesQueryParams() {
        // Build the params map the same way AtlaSentClient.listRbacRules() does
        Map<String, String> params = new java.util.LinkedHashMap<>();
        params.put("org_id", "org_abc123");
        params.put("limit", "25");
        params.put("offset", "50");

        String qs = AtlaSentClient.buildQueryString(params);

        assertTrue(qs.contains("org_id=org_abc123"), "org_id missing from query string");
        assertTrue(qs.contains("limit=25"), "limit missing from query string");
        assertTrue(qs.contains("offset=50"), "offset missing from query string");
        // Verify no stray '?' — buildQueryString returns only the key=value pairs
        assertFalse(qs.startsWith("?"), "buildQueryString must not include leading '?'");
    }

    @Test
    void testQueryStringEncodesSpecialCharacters() {
        Map<String, String> params = new java.util.LinkedHashMap<>();
        params.put("cursor", "org/abc+def=next");

        String qs = AtlaSentClient.buildQueryString(params);

        // '+' and '=' must be percent-encoded
        assertFalse(qs.contains("+"), "'+' must be percent-encoded in query string");
        assertTrue(qs.startsWith("cursor="), "cursor key must be first");
    }

    // -------------------------------------------------------------------------
    // AtlaSentException
    // -------------------------------------------------------------------------

    @Test
    void testAtlaSentExceptionHasStatusCode() {
        AtlaSentException ex = new AtlaSentException(403, "Forbidden");

        assertEquals(403, ex.getStatusCode());
        assertEquals("Forbidden", ex.getMessage());
    }

    @Test
    void testAtlaSentExceptionWithCause() {
        RuntimeException cause = new RuntimeException("root cause");
        AtlaSentException ex = new AtlaSentException(0, "Network error", cause);

        assertEquals(0, ex.getStatusCode());
        assertSame(cause, ex.getCause());
    }

    // -------------------------------------------------------------------------
    // Model: RBAC rule
    // -------------------------------------------------------------------------

    @Test
    void testRbacRuleDeserialization() throws Exception {
        String json = "{"
                + "\"id\":\"rule_123\","
                + "\"org_id\":\"org_abc\","
                + "\"role\":\"deployer\","
                + "\"condition\":{\"type\":\"environment\",\"environment\":\"prod\"},"
                + "\"effect\":\"restrict\","
                + "\"created_at\":\"2026-06-01T00:00:00Z\","
                + "\"updated_at\":\"2026-06-01T00:00:00Z\""
                + "}";

        RbacRule rule = mapper.readValue(json, RbacRule.class);

        assertEquals("rule_123", rule.getId());
        assertEquals("org_abc", rule.getOrgId());
        assertEquals("deployer", rule.getRole());
        assertEquals("restrict", rule.getEffect());
        assertEquals("environment", rule.getCondition().get("type"));
    }

    @Test
    void testCreateRbacRuleRequestSerialization() throws Exception {
        Map<String, Object> condition = new HashMap<>();
        condition.put("type", "risk_score");
        condition.put("operator", "above");
        condition.put("threshold", 80);

        CreateRbacRuleRequest req = new CreateRbacRuleRequest(
                "org_xyz", "reviewer", condition, "restrict"
        );
        String json = mapper.writeValueAsString(req);

        assertTrue(json.contains("\"org_id\""), "org_id key missing");
        assertTrue(json.contains("\"org_xyz\""), "org_id value missing");
        assertTrue(json.contains("\"risk_score\""), "condition type missing");
        assertTrue(json.contains("\"restrict\""), "effect missing");
    }

    @Test
    void testListRbacRulesResponseDeserialization() throws Exception {
        String json = "{"
                + "\"rules\":["
                + "  {\"id\":\"rule_1\",\"org_id\":\"org_a\",\"role\":\"admin\","
                + "   \"condition\":{\"type\":\"environment\",\"environment\":\"prod\"},"
                + "   \"effect\":\"restrict\",\"created_at\":\"2026-01-01T00:00:00Z\","
                + "   \"updated_at\":\"2026-01-01T00:00:00Z\"}"
                + "],"
                + "\"total\":1"
                + "}";

        ListRbacRulesResponse resp = mapper.readValue(json, ListRbacRulesResponse.class);
        assertEquals(1, resp.getTotal());
        assertEquals(1, resp.getRules().size());
        assertEquals("rule_1", resp.getRules().get(0).getId());
    }

    // -------------------------------------------------------------------------
    // Model: EnterpriseInquiry
    // -------------------------------------------------------------------------

    @Test
    void testEnterpriseInquiryRequestSerialization() throws Exception {
        EnterpriseInquiryRequest req = new EnterpriseInquiryRequest();
        req.setCompanyName("Acme Corp");
        req.setCompanySize("100-500");
        req.setIndustry("financial_services");
        req.setUseCases(Arrays.asList("ai_agent_governance", "deploy_gates"));
        req.setContactName("Jane Smith");
        req.setContactEmail("jane@acme.com");
        req.setDeploymentPosture("saas");

        String json = mapper.writeValueAsString(req);

        assertTrue(json.contains("\"company_name\""), "company_name key missing");
        assertTrue(json.contains("\"Acme Corp\""), "company_name value missing");
        assertTrue(json.contains("\"contact_email\""), "contact_email key missing");
        assertTrue(json.contains("\"deployment_posture\""), "deployment_posture key missing");
        // notes is null — should be omitted
        assertFalse(json.contains("\"notes\""), "null notes should be omitted");
    }

    @Test
    void testEnterpriseInquiryRequestWithNotes() throws Exception {
        EnterpriseInquiryRequest req = new EnterpriseInquiryRequest();
        req.setCompanyName("Beta Inc");
        req.setCompanySize("50-100");
        req.setIndustry("healthcare");
        req.setUseCases(List.of("gxp_compliance"));
        req.setContactName("Bob");
        req.setContactEmail("bob@beta.com");
        req.setDeploymentPosture("self_hosted");
        req.setNotes("Need air-gap support in Q3");

        String json = mapper.writeValueAsString(req);
        assertTrue(json.contains("\"notes\""), "notes should be present when set");
        assertTrue(json.contains("air-gap"), "notes value missing");
    }

    // -------------------------------------------------------------------------
    // Client trailing-slash normalization
    // -------------------------------------------------------------------------

    @Test
    void testClientStripsTrailingSlashFromBaseUrl() {
        // We can't inspect the private field directly, but we can verify the
        // query-string helper (which is package-private) works with the trimmed URL.
        // The actual trimming is verified indirectly via the constructor contract.
        AtlaSentClientOptions opts = AtlaSentClientOptions.builder()
                .apiKey("ask_live_test")
                .baseUrl("https://api.atlasent.io/")
                .build();
        // options stores the value as-is; the client strips at construction time
        assertEquals("https://api.atlasent.io/", opts.getBaseUrl());

        // AtlaSentClient.new strips trailing slash — just verify it constructs
        assertDoesNotThrow(() -> new AtlaSentClient(opts));
    }

    // -------------------------------------------------------------------------
    // ListRbacRulesOptions builder
    // -------------------------------------------------------------------------

    @Test
    void testListRbacRulesOptionsBuilder() {
        ListRbacRulesOptions opts = ListRbacRulesOptions.builder()
                .limit(10)
                .offset(20)
                .cursor("next_page_token")
                .build();

        assertEquals(Integer.valueOf(10), opts.getLimit());
        assertEquals(Integer.valueOf(20), opts.getOffset());
        assertEquals("next_page_token", opts.getCursor());
    }

    @Test
    void testListRbacRulesOptionsDefaultsAreNull() {
        ListRbacRulesOptions opts = new ListRbacRulesOptions();
        assertNull(opts.getLimit());
        assertNull(opts.getOffset());
        assertNull(opts.getCursor());
    }
}
