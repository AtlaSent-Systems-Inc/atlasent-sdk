// Batch
export interface BatchSubmitOptions {
  orgId: string;
  events: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}

export interface BatchJob {
  jobId: string;
  orgId: string;
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
  eventCount: number;
  processedCount: number;
  failedCount: number;
  submittedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorSummary: string | null;
}

// Streaming
export interface StreamingPublishOptions {
  orgId: string;
  type: string;
  subjectId: string;
  payload?: Record<string, unknown>;
}

// GraphQL
export interface GraphQLQueryOptions {
  orgId: string;
  query: string;
  variables?: Record<string, unknown>;
}

export interface GraphQLResult {
  data: unknown;
  errors?: { message: string; locations?: unknown[]; path?: unknown[] }[];
}

// Behavior Insights
export interface InsightsEvaluateOptions {
  orgId: string;
  subjectId: string;
  events?: { type: string; occurredAt?: string }[];
  sessionCount?: number;
  patternScores?: Record<string, number>;
}

export interface InsightsEvaluateResult {
  subjectId: string;
  fired: { campaignId: string; name: string; delivery: Record<string, unknown> }[];
  skipped: { campaignId: string; name: string; reason: string }[];
}

export interface InsightsCampaign {
  campaignId: string;
  orgId: string;
  name: string;
  description?: string;
  type: "nudge" | "reminder" | "block" | "alert";
  status: "draft" | "active" | "paused" | "archived";
  trigger: Record<string, unknown>;
  delivery: Record<string, unknown>;
  maxDeliveriesPerSubject: number;
  cooldownSeconds: number;
  totalDeliveries: number;
  createdAt: string;
  updatedAt: string;
}

// Analytics
export interface AnalyticsSummary {
  batch: {
    totalJobsLast30Days: number;
    successRateLast30Days: number | null;
    totalEventsProcessedLast30Days: number;
  };
  streaming: {
    totalEventsLast7Days: number;
    activeConnectionsNow: number;
    topEventType: string | null;
  };
  insights: {
    totalDeliveriesLast30Days: number;
    activeCampaigns: number;
    topCampaignId: string | null;
  };
}

export interface BatchDailyMetric {
  date: string;
  jobsSubmitted: number;
  jobsCompleted: number;
  jobsFailed: number;
  totalEventsProcessed: number;
  avgDurationSeconds: number | null;
}

export interface StreamingHourlyMetric {
  hour: string;
  eventType: string;
  eventCount: number;
}

export interface InsightsDailyMetric {
  date: string;
  campaignId: string;
  campaignName: string;
  deliveries: number;
}

// Webhook Queue
export interface WebhookQueueItem {
  id: string;
  orgId: string;
  sourceType: "insights_campaign" | "streaming";
  sourceId: string;
  endpointUrl: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "delivered" | "failed" | "dead_letter";
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// Permits
export interface RevokePermitOptions {
  orgId: string;
  /** The raw permit token string (will be hashed server-side). */
  permitToken: string;
  reason?: string;
  revokedBy?: string;
}

export interface RevokePermitResult {
  revoked: boolean;
  newlyRevoked: boolean;
  alreadyRevoked: boolean;
}
