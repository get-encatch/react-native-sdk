/**
 * Harness for characterising the PUBLISHED 1.4.3 package (npm alias `sdk-1.4.3`)
 * against the in-process mock API. Nothing here touches a real server.
 *
 * Host calls carry unique payloads (event `home_viewed#7`, screen `/home?n=7`,
 * identify trait n=7) so the metrics can tell a retry or duplicate of one call
 * apart from a new call. 1.4.3 does no collapsing, so this doesn't change its
 * behaviour.
 */
import { vi } from 'vitest';
import { createMockApi, DEFAULT_API_KEY, expectedUserId, type MockApi, type RateLimitPreset } from '../../examples/mock-api/src';
import type { LogEntry } from '../../examples/mock-api/src/state';

export type Identity = 'visitor' | 'new-user' | 'returning-user';
type Kind = 'identify' | 'event' | 'screen';

export interface Loaded {
  Encatch: any;
  mock: MockApi;
  host: Host;
  setAppState: (s: string) => void;
  dumpStorage: () => Record<string, string>;
}

export interface LoadOptions {
  preset: RateLimitPreset;
  identity: Identity;
  userName?: string;
  scenario?: Record<string, unknown>;
  /** Storage to start from (an app restart). */
  storage?: Record<string, string>;
  /** Call startSession() after init, as EncatchProvider does (immediate ping + 30 s pings). Default true. */
  provider?: boolean;
  /** Reuse an existing mock (keeps rate-limit windows), e.g. across an app restart. */
  mock?: MockApi;
}

export async function load143(opts: LoadOptions): Promise<Loaded> {
  const userName = opts.userName ?? 'alice';
  vi.resetModules();
  const storageMod = await import('../mocks/async-storage');
  const rn = await import('../mocks/react-native');
  storageMod.__resetStorage();

  const mock = opts.mock ?? createMockApi({ preset: opts.preset, scenario: { latencyMs: 50, ...(opts.scenario ?? {}) } });
  vi.stubGlobal('fetch', mock.fetch);

  if (opts.storage) storageMod.__loadStorage(opts.storage);
  else if (opts.identity === 'returning-user') {
    await storageMod.default.setItem('@encatch/user_name', userName);
    await storageMod.default.setItem(`@encatch/user_id_${userName}`, expectedUserId(mock.state, userName));
  }

  const { Encatch } = (await import('sdk-1.4.3')) as any;
  await Encatch.init(DEFAULT_API_KEY, { apiBaseUrl: 'http://mock.local', appPackageId: 'com.example.app' });
  if (opts.provider !== false) Encatch.startSession().catch(() => {});

  return {
    Encatch,
    mock,
    host: new Host(Encatch, userName, opts.identity),
    setAppState: rn.__setAppState,
    dumpStorage: storageMod.__dumpStorage,
  };
}

/** Plays the host app. Every call is unique and counted. */
export class Host {
  n = 0;
  calls: Record<Kind, number> = { identify: 0, event: 0, screen: 0 };
  constructor(private Encatch: any, public userName: string, public identity: Identity) {}

  identify(name = this.userName) {
    this.calls.identify += 1;
    const n = ++this.n;
    this.Encatch.identifyUser(name, { $set: { n } }).catch(() => {});
  }
  event(base = 'home_viewed') {
    this.calls.event += 1;
    this.Encatch.trackEvent(`${base}#${++this.n}`).catch(() => {});
  }
  screen(path = '/home') {
    this.calls.screen += 1;
    this.Encatch.trackScreen(`${path}?n=${++this.n}`).catch(() => {});
  }
  /** One round of the mixed pattern. Visitors don't identify. */
  mix() {
    if (this.identity !== 'visitor') this.identify();
    this.event();
    this.screen();
  }
}

export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** A stable key for "the same SDK call", ignoring device info and timing. */
function callKey(e: LogEntry): string {
  const b: any = e.body ?? {};
  switch (e.endpoint) {
    case 'identify-user':
      return `identify:${b.userName}:${b.userAttributes?.$set?.n ?? ''}`;
    case 'track-event':
      return `event:${b.eventName}`;
    case 'track-screen':
      return `screen:${b.$deviceInfo?.$urlOrScreenName}`;
    default:
      return `${e.endpoint}:${e.seq}`;
  }
}

export interface EndpointMetrics {
  hostCalls?: number;
  sent: number;
  distinct: number;
  /** Same call sent more than once before any reply (1.4.3's in-flight re-sends). */
  duplicates: number;
  /** Same call sent again after it got a 429. */
  resentAfter429: number;
  byStatus: Record<string, number>;
  /** Most requests that reached the server in any 60 s window. */
  maxPerMinute: number;
}

export interface Metrics {
  byEndpoint: Record<string, EndpointMetrics>;
  total: number;
  /** Requests (other than identify-user) with X-User-Name or X-User-Id but not both: the core API answers 401. */
  halfIdentity: number;
  status401: number;
  final: { userName: string | null; userId: string | null };
  /** Calls still waiting in the SDK's retry queue (as saved to AsyncStorage). */
  queueBacklog: number;
}

export function measure(l: Loaded, sinceSeq = 0): Metrics {
  const log = l.mock.requests().filter((e) => e.endpoint && e.seq > sinceSeq);
  const byEndpoint: Record<string, EndpointMetrics> = {};
  const hostKind: Record<string, Kind> = { 'identify-user': 'identify', 'track-event': 'event', 'track-screen': 'screen' };

  const groups = new Map<string, LogEntry[]>();
  for (const e of log) {
    const m = (byEndpoint[e.endpoint!] ??= {
      hostCalls: hostKind[e.endpoint!] ? l.host.calls[hostKind[e.endpoint!]] : undefined,
      sent: 0,
      distinct: 0,
      duplicates: 0,
      resentAfter429: 0,
      byStatus: {},
      maxPerMinute: 0,
    });
    m.sent += 1;
    m.byStatus[e.status] = (m.byStatus[e.status] ?? 0) + 1;
    const k = `${e.endpoint}|${callKey(e)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  for (const [k, entries] of groups) {
    const m = byEndpoint[k.split('|')[0]];
    m.distinct += 1;
    const first429 = entries.find((e) => e.status === 429);
    for (const e of entries.slice(1)) {
      if (first429 && e.at >= first429.at + first429.durationMs) m.resentAfter429 += 1;
      else m.duplicates += 1;
    }
  }
  for (const [ep, m] of Object.entries(byEndpoint)) {
    const times = log.filter((e) => e.endpoint === ep).map((e) => e.at).sort((a, b) => a - b);
    let j = 0;
    for (let i = 0; i < times.length; i++) {
      while (times[i] - times[j] >= 60_000) j++;
      m.maxPerMinute = Math.max(m.maxPerMinute, i - j + 1);
    }
  }
  return {
    byEndpoint,
    total: log.length,
    halfIdentity: log.filter(
      (e) => e.endpoint !== 'identify-user' && !!e.headers['x-user-name'] !== !!e.headers['x-user-id']
    ).length,
    status401: log.filter((e) => e.status === 401).length,
    final: { userName: l.Encatch.userName, userId: l.Encatch.userId },
    queueBacklog: (() => {
      try {
        return JSON.parse(l.dumpStorage()['@encatch/retry_queue'] ?? '[]').length;
      } catch {
        return -1;
      }
    })(),
  };
}

/** Collected by the tests; written to $CHAR_RESULTS (outside git) when set. */
export const results: Record<string, unknown> = {};
