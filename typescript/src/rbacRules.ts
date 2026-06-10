export type RbacConditionType = "time_window" | "environment" | "risk_score";
export type RbacEffect = "restrict" | "allow_additional";
export type RbacEnvironment = "prod" | "staging" | "dev";
export type RbacRiskOperator = "below" | "above";

export interface RbacTimeWindowCondition {
  type: "time_window";
  days: string[];
  from: string;
  to: string;
}

export interface RbacEnvironmentCondition {
  type: "environment";
  environment: RbacEnvironment;
}

export interface RbacRiskScoreCondition {
  type: "risk_score";
  operator: RbacRiskOperator;
  threshold: number;
}

export type RbacCondition =
  | RbacTimeWindowCondition
  | RbacEnvironmentCondition
  | RbacRiskScoreCondition;

export interface RbacRule {
  id: string;
  org_id: string;
  role: string;
  condition: RbacCondition;
  effect: RbacEffect;
  created_at: string;
  updated_at: string;
}

export interface CreateRbacRuleRequest {
  org_id: string;
  role: string;
  condition: RbacCondition;
  effect: RbacEffect;
}

export interface ListRbacRulesResponse {
  rules: RbacRule[];
  total: number;
}

export interface RbacRuleResponse {
  rule: RbacRule;
}
