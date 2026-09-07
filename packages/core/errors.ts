/**
 * ESSENTIAL - Social Media Super Agent
 * packages/core/errors.ts
 *
 * Single error taxonomy for the whole system. Every error is an
 * EssentialError with a stable code, an HTTP status, and a retryable flag.
 * toHttpError() maps any thrown value to a JSON body for the Fastify error
 * handler, so clients always get a consistent shape:
 *   { code, message, retryable, details? }
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source.
 */

export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'UPSTREAM'
  | 'INTERNAL';

export class EssentialError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    retryable = false,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EssentialError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}

export class NotFoundError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('NOT_FOUND', message, 404, false, details);
  }
}

export class ValidationError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('VALIDATION', message, 400, false, details);
  }
}

export class AuthError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('UNAUTHENTICATED', message, 401, false, details);
  }
}

export class ForbiddenError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('FORBIDDEN', message, 403, false, details);
  }
}

export class RateLimitError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('RATE_LIMITED', message, 429, false, details);
  }
}

export class ConflictError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('CONFLICT', message, 409, false, details);
  }
}

export class UpstreamError extends EssentialError {
  constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('UPSTREAM', message, 502, true, details);
  }
}

export interface HttpErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Map any thrown value to { statusCode, body } for the HTTP layer. */
export function toHttpError(err: unknown): { statusCode: number; body: HttpErrorBody } {
  if (err instanceof EssentialError) {
    return {
      statusCode: err.statusCode,
      body: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  /* Plain errors may carry an explicit statusCode (e.g. route-level 422). */
  if (err instanceof Error && typeof (err as { statusCode?: unknown }).statusCode === 'number') {
    const sc = (err as unknown as { statusCode: number }).statusCode;
    const code: ErrorCode =
      sc === 404 ? 'NOT_FOUND'
      : sc === 409 ? 'CONFLICT'
      : sc === 403 ? 'FORBIDDEN'
      : sc === 422 || sc === 400 ? 'VALIDATION'
      : 'INTERNAL';
    return { statusCode: sc, body: { code, message: err.message, retryable: false } };
  }
  const message = err instanceof Error ? err.message : 'internal error';
  return { statusCode: 500, body: { code: 'INTERNAL', message, retryable: false } };
}
