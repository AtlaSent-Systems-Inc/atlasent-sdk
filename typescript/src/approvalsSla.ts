export interface ApprovalSlaStats {
  org_id: string;
  period_days: number;
  total_holds: number;
  resolved_holds: number;
  breached_holds: number;
  sla_threshold_hours: number;
  breach_rate: number;
  avg_resolution_hours: number | null;
  p95_resolution_hours: number | null;
}

export interface GetApprovalSlaResponse {
  stats: ApprovalSlaStats;
}
