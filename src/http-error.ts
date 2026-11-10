/**
 * Internal error for a non-2xx API reply. Not exported from the package.
 *
 * The message keeps the exact 1.4.3 format ("[Encatch API] <endpoint> failed with
 * status <n>: <body>"), so anything matching on it keeps working; `status` and
 * `retryAfterMs` let the retry queue and the 429 pause read them directly.
 */
export class HttpError extends Error {
  readonly status: number;
  /** From the Retry-After header (seconds or an HTTP date), when present. */
  readonly retryAfterMs?: number;

  constructor(endpoint: string, status: number, responseText: string, retryAfterMs?: number) {
    super(`[Encatch API] ${endpoint} failed with status ${status}: ${responseText}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parses a Retry-After header: delay in seconds, or an HTTP date.
 * Returns milliseconds from `now`, or undefined when missing or invalid.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(parseFloat(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** HTTP status of an error from `_post`, if it has one (falls back to the message). */
export function httpStatusOf(err: unknown): number | undefined {
  if (err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/status (\d+)/);
  return match ? parseInt(match[1], 10) : undefined;
}
