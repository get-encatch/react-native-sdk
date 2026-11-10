/**
 * 429 pause. Internal; not exported from the package.
 *
 * When the API answers 429, the SDK stops sending new requests in that bucket
 * until Retry-After has passed, instead of hammering the server:
 *  - the 429'd call is dropped (identify / track-event / track-screen / show-form
 *    are never retried after a 429),
 *  - new calls in a paused bucket are skipped, apart from the latest
 *    identifyUser and submit-form, which wait for the pause to end,
 *  - calls already in the retry queue are held and sent once the pause ends.
 *
 * Buckets follow how the gateway counts requests. Which endpoint belongs to which
 * bucket is configuration (BUCKET_OF), so it can follow the deployed limits.
 */

export type Bucket = 'tracking' | 'show-form' | 'submit-form' | 'other';

/** Endpoint name (last path segment) → bucket. */
const BUCKET_OF: Record<string, Bucket> = {
  'identify-user': 'tracking',
  'track-event': 'tracking',
  'track-screen': 'tracking',
  ping: 'tracking',
  'show-form': 'show-form',
  'submit-form': 'submit-form',
};

/** Pause used when a 429 has no (valid) Retry-After header. */
export const DEFAULT_PAUSE_MS = 60_000;
/** Longest pause, whatever Retry-After says. */
export const MAX_PAUSE_MS = 5 * 60_000;

const pausedUntil = new Map<Bucket, number>();
const listeners = new Set<() => void>();
const timers = new Map<Bucket, ReturnType<typeof setTimeout>>();

/** Bucket for an endpoint path such as 'engage-product/encatch/api/v2/encatch/track-event'. */
export function bucketOf(endpoint: string): Bucket {
  const name = endpoint.split('/').pop() ?? endpoint;
  return BUCKET_OF[name] ?? 'other';
}

/** Starts (or extends) a pause after a 429. Warns once when a pause starts. */
export function pauseFor(bucket: Bucket, retryAfterMs?: number, now: number = Date.now()): void {
  if (bucket === 'other') return;
  const ms = Math.min(
    MAX_PAUSE_MS,
    retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : DEFAULT_PAUSE_MS
  );
  const until = now + ms;
  const current = pausedUntil.get(bucket) ?? 0;
  if (until <= current) return;

  if (current <= now) {
    console.warn(
      `[Encatch] Rate limited (429): pausing ${bucket} requests for ${Math.ceil(ms / 1000)} s. ` +
        'Calls made during the pause are skipped.'
    );
  }
  pausedUntil.set(bucket, until);

  const prev = timers.get(bucket);
  if (prev) clearTimeout(prev);
  timers.set(
    bucket,
    setTimeout(() => {
      timers.delete(bucket);
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    }, ms)
  );
}

export function isPaused(bucket: Bucket, now: number = Date.now()): boolean {
  return (pausedUntil.get(bucket) ?? 0) > now;
}

/** Milliseconds until the bucket's pause ends (0 when not paused). */
export function pauseRemainingMs(bucket: Bucket, now: number = Date.now()): number {
  return Math.max(0, (pausedUntil.get(bucket) ?? 0) - now);
}

/** Called whenever a pause ends (used by the retry queue to send what it held). */
export function onPauseEnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Clears every pause (full SDK reset). */
export function clearPauses(): void {
  pausedUntil.clear();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
