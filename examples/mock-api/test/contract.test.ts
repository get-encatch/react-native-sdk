/**
 * Contract tests for the mock API. Each block names the encatch-user source it
 * copies (branch Mil-2026-v2-release-10). See CONTRACT.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFeedbackDetailsResponseSchema } from '@encatch/schema';
import {
  createMockApi,
  DEFAULT_API_KEY,
  DEFAULT_FORM_ID,
  DEFAULT_SECRET,
  DEFAULT_SECURE_API_KEY,
  DEFAULT_SECURE_SESSION_API_KEY,
  expectedUserId,
  hmacHex,
  type MockApi,
} from '../src';

const BASE = 'http://mock.local/engage-product/encatch/api/v2/encatch';

let mock: MockApi;

function headersFor(opts: { user?: string; userId?: string; device?: string; apiKey?: string | null } = {}) {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Session-Id': '0190f1d2-0000-7000-8000-0000000000aa',
    'X-Device-Id': opts.device ?? '0190f1d2-0000-7000-8000-0000000000dd',
    Referer: 'com.example.app',
  };
  if (opts.apiKey !== null) h['X-Api-Key'] = opts.apiKey ?? DEFAULT_API_KEY;
  if (opts.user) {
    h['X-User-Name'] = opts.user;
    h['X-User-Id'] = opts.userId ?? expectedUserId(mock.state, opts.user);
  }
  return h;
}

async function call(endpoint: string, body: unknown = {}, headers: Record<string, string> = headersFor()) {
  const res = await mock.fetch(`${BASE}/${endpoint}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

beforeEach(() => {
  mock = createMockApi({ scenario: { latencyMs: 0 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('routing (gateway ugw-core/src/config.rs:229-237)', () => {
  it('serves the SDK path and the gateway path', async () => {
    expect((await call('ping')).status).toBe(200);
    const res = await mock.fetch('http://mock.local/v2/encatch/ping', {
      method: 'POST',
      headers: headersFor(),
      body: '{}',
    });
    expect(res.status).toBe(200);
  });

  it('answers unknown routes with 404 {"error":"route not found"}', async () => {
    const res = await call('no-such-endpoint');
    expect(res).toMatchObject({ status: 404, body: { error: 'route not found' } });
  });
});

describe('gateway auth (ugw-proxy/src/lib.rs:306-423)', () => {
  it('rejects a missing API key', async () => {
    expect(await call('ping', {}, headersFor({ apiKey: null }))).toMatchObject({
      status: 401,
      body: { error: 'api key is required' },
    });
  });

  it('rejects an empty Referer', async () => {
    const h = headersFor();
    delete (h as any).Referer;
    expect(await call('ping', {}, h)).toMatchObject({ status: 401, body: { error: 'referer is required' } });
  });

  it('rejects an unknown key', async () => {
    expect(await call('ping', {}, headersFor({ apiKey: 'nope' }))).toMatchObject({
      status: 401,
      body: { error: 'invalid api key' },
    });
  });
});

describe('ping timing (core-api config.rs:440-464, services/identify_user.rs:173)', () => {
  it('identify answers a new (uncached) user with pingAgainIn 10, a user seen before with 30', async () => {
    const first = await call('identify-user', { userName: 'newbie' }, { ...headersFor(), 'X-User-Name': 'newbie' });
    expect(first.body.pingAgainIn).toBe(10);
    const again = await call('identify-user', { userName: 'newbie' }, { ...headersFor(), 'X-User-Name': 'newbie' });
    expect(again.body.pingAgainIn).toBe(30);
  });
});

describe('secure identify (ugw-auth/src/session.rs)', () => {
  const identify = (extra: Record<string, string>, apiKey: string) =>
    call('identify-user', { userName: 'alice' }, { ...headersFor({ apiKey }), 'X-User-Name': 'alice', ...extra });

  it('key with a secret: accepts a valid signature, rejects a wrong or missing one', async () => {
    expect((await identify({ 'X-User-Signature': hmacHex('alice', DEFAULT_SECRET) }, DEFAULT_SECURE_API_KEY)).status).toBe(200);
    expect((await identify({ 'X-User-Signature': hmacHex('bob', DEFAULT_SECRET) }, DEFAULT_SECURE_API_KEY)).status).toBe(401);
    expect(await identify({}, DEFAULT_SECURE_API_KEY)).toMatchObject({ status: 401, body: { error: 'invalid api key' } });
  });

  it('key with a session time: signs userName + X-User-Session-Time', async () => {
    const ts = String(Date.now());
    const sig = hmacHex(`alice${ts}`, DEFAULT_SECRET);
    expect((await identify({ 'X-User-Signature': sig, 'X-User-Session-Time': ts }, DEFAULT_SECURE_SESSION_API_KEY)).status).toBe(200);
  });

  it('key with a session time: X-User-Signature-Time alone is not read (the SDK bug)', async () => {
    const ts = String(Date.now());
    const sig = hmacHex(`alice${ts}`, DEFAULT_SECRET);
    expect((await identify({ 'X-User-Signature': sig, 'X-User-Signature-Time': ts }, DEFAULT_SECURE_SESSION_API_KEY)).status).toBe(401);
  });

  it('key with a session time: rejects an expired timestamp', async () => {
    const ts = String(Date.now() - 20 * 60_000);
    const sig = hmacHex(`alice${ts}`, DEFAULT_SECRET);
    expect((await identify({ 'X-User-Signature': sig, 'X-User-Session-Time': ts }, DEFAULT_SECURE_SESSION_API_KEY)).status).toBe(401);
  });

  it('SV8 (opt-in): checks the signature and expiry on every request for keys with a secret', async () => {
    mock.update({ enforceSignatureOnAllRequests: true });
    const ts = String(Date.now());
    const signed = {
      ...headersFor({ apiKey: DEFAULT_SECURE_SESSION_API_KEY, user: 'alice' }),
      'X-User-Signature': hmacHex(`alice${ts}`, DEFAULT_SECRET),
      'X-User-Session-Time': ts,
    };
    expect((await call('track-event', { eventName: 'e' }, signed)).status).toBe(200);
    const unsigned = headersFor({ apiKey: DEFAULT_SECURE_SESSION_API_KEY, user: 'alice' });
    expect(await call('track-event', { eventName: 'e' }, unsigned)).toMatchObject({ status: 401, body: { error: 'invalid api key' } });
    // Visitors carry no X-User-Name, so there is nothing to check.
    expect((await call('ping', {}, headersFor({ apiKey: DEFAULT_SECURE_SESSION_API_KEY }))).status).toBe(200);
  });

  it('SV8 (opt-in): an expired session-time signature is rejected on every request', async () => {
    mock.update({ enforceSignatureOnAllRequests: true });
    const ts = String(Date.now() - 20 * 60_000); // 20 min old, key allows 15
    const expired = {
      ...headersFor({ apiKey: DEFAULT_SECURE_SESSION_API_KEY, user: 'alice' }),
      'X-User-Signature': hmacHex(`alice${ts}`, DEFAULT_SECRET),
      'X-User-Session-Time': ts,
    };
    expect((await call('ping', {}, expired)).status).toBe(401);
  });

  it('only checks identify-user', async () => {
    expect((await call('ping', {}, headersFor({ apiKey: DEFAULT_SECURE_API_KEY }))).status).toBe(200);
  });
});

describe('core required headers and identity (extractors/headers.rs, validate_user_identity.rs)', () => {
  it('requires X-Session-Id and X-Device-Id', async () => {
    const h = headersFor();
    delete (h as any)['X-Session-Id'];
    expect(await call('ping', {}, h)).toMatchObject({
      status: 400,
      body: { status: 400, message: 'Missing required header: X-Session-Id' },
    });
  });

  it('rejects X-User-Name without X-User-Id, and the reverse', async () => {
    const nameOnly = { ...headersFor(), 'X-User-Name': 'alice' };
    const idOnly = { ...headersFor(), 'X-User-Id': expectedUserId(mock.state, 'alice') };
    const msg = 'X-User-Name and X-User-Id must both be present or both absent';
    expect(await call('track-event', { eventName: 'e' }, nameOnly)).toMatchObject({ status: 401, body: { message: msg } });
    expect(await call('track-event', { eventName: 'e' }, idOnly)).toMatchObject({ status: 401, body: { message: msg } });
  });

  it("rejects another user's id", async () => {
    const res = await call('ping', {}, headersFor({ user: 'bob', userId: expectedUserId(mock.state, 'alice') }));
    expect(res.status).toBe(401);
  });

  it('does not apply the identity rule to identify-user', async () => {
    expect((await call('identify-user', { userName: 'alice' }, { ...headersFor(), 'X-User-Name': 'alice' })).status).toBe(200);
  });
});

describe('identify-user (handlers/encatch.rs:400-652)', () => {
  it('returns the UUIDv5 userId that later requests must send', async () => {
    const res = await call('identify-user', { userName: 'alice' });
    expect(res.body).toMatchObject({ message: 'ok', userId: expectedUserId(mock.state, 'alice'), pingOnNextPageVisit: true });
    expect((await call('ping', {}, headersFor({ user: 'alice', userId: res.body.userId }))).status).toBe(200);
  });

  it('requires userName', async () => {
    expect(await call('identify-user', {})).toMatchObject({ status: 401, body: { message: 'userName not found' } });
  });
});

describe('track-event (handlers/encatch.rs:1674-1921, services/track_event.rs)', () => {
  it.each(['form:show', 'form:started', 'form:answered', 'form:complete', 'form:dismissed'])(
    'answers a visitor %s with 403',
    async (eventName) => {
      expect(await call('track-event', { eventName })).toEqual({
        status: 403,
        body: { message: 'Event tracking not allowed for visitors' },
        headers: expect.anything(),
      });
    }
  );

  it('allows custom visitor events only with allowTrackEventForVisitors', async () => {
    expect((await call('track-event', { eventName: 'clicked' })).status).toBe(403);
    mock.update({ allowTrackEventForVisitors: true });
    expect((await call('track-event', { eventName: 'clicked' })).status).toBe(200);
  });

  it('accepts survey events from identified users', async () => {
    expect((await call('track-event', { eventName: 'form:show' }, headersFor({ user: 'alice' }))).status).toBe(200);
  });

  it('rejects disabled events and names over 100 characters', async () => {
    mock.update({ disabledEvents: ['blocked'] });
    expect((await call('track-event', { eventName: 'blocked' }, headersFor({ user: 'alice' }))).status).toBe(400);
    expect((await call('track-event', { eventName: 'x'.repeat(101) }, headersFor({ user: 'alice' }))).status).toBe(400);
  });
});

describe('survey triggers (apply_display_result!, display_feedback.rs:76-79)', () => {
  it('track-screen: nextFeedbackId, onPageDelay and pingAgainIn = 30 + delay', async () => {
    mock.update({ triggers: { screens: { '/checkout': { formId: DEFAULT_FORM_ID, onPageDelay: 2 } } } });
    const res = await call('track-screen', { $deviceInfo: { $urlOrScreenName: '/checkout' } });
    expect(res.body).toEqual({
      message: 'ok',
      nextFeedbackId: DEFAULT_FORM_ID,
      onPageDelay: 2,
      pingAgainIn: 32,
      pingOnNextPageVisit: true,
    });
    expect((await call('track-screen', { $deviceInfo: { $urlOrScreenName: '/home' } })).body.nextFeedbackId).toBeUndefined();
  });

  it('identify, ping and track-event can carry a survey too', async () => {
    const t = { formId: DEFAULT_FORM_ID, onPageDelay: 0 };
    mock.update({ triggers: { identify: t, ping: t, events: { purchase: t } } });
    expect((await call('identify-user', { userName: 'alice' })).body.nextFeedbackId).toBe(DEFAULT_FORM_ID);
    expect((await call('ping', {}, headersFor({ user: 'alice' }))).body.nextFeedbackId).toBe(DEFAULT_FORM_ID);
    expect((await call('track-event', { eventName: 'purchase' }, headersFor({ user: 'alice' }))).body.nextFeedbackId).toBe(DEFAULT_FORM_ID);
  });

  it('never sends formConfigurationId', async () => {
    mock.update({ triggers: { screens: { '/x': { formId: DEFAULT_FORM_ID } } } });
    const res = await call('track-screen', { $deviceInfo: { $urlOrScreenName: '/x' } });
    expect(res.body).not.toHaveProperty('formConfigurationId');
  });
});

describe('show-form (handlers/encatch.rs:3001-3158, services/show_form.rs)', () => {
  it('returns a reply that passes @encatch/schema (plus the server-only partialResponseEnabled)', async () => {
    const res = await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'manual' });
    expect(res.status).toBe(200);
    // core-api always sends partialResponseEnabled (models/response.rs), but
    // @encatch/schema 1.5.2 is strict and does not list it. Check the rest.
    const { partialResponseEnabled, ...rest } = res.body;
    expect(partialResponseEnabled).toBe(false);
    const parsed = fetchFeedbackDetailsResponseSchema.safeParse(rest);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
  });

  it('automatic: 1 × 200 then 404 "not eligible" (the production burst)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 17; i++) {
      statuses.push((await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'automatic' })).status);
    }
    expect(statuses).toEqual([200, ...Array(16).fill(404)]);
    const last = await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'automatic' });
    expect(last.body.message).toBe('Form not available: User is not eligible for this form');
  });

  it('manual shows are not limited by the automatic cooldown', async () => {
    await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'automatic' });
    expect((await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'manual' })).status).toBe(200);
  });

  it('404 for an unknown form, and for visitors when visitors are disabled', async () => {
    expect((await call('show-form', { formSlugOrId: 'nope' })).status).toBe(404);
    mock.update({ visitorsEnabled: false });
    expect((await call('show-form', { formSlugOrId: DEFAULT_FORM_ID })).status).toBe(404);
  });

  it('requires formSlugOrId', async () => {
    expect((await call('show-form', {})).status).toBe(400);
  });
});

describe('submit-form and dismiss-form (services/submit_form.rs:408-437, handlers/encatch.rs:3163-3341)', () => {
  const submit = (h = headersFor({ user: 'alice' })) =>
    call('submit-form', { triggerType: 'automatic', formDetails: { formConfigurationId: DEFAULT_FORM_ID, response: {} } }, h);

  it('accepts a submit', async () => {
    expect(await submit()).toMatchObject({ status: 200, body: { message: 'ok' } });
  });

  it('report section 4: a burst while the survey is open makes the submit 404', async () => {
    mock.update({ burstDropsOpenForm: true });
    const h = headersFor({ user: 'alice' });
    await call('show-form', { formSlugOrId: DEFAULT_FORM_ID, triggerType: 'automatic' }, h);
    await call('track-event', { eventName: 'something' }, h);
    expect((await submit(h)).status).toBe(404);
  });

  it('dismiss: ok for visitors; a known user needs a UUID formConfigurationId', async () => {
    expect((await call('dismiss-form', {})).body).toEqual({ message: 'ok' });
    expect((await call('dismiss-form', { formConfigurationId: 'x' }, headersFor({ user: 'alice' }))).status).toBe(400);
    expect(
      (await call('dismiss-form', { formConfigurationId: DEFAULT_FORM_ID }, headersFor({ user: 'alice' }))).body
    ).toEqual({ message: 'ok', pingOnNextPageVisit: true });
  });
});

describe('user pending (handlers/encatch.rs:694-729, config.rs:448-458)', () => {
  it('flags userPendingRetryExhausted (camelCase) after 5 tries', async () => {
    mock.update({ userPending: { enabled: true } });
    const h = headersFor({ user: 'alice' });
    const replies = [];
    for (let i = 0; i < 5; i++) replies.push((await call('ping', {}, h)).body);
    expect(replies[0]).toMatchObject({ pingAgainIn: 10 });
    expect(replies[0]).not.toHaveProperty('userPendingRetryExhausted');
    expect(replies[4]).toMatchObject({ pingAgainIn: 900, userPendingRetryExhausted: true });
  });
});

describe('rate limits (ugw-ratelimit)', () => {
  it('per-endpoint-5: the 6th identify gets 429 with Retry-After and X-RateLimit-*', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    mock.update({ preset: 'per-endpoint-5' });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call('identify-user', { userName: 'alice' })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

    const limited = await call('identify-user', { userName: 'alice' });
    expect(limited.body).toEqual({ error: 'rate limit exceeded' });
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(limited.headers.get('X-RateLimit-Remaining')).toBe('0');

    // Other endpoints have their own bucket.
    expect((await call('ping')).status).toBe(200);

    // The window resets.
    vi.setSystemTime(new Date('2026-11-09T10:01:00Z'));
    expect((await call('identify-user', { userName: 'alice' })).status).toBe(200);
  });

  it('planned-prod: identify is limited per user name', async () => {
    mock.update({ preset: 'planned-prod' });
    for (let i = 0; i < 5; i++) await call('identify-user', { userName: 'alice' });
    expect((await call('identify-user', { userName: 'alice' })).status).toBe(429);
    expect((await call('identify-user', { userName: 'bob' })).status).toBe(200);
  });

  it('scopes: one shared bucket for every endpoint; user scope only with X-User-Id', async () => {
    mock.update({ preset: 'code-defaults-test' }); // user 10, ip 50, project 50
    const alice = headersFor({ user: 'alice' });
    for (let i = 0; i < 10; i++) await call(i % 2 ? 'ping' : 'track-screen', {}, alice);
    expect((await call('show-form', { formSlugOrId: DEFAULT_FORM_ID }, alice)).status).toBe(429);
    // A visitor has no X-User-Id, so only IP and project apply.
    expect((await call('ping')).status).toBe(200);
  });

  it('rejected requests do not use quota', async () => {
    mock.update({ preset: 'tiny' }); // ip 5
    for (let i = 0; i < 5; i++) await call('ping');
    for (let i = 0; i < 10; i++) expect((await call('ping')).status).toBe(429);
    expect(mock.state.windows.get('ip:127.0.0.1')?.count).toBe(5);
  });
});

describe('faults, streaming, upload and the control API', () => {
  it('injects a status with Retry-After, then behaves normally', async () => {
    mock.update({ faults: [{ endpoint: 'track-event', count: 1, status: 429, retryAfterSeconds: 7 }] });
    const first = await call('track-event', { eventName: 'e' }, headersFor({ user: 'alice' }));
    expect(first.status).toBe(429);
    expect(first.headers.get('Retry-After')).toBe('7');
    expect((await call('track-event', { eventName: 'e' }, headersFor({ user: 'alice' }))).status).toBe(200);
  });

  it('matches a fault to a request body, and can only delay it', async () => {
    vi.useFakeTimers();
    mock.update({ faults: [{ endpoint: 'identify-user', count: 1, match: { userName: 'bob' }, delayMs: 1_000 }] });
    const alice = call('identify-user', { userName: 'alice' });
    const bob = call('identify-user', { userName: 'bob' });
    await vi.advanceTimersByTimeAsync(10);
    expect((await alice).status).toBe(200);
    let bobDone = false;
    bob.then(() => (bobDone = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(bobDone).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect((await bob).status).toBe(200); // delayed, then answered normally
  });

  it('sends Retry-After as an exact value, such as an HTTP date', async () => {
    const date = 'Mon, 09 Nov 2026 10:00:30 GMT';
    mock.update({ faults: [{ endpoint: 'ping', count: 1, status: 429, retryAfter: date }] });
    expect((await call('ping')).headers.get('Retry-After')).toBe(date);
  });

  it('drops the connection: fetch rejects', async () => {
    mock.update({ faults: [{ endpoint: 'ping', count: 1, drop: true }] });
    await expect(call('ping')).rejects.toThrow('Network request failed');
  });

  it('streams qna-with-ai as SSE chunk and done events', async () => {
    const res = await call('qna-with-ai/stream', {
      questionId: 'q',
      feedbackConfigurationId: DEFAULT_FORM_ID,
      conversation: [{ question: 'q', answer: 'a' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('event: chunk');
    expect(res.body).toContain('event: done');
  });

  it('accepts a multipart upload', async () => {
    const form = new FormData();
    form.set('formId', DEFAULT_FORM_ID);
    form.set('questionId', 'q');
    form.set('file', new Blob(['hello']), 'hello.txt');
    const h = headersFor();
    delete (h as any)['Content-Type'];
    const res = await mock.fetch(`${BASE}/upload`, { method: 'POST', headers: h, body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).fileUrl).toMatch(/^https:\/\/mock-api\.local\/uploads\//);
  });

  it('counts requests per endpoint and status, masks the API key, and resets', async () => {
    await call('ping');
    await call('track-event', { eventName: 'form:show' });
    const stats = (await (await mock.fetch('http://mock.local/__mock/stats')).json()) as any;
    expect(stats.byEndpoint['track-event'].byStatus['403']).toBe(1);
    expect(stats.byEndpoint.ping.total).toBe(1);
    expect(mock.requests()[0].headers['x-api-key']).toBe('***');

    await mock.fetch('http://mock.local/__mock/reset', { method: 'POST' });
    expect(mock.stats().total).toBe(0);
  });

  it('signs a user name like the customer backend (/__mock/sign), for keys with and without a session time', async () => {
    const sign = async (apiKey: string) =>
      (await (await mock.fetch(`http://mock.local/__mock/sign?userName=alice&apiKey=${apiKey}`)).json()) as any;
    const plain = await sign(DEFAULT_SECURE_API_KEY);
    const identify = (apiKey: string, extra: Record<string, string>) =>
      call('identify-user', { userName: 'alice' }, { ...headersFor({ apiKey }), 'X-User-Name': 'alice', ...extra });
    expect((await identify(DEFAULT_SECURE_API_KEY, { 'X-User-Signature': plain.signature })).status).toBe(200);
    const session = await sign(DEFAULT_SECURE_SESSION_API_KEY);
    expect(
      (await identify(DEFAULT_SECURE_SESSION_API_KEY, { 'X-User-Signature': session.signature, 'X-User-Session-Time': session.time })).status
    ).toBe(200);
    expect((await mock.fetch('http://mock.local/__mock/sign?userName=alice&apiKey=mock-api-key')).status).toBe(400);
  });

  it('stores debug-hook reports (/__mock/hooks) outside the request log, and reset clears them', async () => {
    await mock.fetch('http://mock.local/__mock/hooks', { method: 'POST', body: JSON.stringify({ hook: 'onRequest' }) });
    const hooks = (await (await mock.fetch('http://mock.local/__mock/hooks')).json()) as any[];
    expect(hooks).toHaveLength(1);
    expect(hooks[0]).toMatchObject({ hook: 'onRequest', receivedAt: expect.any(Number) });
    expect(mock.stats().total).toBe(0);
    await mock.fetch('http://mock.local/__mock/reset', { method: 'POST' });
    expect(await (await mock.fetch('http://mock.local/__mock/hooks')).json()).toEqual([]);
  });

  it('switches presets through the control API', async () => {
    const res = await mock.fetch('http://mock.local/__mock/scenario', {
      method: 'POST',
      body: JSON.stringify({ preset: 'per-endpoint-5' }),
    });
    expect(((await res.json()) as any).rateLimit.mode).toBe('per-endpoint');
  });
});
