/**
 * Retry queue for identifyUser / trackEvent / trackScreen calls.
 *
 * - One flush runs at a time. flush() while a flush is running joins it and
 *   makes it run once more, so a request is never sent twice while it is in
 *   flight or after it succeeded.
 * - Requests go out one at a time, in the order they were queued.
 * - 4xx client errors (400, 401, 404, …) are dropped and the flush carries on
 *   with the next item.
 * - 429: the item is dropped (not retried) and the queue pauses for Retry-After
 *   (see rate-limit.ts). Items behind it are held, then sent once the pause ends.
 * - 5xx and network failures are retried with backoff (2 s, then 4 s): at most
 *   3 attempts in total, then dropped. A backed-off item waits without holding
 *   up the items behind it.
 * - Flushed again when the app comes to the foreground (AppState).
 * - Labels are persisted to AsyncStorage for debugging only; queued calls are
 *   not replayed after an app restart.
 */
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { httpStatusOf } from './http-error';
import { isPaused, onPauseEnd, pauseFor, pauseRemainingMs } from './rate-limit';

/** Everything in this queue (identify, track-event, track-screen) counts against this bucket. */
const BUCKET = 'tracking' as const;

const QUEUE_KEY = '@encatch/retry_queue';
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

interface SerializableQueueItem {
  id: string;
  retries: number;
  maxRetries: number;
  createdAt: number;
  /** Serialized function label for debugging — actual fn recreated on load */
  label: string;
}

interface QueuedRequest {
  id: string;
  fn: () => Promise<unknown>;
  retries: number;
  maxRetries: number;
  createdAt: number;
  label: string;
  /** Not sent before this time (backoff after a failure). */
  nextAttemptAt: number;
  /** Called when the item is dropped without succeeding. */
  onDrop?: () => void;
}

const queue: QueuedRequest[] = [];

/** Attempt number (1 = first) of the item whose request is being started. */
let sendingAttempt: number | null = null;

/** Attempt number of the queued call currently starting its request, if any. */
export function currentQueueAttempt(): number | null {
  return sendingAttempt;
}

/** The flush in progress, if any. */
let running: Promise<void> | null = null;
/** Set when flush() is called during a flush: run through the queue once more. */
let runAgain = false;
/** Timer that flushes when the earliest backed-off item is due. */
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

// ============================================================================
// Internal helpers
// ============================================================================

/** 4xx client errors are not retried — they won't succeed. */
function isClientError(err: unknown): boolean {
  const status = httpStatusOf(err);
  return status != null && status >= 400 && status < 500;
}

function backoffMs(retries: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, retries);
}

async function persistQueue(): Promise<void> {
  try {
    const serializable: SerializableQueueItem[] = queue.map((item) => ({
      id: item.id,
      retries: item.retries,
      maxRetries: item.maxRetries,
      createdAt: item.createdAt,
      label: item.label,
    }));
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(serializable));
  } catch {
    /* ignore storage failures */
  }
}

function remove(item: QueuedRequest): void {
  const idx = queue.indexOf(item);
  if (idx !== -1) queue.splice(idx, 1);
}

/** Removes an item that did not succeed and tells its owner. */
function drop(item: QueuedRequest): void {
  remove(item);
  try {
    item.onDrop?.();
  } catch {
    /* ignore */
  }
}

/** Sends every item that is due, in order, once. */
async function runOnce(): Promise<void> {
  for (const item of [...queue]) {
    // Paused after a 429: hold the rest until the pause ends (onPauseEnd flushes).
    if (isPaused(BUCKET)) return;
    if (!queue.includes(item)) continue;
    if (item.nextAttemptAt > Date.now()) continue;

    try {
      // The item's fn calls _post synchronously at its start, which reads this.
      sendingAttempt = item.retries + 1;
      const sending = item.fn();
      sendingAttempt = null;
      await sending;
      remove(item);
      await persistQueue();
    } catch (err) {
      sendingAttempt = null;
      if (httpStatusOf(err) === 429) {
        drop(item);
        await persistQueue();
        pauseFor(BUCKET, (err as { retryAfterMs?: number })?.retryAfterMs);
        console.warn(`[Encatch] Retry queue: dropping "${item.label}" (rate limited, not retried)`, err);
        return;
      }
      if (isClientError(err)) {
        drop(item);
        await persistQueue();
        console.warn(`[Encatch] Retry queue: dropping "${item.label}" (client error, no retry)`, err);
        continue;
      }
      item.retries += 1;
      if (item.retries >= item.maxRetries) {
        drop(item);
        console.warn(`[Encatch] Retry queue: dropping "${item.label}" after ${item.maxRetries} retries`, err);
      } else {
        item.nextAttemptAt = Date.now() + backoffMs(item.retries);
      }
      await persistQueue();
    }
  }
}

/** Arranges a flush for when the earliest backed-off item becomes due. */
function scheduleWake(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  if (queue.length === 0) return;
  // While paused, onPauseEnd() flushes; otherwise wake for the next backed-off item.
  if (isPaused(BUCKET)) return;
  const next = Math.min(...queue.map((q) => q.nextAttemptAt));
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    flush().catch(() => {});
  }, Math.max(0, next - Date.now()));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Enqueue a retriable API call.
 *
 * @param label   Human-readable label used for debugging and log output.
 * @param fn      The async function to execute. Should be a closure capturing
 *                the current request payload.
 * @param maxRetries  Override default max attempts (default: 3).
 * @param onDrop  Called if the call is dropped without succeeding.
 */
export function enqueue(
  label: string,
  fn: () => Promise<unknown>,
  maxRetries: number = MAX_RETRIES,
  onDrop?: () => void
): void {
  const now = Date.now();
  queue.push({
    id: `${now}-${Math.random().toString(36).slice(2)}`,
    fn,
    retries: 0,
    maxRetries,
    createdAt: now,
    label,
    nextAttemptAt: now,
    onDrop,
  });
  persistQueue();
}

/**
 * Sends every queued request that is due, one at a time, in order.
 * If a flush is already running, this joins it and makes it go through the
 * queue once more, so items added meanwhile are sent too.
 */
export function flush(): Promise<void> {
  if (running) {
    runAgain = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        runAgain = false;
        await runOnce();
      } while (runAgain);
    } finally {
      running = null;
      scheduleWake();
    }
  })();
  return running;
}

/** Removes queued (not yet sent) items with this label. Returns how many were removed. */
export function removeQueued(label: string): number {
  const before = queue.length;
  for (const item of [...queue]) if (item.label === label) drop(item);
  const removed = before - queue.length;
  if (removed > 0) persistQueue();
  return removed;
}

/** True while the queue's bucket is paused after a 429. */
export function isQueuePaused(): boolean {
  return isPaused(BUCKET);
}

/** Milliseconds until the queue's pause ends (0 when not paused). */
export function queuePauseRemainingMs(): number {
  return pauseRemainingMs(BUCKET);
}

// Send what was held as soon as a pause ends.
onPauseEnd(() => {
  flush().catch(() => {});
});

// ============================================================================
// AppState listener: flush on foreground
// ============================================================================

let appStateSubscription: ReturnType<typeof AppState.addEventListener> | null = null;

/**
 * Starts listening for AppState changes and flushes the queue when the app
 * comes to the foreground. Call once during SDK initialization.
 */
export function startAppStateListener(): void {
  if (appStateSubscription) return; // Already started

  const handleAppStateChange = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      flush().catch(() => {});
    }
  };

  appStateSubscription = AppState.addEventListener('change', handleAppStateChange);
}

/**
 * Removes the AppState listener. Call during SDK teardown.
 */
export function stopAppStateListener(): void {
  if (appStateSubscription) {
    appStateSubscription.remove();
    appStateSubscription = null;
  }
}

/**
 * Returns the current number of items in the in-memory queue.
 */
export function queueSize(): number {
  return queue.length;
}
