/**
 * Typed failure modes. Every way the AI feature can fail is a named class with
 * an HTTP status and a `retryable` flag, so callers, dashboards and runbooks can
 * all speak the same language. No "something went wrong".
 */
export type FailureCode =
  | 'GUARDRAIL_INPUT_REJECTED'
  | 'GUARDRAIL_OUTPUT_REJECTED'
  | 'INSUFFICIENT_DATA'
  | 'BUDGET_EXCEEDED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RATE_LIMITED'
  | 'AGENT_LIMIT_REACHED'
  | 'TIMEOUT'
  | 'TOOL_ERROR'
  | 'INTERNAL';

export class AIFailure extends Error {
  readonly code: FailureCode;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(
    code: FailureCode,
    message: string,
    opts: { httpStatus?: number; retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AIFailure';
    this.code = code;
    this.httpStatus = opts.httpStatus ?? defaultStatus(code);
    this.retryable = opts.retryable ?? defaultRetryable(code);
    this.details = opts.details ?? {};
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

function defaultStatus(code: FailureCode): number {
  switch (code) {
    case 'GUARDRAIL_INPUT_REJECTED':
      return 400;
    case 'GUARDRAIL_OUTPUT_REJECTED':
      return 502;
    case 'INSUFFICIENT_DATA':
      return 422;
    case 'BUDGET_EXCEEDED':
      return 429;
    case 'PROVIDER_RATE_LIMITED':
      return 429;
    case 'PROVIDER_UNAVAILABLE':
      return 503;
    case 'AGENT_LIMIT_REACHED':
      return 422;
    case 'TIMEOUT':
      return 504;
    case 'TOOL_ERROR':
      return 502;
    case 'INTERNAL':
      return 500;
  }
}

function defaultRetryable(code: FailureCode): boolean {
  return code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_RATE_LIMITED' || code === 'TIMEOUT';
}

export function toAIFailure(err: unknown): AIFailure {
  if (err instanceof AIFailure) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AIFailure('INTERNAL', message, { cause: err });
}
