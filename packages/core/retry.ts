/**
 * ESSENTIAL - Social Media Super Agent
 * packages/core/retry.ts
 *
 * Reliability primitives: withRetry (exponential backoff + jitter) and
 * withTimeout (deadline enforcement). Used by the worker processors so a
 * transient upstream failure is retried and a hung call is cut off.
 *
 * Owner: E. Patricia Rogers - Unmatched Logistics LLC
 * Constraint: code-native only. No secrets in source.
 */

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  /** Predicate deciding which errors are worth retrying. */
  readonly retryable?: (err: unknown) => boolean;
}

export const DEFAULT_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2000,
  timeoutMs: 30_000,
} as const;

/** Reject a promise if it does not settle within ms. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Retry fn with exponential backoff + jitter until success or maxAttempts. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_RETRY.timeoutMs;
  const retryable =
    opts.retryable ??
    ((err: unknown) => !(err instanceof Error) || (err as { retryable?: boolean }).retryable !== false);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, `attempt ${attempt}/${maxAttempts}`);
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !retryable(err)) throw err;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise((r) => setTimeout(r, delay + Math.random() * 50));
    }
  }
  throw lastErr;
}
