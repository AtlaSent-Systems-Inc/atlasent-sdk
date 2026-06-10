package io.atlasent.sdk.model;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

/**
 * Response body from {@code GET /v1/approvals/sla}.
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public class GetApprovalSlaResponse {

    @JsonProperty("stats")
    private ApprovalSlaStats stats;

    public GetApprovalSlaResponse() {}

    public ApprovalSlaStats getStats() { return stats; }
    public void setStats(ApprovalSlaStats stats) { this.stats = stats; }

    /**
     * SLA statistics for hold-based approval requests.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class ApprovalSlaStats {

        @JsonProperty("org_id")
        private String orgId;

        @JsonProperty("period_days")
        private int periodDays;

        @JsonProperty("total_holds")
        private int totalHolds;

        @JsonProperty("resolved_holds")
        private int resolvedHolds;

        @JsonProperty("breached_holds")
        private int breachedHolds;

        @JsonProperty("sla_threshold_hours")
        private double slaThresholdHours;

        @JsonProperty("breach_rate")
        private double breachRate;

        /**
         * Average resolution time in hours. Null when no holds have been resolved.
         */
        @JsonProperty("avg_resolution_hours")
        private Double avgResolutionHours;

        /**
         * 95th-percentile resolution time in hours. Null when insufficient data.
         */
        @JsonProperty("p95_resolution_hours")
        private Double p95ResolutionHours;

        public ApprovalSlaStats() {}

        public String getOrgId() { return orgId; }
        public void setOrgId(String orgId) { this.orgId = orgId; }

        public int getPeriodDays() { return periodDays; }
        public void setPeriodDays(int periodDays) { this.periodDays = periodDays; }

        public int getTotalHolds() { return totalHolds; }
        public void setTotalHolds(int totalHolds) { this.totalHolds = totalHolds; }

        public int getResolvedHolds() { return resolvedHolds; }
        public void setResolvedHolds(int resolvedHolds) { this.resolvedHolds = resolvedHolds; }

        public int getBreachedHolds() { return breachedHolds; }
        public void setBreachedHolds(int breachedHolds) { this.breachedHolds = breachedHolds; }

        public double getSlaThresholdHours() { return slaThresholdHours; }
        public void setSlaThresholdHours(double slaThresholdHours) { this.slaThresholdHours = slaThresholdHours; }

        public double getBreachRate() { return breachRate; }
        public void setBreachRate(double breachRate) { this.breachRate = breachRate; }

        public Double getAvgResolutionHours() { return avgResolutionHours; }
        public void setAvgResolutionHours(Double avgResolutionHours) { this.avgResolutionHours = avgResolutionHours; }

        public Double getP95ResolutionHours() { return p95ResolutionHours; }
        public void setP95ResolutionHours(Double p95ResolutionHours) { this.p95ResolutionHours = p95ResolutionHours; }
    }
}
