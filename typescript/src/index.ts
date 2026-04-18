export { AtlaSentClient } from './client.ts';
export { AsyncClient } from './async-client.ts';
export { AtlaSentError } from './errors.ts';
export { withSpan, configureTracing } from './otel.ts';
export type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
  Decision,
} from './types.ts';
