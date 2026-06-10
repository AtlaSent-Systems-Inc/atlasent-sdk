package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Optional query parameters for {@code GET /v1/rbac-rules}.
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public class ListRbacRulesOptions {

    private Integer limit;
    private Integer offset;
    private String cursor;

    public ListRbacRulesOptions() {}

    private ListRbacRulesOptions(Builder builder) {
        this.limit = builder.limit;
        this.offset = builder.offset;
        this.cursor = builder.cursor;
    }

    public Integer getLimit() { return limit; }
    public void setLimit(Integer limit) { this.limit = limit; }

    public Integer getOffset() { return offset; }
    public void setOffset(Integer offset) { this.offset = offset; }

    public String getCursor() { return cursor; }
    public void setCursor(String cursor) { this.cursor = cursor; }

    /** Returns a new builder. */
    public static Builder builder() {
        return new Builder();
    }

    /** Builder for {@link ListRbacRulesOptions}. */
    public static final class Builder {
        private Integer limit;
        private Integer offset;
        private String cursor;

        private Builder() {}

        public Builder limit(int limit) { this.limit = limit; return this; }
        public Builder offset(int offset) { this.offset = offset; return this; }
        public Builder cursor(String cursor) { this.cursor = cursor; return this; }

        public ListRbacRulesOptions build() {
            return new ListRbacRulesOptions(this);
        }
    }
}
