package io.atlasent.sdk;

/**
 * Configuration options for {@link AtlaSentClient}.
 *
 * <p>Use the {@link Builder} to construct instances:</p>
 * <pre>{@code
 * AtlaSentClientOptions options = AtlaSentClientOptions.builder()
 *     .apiKey("ask_live_...")
 *     .baseUrl("https://api.atlasent.io")
 *     .timeoutSeconds(30)
 *     .build();
 * }</pre>
 */
public final class AtlaSentClientOptions {

    /** Default base URL for the AtlaSent hosted API. */
    public static final String DEFAULT_BASE_URL = "https://api.atlasent.io";

    /** Default HTTP connect/request timeout in seconds. */
    public static final int DEFAULT_TIMEOUT_SECONDS = 30;

    private final String apiKey;
    private final String baseUrl;
    private final int timeoutSeconds;

    private AtlaSentClientOptions(Builder builder) {
        this.apiKey = builder.apiKey;
        this.baseUrl = builder.baseUrl;
        this.timeoutSeconds = builder.timeoutSeconds;
    }

    /** Returns the API key (e.g. {@code ask_live_...} or {@code ask_test_...}). */
    public String getApiKey() {
        return apiKey;
    }

    /** Returns the base URL of the AtlaSent API (trailing slash stripped at client construction). */
    public String getBaseUrl() {
        return baseUrl;
    }

    /** Returns the HTTP connect/request timeout in seconds. */
    public int getTimeoutSeconds() {
        return timeoutSeconds;
    }

    /** Creates a new {@link Builder} with default values pre-populated. */
    public static Builder builder() {
        return new Builder();
    }

    /** Builder for {@link AtlaSentClientOptions}. */
    public static final class Builder {

        private String apiKey;
        private String baseUrl = DEFAULT_BASE_URL;
        private int timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;

        private Builder() {}

        /**
         * Sets the API key.
         * Required. Format: {@code ask_live_<key>} for production or
         * {@code ask_test_<key>} for test mode.
         */
        public Builder apiKey(String apiKey) {
            if (apiKey == null || apiKey.isEmpty()) {
                throw new IllegalArgumentException("apiKey must not be null or empty");
            }
            this.apiKey = apiKey;
            return this;
        }

        /**
         * Sets the base URL of the AtlaSent API.
         * Defaults to {@value AtlaSentClientOptions#DEFAULT_BASE_URL}.
         */
        public Builder baseUrl(String baseUrl) {
            if (baseUrl == null || baseUrl.isEmpty()) {
                throw new IllegalArgumentException("baseUrl must not be null or empty");
            }
            this.baseUrl = baseUrl;
            return this;
        }

        /**
         * Sets the HTTP connect/request timeout in seconds.
         * Defaults to {@value AtlaSentClientOptions#DEFAULT_TIMEOUT_SECONDS}.
         */
        public Builder timeoutSeconds(int timeoutSeconds) {
            if (timeoutSeconds <= 0) {
                throw new IllegalArgumentException("timeoutSeconds must be > 0");
            }
            this.timeoutSeconds = timeoutSeconds;
            return this;
        }

        /**
         * Builds an {@link AtlaSentClientOptions} instance.
         *
         * @throws IllegalStateException if {@code apiKey} has not been set
         */
        public AtlaSentClientOptions build() {
            if (apiKey == null || apiKey.isEmpty()) {
                throw new IllegalStateException("apiKey is required");
            }
            return new AtlaSentClientOptions(this);
        }
    }
}
