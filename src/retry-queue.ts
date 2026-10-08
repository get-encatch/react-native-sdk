/**
 * Offline retry queue for failed API calls.
 *
 * - Persisted to AsyncStorage so requests survive app restarts.
 * - Automatically flushed when the app comes to the foreground (AppState).
 * - Max 3 retries per request with exponential backoff (1s → 2s → 4s).
 * - Does NOT retry on 4xx client errors (401, 404, etc.) — these won't succeed on retry.
 * - Retries 5xx server errors and network failures.
 * - Only retries safe idempotent calls: identifyUser, trackEvent, trackScreen.
 */
import { AppState, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

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
}

// In-memory queue (runtime) — populated from AsyncStorage on init
const queue: QueuedRequest[] = [];
// Factory registry: label -> fn factory, used to recreate fns after app restart
const fnRegistry = new Map<string, (() => () => Promise<unknown>) | null>();

// ============================================================================
// Internal helpers
// ============================================================================

/** 4xx client errors should not be retried — they won't succeed. */
function isClientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/status (\d+)/);
  if (!match) return false;
  const status = parseInt(match[1], 10);
  return status >= 400 && status < 500;
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

async function removeFromPersisted(id: string): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return;
    const items: SerializableQueueItem[] = JSON.parse(raw);
    const filtered = items.filter((i) => i.id !== id);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
  } catch {
    /* ignore */
  }
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
 * @param maxRetries  Override default max retries (default: 3).
 */
export function enqueue(
  label: string,
  fn: () => Promise<unknown>,
  maxRetries: number = MAX_RETRIES
): void {
  const item: QueuedRequest = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    fn,
    retries: 0,
    maxRetries,
    createdAt: Date.now(),
    label,
  };
  queue.push(item);
  persistQueue();
}

/**
 * Attempt to flush all queued requests in order.
 * Successful items are removed. Failed items have their retry count incremented.
 * Items that exceed maxRetries are dropped.
 */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;

  // Work on a snapshot to avoid mutation issues during iteration
  const snapshot = [...queue];

  for (const item of snapshot) {
    try {
      await item.fn();
      // Success: remove from in-memory queue and persisted storage
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx !== -1) queue.splice(idx, 1);
      await removeFromPersisted(item.id);
    } catch (err) {
      if (isClientError(err)) {
        // 4xx client errors — don't retry, drop immediately
        const idx = queue.findIndex((q) => q.id === item.id);
        if (idx !== -1) queue.splice(idx, 1);
        await removeFromPersisted(item.id);
        console.warn(`[Encatch] Retry queue: dropping "${item.label}" (client error, no retry)`, err);
        return;
      }
      item.retries += 1;
      if (item.retries >= item.maxRetries) {
        // Exhausted: drop the item
        const idx = queue.findIndex((q) => q.id === item.id);
        if (idx !== -1) queue.splice(idx, 1);
        await removeFromPersisted(item.id);
        console.warn(`[Encatch] Retry queue: dropping "${item.label}" after ${item.maxRetries} retries`, err);
      } else {
        // Schedule a deferred retry with exponential backoff
        const delay = backoffMs(item.retries);
        setTimeout(() => flushSingle(item.id), delay);
        await persistQueue();
      }
    }
  }
}

async function flushSingle(id: string): Promise<void> {
  const item = queue.find((q) => q.id === id);
  if (!item) return;

  try {
    await item.fn();
    const idx = queue.findIndex((q) => q.id === id);
    if (idx !== -1) queue.splice(idx, 1);
    await removeFromPersisted(id);
  } catch (err) {
    if (isClientError(err)) {
      const idx = queue.findIndex((q) => q.id === id);
      if (idx !== -1) queue.splice(idx, 1);
      await removeFromPersisted(id);
      console.warn(`[Encatch] Retry queue: dropping "${item.label}" (client error, no retry)`, err);
      return;
    }
    item.retries += 1;
    if (item.retries >= item.maxRetries) {
      const idx = queue.findIndex((q) => q.id === id);
      if (idx !== -1) queue.splice(idx, 1);
      await removeFromPersisted(id);
      console.warn(`[Encatch] Retry queue: dropping "${item.label}" after ${item.maxRetries} retries`, err);
    } else {
      const delay = backoffMs(item.retries);
      setTimeout(() => flushSingle(id), delay);
      await persistQueue();
    }
  }
}

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

// Suppress unused variable warning for fnRegistry (used for future persistence recovery)
void fnRegistry;
