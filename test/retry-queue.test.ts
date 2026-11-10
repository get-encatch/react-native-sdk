import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetStorage } from './mocks/async-storage';

type Queue = typeof import('../src/retry-queue');
let q: Queue;
let setAppState: (s: string) => void;

/** Same shape as the error thrown by Encatch._post() for a non-2xx reply. */
function httpError(status: number, retryAfterMs?: number): Error {
  const err = new Error(`[Encatch API] some-endpoint failed with status ${status}: {}`) as Error & {
    status?: number;
    retryAfterMs?: number;
  };
  err.status = status;
  if (retryAfterMs != null) err.retryAfterMs = retryAfterMs;
  return err;
}

/** A queued call that takes `latency` ms and resolves or rejects per `outcome(attempt)`. */
function call(outcome: (attempt: number) => Error | null = () => null, latency = 50) {
  let attempts = 0;
  const fn = vi.fn(async () => {
    attempts += 1;
    const n = attempts;
    await new Promise((r) => setTimeout(r, latency));
    const err = outcome(n);
    if (err) throw err;
  });
  return fn;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  __resetStorage();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  q = await import('../src/retry-queue');
  setAppState = (await import('./mocks/react-native')).__setAppState;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('retry queue', () => {
  it('never re-sends a request that is still in flight', async () => {
    // Every SDK tracking call enqueues and then flushes. Fire 10 in a burst.
    const fns = Array.from({ length: 10 }, () => call());
    for (const fn of fns) {
      q.enqueue('identifyUser', fn);
      q.flush().catch(() => {});
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fns.map((f) => f.mock.calls.length)).toEqual(Array(10).fill(1));
    expect(q.queueSize()).toBe(0);
  });

  it('never re-sends a request that already succeeded', async () => {
    const fn = call();
    q.enqueue('trackEvent', fn);
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps sending the remaining items after one gets a 4xx', async () => {
    const bad = call(() => httpError(400));
    const good = call();
    q.enqueue('trackEvent', bad);
    q.enqueue('trackEvent', good);

    const p = q.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await p;

    expect(bad).toHaveBeenCalledTimes(1); // 400 is still not retried
    expect(good).toHaveBeenCalledTimes(1);
    expect(q.queueSize()).toBe(0);
  });

  it('on 429 drops the request instead of retrying it, and warns', async () => {
    const warn = vi.mocked(console.warn);
    const limited = call(() => httpError(429, 2_000));
    q.enqueue('identifyUser', limited);
    q.flush().catch(() => {});

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(limited).toHaveBeenCalledTimes(1);
    expect(q.queueSize()).toBe(0);
    expect(warn).toHaveBeenCalled(); // dropped, but not silently
  });

  it('on 429 holds the items already queued until Retry-After, then sends them once', async () => {
    const limited = call(() => httpError(429, 3_000));
    const queuedBehind = [call(), call(), call()];
    q.enqueue('trackEvent', limited);
    for (const fn of queuedBehind) q.enqueue('trackEvent', fn);
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(100);

    // Another flush during the pause (e.g. app comes to the foreground) sends nothing.
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queuedBehind.map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(limited).toHaveBeenCalledTimes(1);
    expect(queuedBehind.map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    expect(q.queueSize()).toBe(0);
  });

  it('on 429 without Retry-After still pauses before sending anything else', async () => {
    const limited = call(() => httpError(429));
    const queuedBehind = call();
    q.enqueue('trackScreen', limited);
    q.enqueue('trackScreen', queuedBehind);
    q.flush().catch(() => {});

    await vi.advanceTimersByTimeAsync(500);
    expect(queuedBehind).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(limited).toHaveBeenCalledTimes(1);
    expect(queuedBehind).toHaveBeenCalledTimes(1);
  });

  it('still retries 5xx with backoff and drops after max retries', async () => {
    const failing = call(() => httpError(503));
    q.enqueue('trackEvent', failing);
    q.flush().catch(() => {});

    await vi.advanceTimersByTimeAsync(60_000);

    expect(failing).toHaveBeenCalledTimes(3);
    expect(q.queueSize()).toBe(0);
  });

  it('guard: sends queued items in the order they were queued', async () => {
    const order: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      q.enqueue('trackEvent', async () => {
        order.push(name);
        await new Promise((r) => setTimeout(r, 50));
      });
    }
    q.flush().catch(() => {});
    await vi.advanceTimersByTimeAsync(1_000);

    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('guard: flushes queued items when the app returns to the foreground', async () => {
    q.startAppStateListener();
    const fn = call();
    q.enqueue('trackEvent', fn); // queued, not flushed yet

    setAppState('background');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).not.toHaveBeenCalled();

    setAppState('active');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(q.queueSize()).toBe(0);
    q.stopAppStateListener();
  });
});
