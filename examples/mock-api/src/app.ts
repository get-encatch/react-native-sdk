import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { handleCore } from './core';
import { runGateway } from './gateway';
import { defaultScenario, ENDPOINTS, mergeScenario, RATE_LIMIT_PRESETS, type EndpointName, type RateLimitConfig, type RateLimitPreset, type Scenario } from './scenario';
import { hmacHex } from './signature';
import { MockState, type LogEntry } from './state';

/** `/engage-product/encatch/api` is stripped by an ingress in front of the gateway. */
const ROUTE = /^\/(?:engage-product\/encatch\/api\/)?v2\/encatch\/(.+)$/;
/** Status used internally to signal "drop the connection" (see Fault.drop). */
export const DROP_STATUS = 599;

export interface MockApiOptions {
  /** Starting scenario, merged over the defaults. `reset()` returns to it. */
  scenario?: Record<string, unknown>;
  /** Starting rate-limit preset. */
  preset?: RateLimitPreset;
}

export function createMockApi(options: MockApiOptions = {}) {
  let initial: Scenario = defaultScenario();
  if (options.preset) initial.rateLimit = structuredClone(RATE_LIMIT_PRESETS[options.preset]) as RateLimitConfig;
  if (options.scenario) initial = mergeScenario(initial, options.scenario);
  const state = new MockState(initial);
  const app = new Hono();

  // ── Control API (never part of the Encatch contract) ───────────────────────
  app.get('/__mock/health', (c) => c.json({ ok: true }));
  app.get('/__mock/requests', (c) => {
    const endpoint = c.req.query('endpoint');
    const limit = Number(c.req.query('limit') ?? 500);
    const rows = endpoint ? state.log.filter((e) => e.endpoint === endpoint) : state.log;
    return c.json(rows.slice(-limit));
  });
  app.get('/__mock/stats', (c) => c.json(state.stats()));
  app.get('/__mock/scenario', (c) => c.json(state.scenario));
  app.post('/__mock/scenario', async (c) => {
    const patch = await c.req.json().catch(() => ({}));
    try {
      return c.json(state.update(patch));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  // Stand-in for the customer's backend in secure mode: signs a user name the way
  // the gateway checks it (hex HMAC-SHA256 of the name, plus the time for keys with
  // a session time). Lets the example app test secure identify without a real backend.
  app.get('/__mock/sign', (c) => {
    const userName = c.req.query('userName') ?? '';
    const key = state.scenario.apiKeys[c.req.query('apiKey') ?? ''];
    if (!userName || !key?.secret) return c.json({ error: 'userName and a secure apiKey are required' }, 400);
    // Keys with a session time sign the name plus the time; others sign the name only.
    if ((key.sessionTimeMinutes ?? 0) > 0) {
      const time = String(Date.now());
      return c.json({ signature: hmacHex(`${userName}${time}`, key.secret), time });
    }
    return c.json({ signature: hmacHex(userName, key.secret) });
  });
  // The example app reports its onRequest / onResponse debug-hook calls here (E2E flow E11).
  app.get('/__mock/hooks', (c) => c.json(state.hooks));
  app.post('/__mock/hooks', async (c) => {
    const report = await c.req.json().catch(() => null);
    state.hooks.push(report && typeof report === 'object' ? { ...report, receivedAt: Date.now() } : report);
    return c.json({ ok: true });
  });
  app.post('/__mock/reset', (c) => {
    state.reset({ scenario: c.req.query('keepScenario') !== '1' });
    return c.json({ ok: true });
  });

  // ── Encatch API: gateway, then core ────────────────────────────────────────
  app.all('*', async (c) => {
    const started = Date.now();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const match = c.req.path.match(ROUTE);
    const endpoint = (match && ENDPOINTS.includes(match[1] as EndpointName) ? match[1] : null) as EndpointName | null;

    let body: any = undefined;
    if (endpoint === 'upload') {
      body = await c.req.parseBody().catch(() => ({}));
    } else {
      body = await c.req.json().catch(() => undefined);
    }

    const entry: LogEntry = {
      seq: state.nextSeq(),
      at: started,
      method: c.req.method,
      path: c.req.path,
      endpoint,
      headers: { ...headers, ...(headers['x-api-key'] ? { 'x-api-key': '***' } : {}) },
      body: endpoint === 'upload' ? Object.keys(body ?? {}) : body,
      status: 0,
      durationMs: 0,
      layer: 'gateway',
      rateLimited: false,
    };
    state.log.push(entry);
    const finish = (status: number, layer: LogEntry['layer'], rateLimited = false) => {
      entry.status = status;
      entry.layer = layer;
      entry.rateLimited = rateLimited;
      entry.durationMs = Date.now() - started;
    };

    // Latency first, like a real network.
    const sc = state.scenario;
    const delay = sc.latencyMs + (sc.jitterMs > 0 ? Math.floor(Math.random() * sc.jitterMs) : 0);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    if (c.req.method !== 'POST' || !endpoint) {
      finish(404, 'gateway');
      return c.json({ error: 'route not found' }, 404);
    }

    // Injected faults (consumed in order).
    const matches = (m?: Record<string, unknown>) =>
      !m || Object.entries(m).every(([k, v]) => body && typeof body === 'object' && (body as any)[k] === v);
    const fault = sc.faults.find((f) => f.endpoint === endpoint && f.count > 0 && matches(f.match));
    if (fault) {
      fault.count -= 1;
      if (fault.delayMs) await new Promise((r) => setTimeout(r, fault.delayMs));
      if (fault.drop) {
        finish(DROP_STATUS, 'fault');
        return c.body(null, DROP_STATUS as any);
      }
      if (fault.status != null) {
        const status = fault.status;
        finish(status, 'fault', status === 429);
        const extra: Record<string, string> = {};
        if (fault.retryAfterSeconds != null) extra['Retry-After'] = String(fault.retryAfterSeconds);
        if (fault.retryAfter != null) extra['Retry-After'] = fault.retryAfter;
        if (extra['Retry-After'] != null) entry.retryAfter = extra['Retry-After'];
        return c.json((fault.body ?? { error: 'injected fault' }) as object, status as any, extra);
      }
      // Delay only: carry on as a normal request.
    }

    const query: Record<string, string> = {};
    for (const [k, v] of new URL(c.req.url).searchParams) query[k] = v;
    const gw = runGateway(state, { endpoint, headers, query, body });
    if (!gw.ok) {
      finish(gw.status, 'gateway', gw.rateLimited);
      const retryAfter = gw.headers?.['Retry-After'];
      if (retryAfter != null) entry.retryAfter = retryAfter;
      return c.json(gw.body, gw.status as any, gw.headers);
    }

    const reply = handleCore(state, endpoint, headers, body);
    finish(reply.status, 'core');
    if (reply.sse) {
      for (const [k, v] of Object.entries(gw.headers)) c.header(k, v);
      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('X-Accel-Buffering', 'no');
      const events = reply.sse;
      return streamSSE(c, async (stream) => {
        for (const e of events) await stream.writeSSE({ event: e.event, data: JSON.stringify(e.data) });
      });
    }
    return c.json(reply.body as object, reply.status as any, gw.headers);
  });

  /**
   * In-process fetch for tests: no sockets. Accepts any base URL. A dropped
   * connection (Fault.drop) rejects like a real network failure.
   */
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    // Honour AbortSignal like a real fetch: reject as soon as it aborts, even if
    // the (simulated) server is still "working" on the request.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const aborted = new Promise<never>((_, reject) => {
      const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) fail();
      signal?.addEventListener('abort', fail, { once: true });
    });
    const res = await Promise.race([app.fetch(req), aborted]);
    if (res.status === DROP_STATUS) throw new TypeError('Network request failed');
    return res;
  };

  return {
    app,
    state,
    fetch,
    /** Applies a rate-limit preset and/or a partial scenario. */
    update: (patch: { preset?: RateLimitPreset } & Record<string, unknown>) => state.update(patch),
    reset: (opts?: { scenario?: boolean }) => state.reset(opts),
    requests: (endpoint?: string) => (endpoint ? state.log.filter((e) => e.endpoint === endpoint) : state.log),
    stats: () => state.stats(),
  };
}

export type MockApi = ReturnType<typeof createMockApi>;
