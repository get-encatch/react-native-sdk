import { vi } from 'vitest';
import { __resetStorage } from './mocks/async-storage';
import {
  createMockApi,
  DEFAULT_API_KEY,
  expectedUserId,
  type MockApi,
  type MockApiOptions,
} from '../examples/mock-api/src';
import type { LogEntry } from '../examples/mock-api/src/state';

export interface RecordedRequest {
  /** Endpoint name, e.g. 'identify-user', 'track-event', 'show-form'. */
  endpoint: string;
  body: any;
  /** Request headers; look-ups are case-insensitive ('X-User-Name' or 'x-user-name'). */
  headers: Record<string, string>;
  /** Clock time (ms) the request arrived. */
  at: number;
  status: number;
}

/** Header map whose look-ups ignore case. */
function caseless(h: Record<string, string>): Record<string, string> {
  return new Proxy(h, {
    get: (t, k) => (typeof k === 'string' ? t[k.toLowerCase()] : undefined),
    has: (t, k) => typeof k === 'string' && k.toLowerCase() in t,
  });
}

const toRecorded = (e: LogEntry): RecordedRequest => ({
  endpoint: e.endpoint ?? '',
  body: e.body,
  headers: caseless(e.headers),
  at: e.at,
  status: e.status,
});

/**
 * Routes the SDK's `fetch` to an in-process mock API (examples/mock-api) that
 * behaves like the real gateway + core API. Default latency 50 ms.
 */
export function installMock(options: MockApiOptions = {}) {
  const mock: MockApi = createMockApi({
    ...options,
    scenario: { latencyMs: 50, ...(options.scenario ?? {}) },
  });
  vi.stubGlobal('fetch', mock.fetch);
  const all = () => mock.requests().filter((e) => e.endpoint).map(toRecorded);
  return {
    mock,
    /** Every Encatch API request so far. */
    get requests(): RecordedRequest[] {
      return all();
    },
    count: (endpoint: string) => all().filter((r) => r.endpoint === endpoint).length,
    of: (endpoint: string) => all().filter((r) => r.endpoint === endpoint),
    /** The X-User-Id the server expects for a user name. */
    userId: (userName: string) => expectedUserId(mock.state, userName),
  };
}

export type InstalledMock = ReturnType<typeof installMock>;

/**
 * Loads a fresh copy of the SDK (new singleton, empty retry queue, empty storage).
 * Fake timers must already be installed.
 */
export async function loadSdk() {
  vi.resetModules();
  __resetStorage();
  const core = await import('../src/encatch');
  const queue = await import('../src/retry-queue');
  const storage = (await import('./mocks/async-storage')).default;
  const rn = await import('./mocks/react-native');
  const registry = await import('../src/form-presentation-registry');
  return {
    Encatch: core.Encatch,
    emitter: core._internalEmitter,
    queue,
    storage,
    setAppState: rn.__setAppState,
    /** Inline slot registry, as used by EncatchInlineForm (same module instance as the SDK). */
    registry,
  };
}

/** Initialises the SDK against the mock, without the provider's automatic startSession(). */
export async function initSdk(
  Encatch: { init: (k: string, c?: any) => Promise<void> },
  config: Record<string, unknown> = {},
  apiKey: string = DEFAULT_API_KEY
) {
  await Encatch.init(apiKey, {
    apiBaseUrl: 'http://mock.local',
    appPackageId: 'com.example.test',
    ...config,
  });
}

/** Lets pending promises and timers up to `ms` run. */
export async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}
