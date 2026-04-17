import { z } from "zod";

export const DecisionSchema = z.enum(["allow", "deny", "hold", "escalate"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const EvaluateRequestSchema = z.object({
  agentId: z.string(),
  actionType: z.string(),
  context: z.record(z.unknown()).default({}),
  failMode: z.enum(["open", "closed"]).default("closed"),
});
export type EvaluateRequest = z.infer<typeof EvaluateRequestSchema>;

export const EvaluateResponseSchema = z.object({
  decision: DecisionSchema,
  denyCode: z.string().optional(),
  escalateTo: z.string().optional(),
  permitToken: z.string().optional(),
  meta: z.record(z.unknown()).default({}),
});
export type EvaluateResponse = z.infer<typeof EvaluateResponseSchema>;

export const VerifyPermitRequestSchema = z.object({
  permitToken: z.string(),
  actionType: z.string(),
});
export type VerifyPermitRequest = z.infer<typeof VerifyPermitRequestSchema>;

export const VerifyPermitResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional(),
});
export type VerifyPermitResponse = z.infer<typeof VerifyPermitResponseSchema>;

export interface AtlaSentClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}
