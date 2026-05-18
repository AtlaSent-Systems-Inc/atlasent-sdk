import type {
  BatchSubmitOptions, BatchJob,
  StreamingPublishOptions,
  GraphQLQueryOptions, GraphQLResult,
  InsightsEvaluateOptions, InsightsEvaluateResult, InsightsCampaign,
  AnalyticsSummary, BatchDailyMetric, StreamingHourlyMetric, InsightsDailyMetric,
  WebhookQueueItem,
  RevokePermitOptions, RevokePermitResult,
} from './types.js';

export interface AtlasentV2ClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class AtlasentV2Client {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeoutMs: number;

  constructor(opts: AtlasentV2ClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.atlasent.io').replace(/\/$/, '');
    this.headers = {
      Authorization: `Bearer ${opts.apiKey}`,
      'Content-Type': 'application/json',
    };
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers,
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`AtlaSent v2 ${res.status} ${method} ${path}: ${await res.text()}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Batch ─────────────────────────────────────────────────────────────────

  submitBatch(opts: BatchSubmitOptions): Promise<BatchJob> {
    return this.request('POST', `/v1/orgs/${opts.orgId}/batch/jobs`, {
      events: opts.events,
      metadata: opts.metadata,
    });
  }

  getBatchJob(orgId: string, jobId: string): Promise<BatchJob> {
    return this.request('GET', `/v1/orgs/${orgId}/batch/jobs/${jobId}`);
  }

  listBatchJobs(orgId: string, status?: string): Promise<{ jobs: BatchJob[]; total: number }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request('GET', `/v1/orgs/${orgId}/batch/jobs${qs}`);
  }

  cancelBatchJob(orgId: string, jobId: string): Promise<BatchJob> {
    return this.request('POST', `/v1/orgs/${orgId}/batch/jobs/${jobId}/cancel`, {});
  }

  // ── Streaming ─────────────────────────────────────────────────────────────

  publishEvent(opts: StreamingPublishOptions): Promise<{ eventId: string; deliveredTo: number }> {
    return this.request('POST', `/v1/orgs/${opts.orgId}/events/stream/publish`, {
      type: opts.type,
      subjectId: opts.subjectId,
      payload: opts.payload,
    });
  }

  // ── GraphQL ───────────────────────────────────────────────────────────────

  graphql(opts: GraphQLQueryOptions): Promise<GraphQLResult> {
    return this.request('POST', `/v1/orgs/${opts.orgId}/graphql`, {
      query: opts.query,
      variables: opts.variables,
    });
  }

  // ── Behavior Insights ─────────────────────────────────────────────────────

  evaluateInsights(opts: InsightsEvaluateOptions): Promise<InsightsEvaluateResult> {
    return this.request('POST', `/v1/orgs/${opts.orgId}/insights/evaluate`, {
      subjectId: opts.subjectId,
      events: opts.events,
      sessionCount: opts.sessionCount,
      patternScores: opts.patternScores,
    });
  }

  listCampaigns(orgId: string, status?: string): Promise<{ campaigns: InsightsCampaign[]; total: number }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request('GET', `/v1/orgs/${orgId}/insights/campaigns${qs}`);
  }

  getCampaign(orgId: string, campaignId: string): Promise<InsightsCampaign> {
    return this.request('GET', `/v1/orgs/${orgId}/insights/campaigns/${campaignId}`);
  }

  // ── Analytics ─────────────────────────────────────────────────────────────

  getAnalyticsSummary(orgId: string): Promise<AnalyticsSummary> {
    return this.request('GET', `/v1/orgs/${orgId}/analytics/summary`);
  }

  getBatchAnalytics(orgId: string): Promise<{ metrics: BatchDailyMetric[]; windowDays: number }> {
    return this.request('GET', `/v1/orgs/${orgId}/analytics/batch`);
  }

  getStreamingAnalytics(orgId: string): Promise<{ metrics: StreamingHourlyMetric[]; windowDays: number }> {
    return this.request('GET', `/v1/orgs/${orgId}/analytics/streaming`);
  }

  getInsightsAnalytics(orgId: string): Promise<{ metrics: InsightsDailyMetric[]; windowDays: number }> {
    return this.request('GET', `/v1/orgs/${orgId}/analytics/insights`);
  }

  // ── Webhook Queue ─────────────────────────────────────────────────────────

  listWebhookQueue(orgId: string, status?: string): Promise<{ items: WebhookQueueItem[]; total: number }> {
    const qs = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.request('GET', `/v1/orgs/${orgId}/webhooks/queue${qs}`);
  }

  retryWebhookItem(orgId: string, itemId: string): Promise<WebhookQueueItem> {
    return this.request('POST', `/v1/orgs/${orgId}/webhooks/queue/${itemId}/retry`, {});
  }

  drainDeadLetter(orgId: string): Promise<{ queued: number }> {
    return this.request('POST', `/v1/orgs/${orgId}/webhooks/queue/dead-letter/drain`, {});
  }

  // ── Permits ───────────────────────────────────────────────────────────────

  async revokePermit(opts: RevokePermitOptions): Promise<RevokePermitResult> {
    const raw = await this.request<{
      revoked: boolean;
      newly_revoked: boolean;
      already_revoked: boolean;
    }>('POST', `/v1/orgs/${opts.orgId}/permits/revoke`, {
      permit_token: opts.permitToken,
      reason: opts.reason,
      revoked_by: opts.revokedBy,
    });
    return {
      revoked: raw.revoked,
      newlyRevoked: raw.newly_revoked,
      alreadyRevoked: raw.already_revoked,
    };
  }
}
