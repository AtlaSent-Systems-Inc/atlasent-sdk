import type { EvaluateResponse } from "./types.js";

export class AtlaSentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AtlaSentDeniedError extends AtlaSentError {
  readonly code: string;
  readonly response: EvaluateResponse;

  constructor(code: string, response: EvaluateResponse) {
    super(`Authorization denied: ${code}`);
    this.code = code;
    this.response = response;
  }
}

export class AtlaSentHoldError extends AtlaSentError {
  readonly code: string;
  readonly response: EvaluateResponse;

  constructor(code: string, response: EvaluateResponse) {
    super(`Authorization held: ${code}`);
    this.code = code;
    this.response = response;
  }
}

export class AtlaSentEscalateError extends AtlaSentError {
  readonly escalateTo: string;
  readonly response: EvaluateResponse;

  constructor(escalateTo: string, response: EvaluateResponse) {
    super(`Authorization requires escalation to: ${escalateTo}`);
    this.escalateTo = escalateTo;
    this.response = response;
  }
}

export class AtlaSentAPIError extends AtlaSentError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`AtlaSent API error ${status}: ${message}`);
    this.status = status;
  }
}
