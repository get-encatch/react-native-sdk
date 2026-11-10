import { defaultScenario, mergeScenario, RATE_LIMIT_PRESETS, type RateLimitConfig, type RateLimitPreset, type Scenario } from './scenario';

export interface LogEntry {
  seq: number;
  /** Clock time (ms) the request arrived. */
  at: number;
  method: string;
  path: string;
  /** Endpoint name, e.g. 'identify-user', or null when no route matched. */
  endpoint: string | null;
  /** Request headers, lower-case keys, with X-Api-Key masked. */
  headers: Record<string, string>;
  body: unknown;
  status: number;
  durationMs: number;
  /** Which layer answered. */
  layer: 'gateway' | 'core' | 'fault';
  rateLimited: boolean;
  /** The Retry-After header sent with a 429, if any. */
  retryAfter?: string;
}

export type Stats = {
  total: number;
  byStatus: Record<string, number>;
  byEndpoint: Record<string, { total: number; byStatus: Record<string, number> }>;
};

export class MockState {
  scenario: Scenario;
  private readonly initial: Scenario;
  log: LogEntry[] = [];
  /** Debug-hook calls reported by the example app (POST /__mock/hooks), oldest first. */
  hooks: unknown[] = [];
  private seq = 0;
  /** Rate-limit windows: bucket key → count and reset time. */
  windows = new Map<string, { count: number; resetAt: number }>();
  /** Automatic shows: `${person}|${formId}` → time shown (for the cooldown). */
  shown = new Map<string, number>();
  /** The survey currently open for each person (shown, not yet submitted/dismissed). */
  open = new Map<string, string>();
  /** Forms dropped from a person's display candidates: `${person}|${formId}`. */
  dropped = new Set<string>();
  /** User names identified before: the server answers a user it hasn't cached yet with pingAgainIn 10. */
  identifiedUsers = new Set<string>();
  /** User-pending failures per person (timestamps). */
  pendingFailures = new Map<string, number[]>();

  constructor(initial?: Scenario) {
    this.initial = structuredClone(initial ?? defaultScenario());
    this.scenario = structuredClone(this.initial);
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Clears traffic state. With `scenario: true`, also restores the starting scenario. */
  reset(opts: { scenario?: boolean } = { scenario: true }): void {
    if (opts.scenario !== false) this.scenario = structuredClone(this.initial);
    this.log = [];
    this.hooks = [];
    this.seq = 0;
    this.windows.clear();
    this.shown.clear();
    this.open.clear();
    this.dropped.clear();
    this.pendingFailures.clear();
    this.identifiedUsers.clear();
  }

  /** Applies a rate-limit preset and/or a partial scenario. */
  update(patch: { preset?: RateLimitPreset } & Record<string, unknown>): Scenario {
    const { preset, ...rest } = patch;
    if (preset) {
      const config = RATE_LIMIT_PRESETS[preset];
      if (!config) throw new Error(`Unknown rate-limit preset "${preset}"`);
      this.scenario.rateLimit = structuredClone(config) as RateLimitConfig;
      this.windows.clear();
    }
    if (Object.keys(rest).length > 0) this.scenario = mergeScenario(this.scenario, rest);
    return this.scenario;
  }

  stats(): Stats {
    const out: Stats = { total: 0, byStatus: {}, byEndpoint: {} };
    for (const e of this.log) {
      if (!e.endpoint) continue;
      const s = String(e.status);
      out.total += 1;
      out.byStatus[s] = (out.byStatus[s] ?? 0) + 1;
      const ep = (out.byEndpoint[e.endpoint] ??= { total: 0, byStatus: {} });
      ep.total += 1;
      ep.byStatus[s] = (ep.byStatus[s] ?? 0) + 1;
    }
    return out;
  }
}
