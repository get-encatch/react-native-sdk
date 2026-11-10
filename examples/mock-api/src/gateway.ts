/**
 * Gateway layer (user-gateway-service). Order of checks as in ugw-proxy/src/lib.rs:
 * route → API key → Referer → key validity / referer allowed / identify signature → rate limit.
 * Every rejection is JSON `{"error": "..."}`.
 */
import type { EndpointName, RateLimitKey } from './scenario';
import { checkIdentifySignature } from './signature';
import type { MockState } from './state';

export interface GatewayRequest {
  endpoint: EndpointName;
  /** Lower-case header map. */
  headers: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body (for identify's userName when limiting by user name). */
  body: any;
}

export type GatewayResult =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; status: number; body: { error: string }; headers: Record<string, string>; rateLimited: boolean };

const reject = (status: number, error: string, rateLimited = false, headers: Record<string, string> = {}): GatewayResult => ({
  ok: false,
  status,
  body: { error },
  headers,
  rateLimited,
});

/** Client IP as the gateway reads it (http_util.rs): X-Real-Ip, else first X-Forwarded-For, else 127.0.0.1. */
export function clientIp(headers: Record<string, string>): string {
  return (
    headers['x-real-ip']?.trim() ||
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

export function runGateway(state: MockState, req: GatewayRequest, now: number = Date.now()): GatewayResult {
  const sc = state.scenario;
  const apiKey = req.headers['x-api-key'] || req.query['X-Api-Key'];
  if (!apiKey) return reject(401, 'api key is required');

  const referer = req.headers['referer'] ?? '';
  if (!referer) return reject(401, 'referer is required');

  const key = sc.apiKeys[apiKey];
  if (!key) return reject(401, 'invalid api key');
  const refererAllowed =
    key.allowedReferers.includes('*') ||
    key.allowedReferers.some((r) => r.toLowerCase() === referer.toLowerCase());
  if (!refererAllowed) return reject(401, 'invalid api key');

  // Today the gateway checks the signature on identify-user only; SV8 extends
  // it to every request for keys with a secret (visitors, with no X-User-Name,
  // are not checked either way).
  if (req.endpoint === 'identify-user' || (sc.enforceSignatureOnAllRequests && key.secret)) {
    const sig = checkIdentifySignature(req.headers, key, now);
    if (sig !== 'ok') return reject(401, 'invalid api key');
  }

  return rateLimit(state, req, now);
}

function rateLimit(state: MockState, req: GatewayRequest, now: number): GatewayResult {
  const rl = state.scenario.rateLimit;
  if (rl.mode === 'off') return { ok: true, headers: {} };

  // Buckets that apply to this request: [storage key, limit].
  const buckets: Array<[string, number]> = [];
  if (rl.mode === 'scopes') {
    const userId = req.headers['x-user-id']?.trim();
    if (rl.scopes.user != null && userId) buckets.push([`user:${userId}`, rl.scopes.user]);
    if (rl.scopes.ip != null) buckets.push([`ip:${clientIp(req.headers)}`, rl.scopes.ip]);
    if (rl.scopes.project != null) buckets.push(['project', rl.scopes.project]);
  } else {
    const cfg = rl.perEndpoint[req.endpoint];
    if (cfg) buckets.push([`${req.endpoint}:${bucketId(cfg.key, req)}`, cfg.limit]);
  }
  if (buckets.length === 0) return { ok: true, headers: {} };

  // Fixed windows. All buckets are checked before any is incremented, so a
  // rejected request uses no quota (encatch_ugw_ratelimit.valkey.lua).
  const views = buckets.map(([k, limit]) => {
    let w = state.windows.get(k);
    if (!w || now >= w.resetAt) {
      w = { count: 0, resetAt: now + rl.windowMs };
      state.windows.set(k, w);
    }
    return { w, limit };
  });

  const denied = views.find((v) => v.w.count >= v.limit);
  if (denied) {
    const msLeft = Math.max(0, denied.w.resetAt - now);
    return reject(429, 'rate limit exceeded', true, {
      ...limitHeaders(denied.limit, 0, denied.w.resetAt),
      'Retry-After': String(Math.ceil(msLeft / 1000)),
    });
  }

  for (const v of views) v.w.count += 1;
  // Report the bucket with the least room left.
  const primary = views.reduce((a, b) => (b.limit - b.w.count < a.limit - a.w.count ? b : a));
  return { ok: true, headers: limitHeaders(primary.limit, primary.limit - primary.w.count, primary.w.resetAt) };
}

function bucketId(key: RateLimitKey, req: GatewayRequest): string {
  const h = req.headers;
  switch (key) {
    case 'userName': {
      const name = h['x-user-name']?.trim() || (typeof req.body?.userName === 'string' ? req.body.userName : '');
      return name ? `name:${name}` : `ip:${clientIp(h)}`;
    }
    case 'user':
      return h['x-user-id']?.trim() ? `user:${h['x-user-id'].trim()}` : `ip:${clientIp(h)}`;
    case 'device':
      return h['x-device-id']?.trim() ? `device:${h['x-device-id'].trim()}` : `ip:${clientIp(h)}`;
    case 'ip':
      return `ip:${clientIp(h)}`;
  }
}

function limitHeaders(limit: number, remaining: number, resetAt: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
  };
}
