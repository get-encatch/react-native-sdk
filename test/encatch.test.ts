/**
 * SDK behaviour tests against the in-process mock API (examples/mock-api), which
 * behaves like the real gateway + core API (see examples/mock-api/CONTRACT.md).
 *
 * Tests describe the behaviour 1.4.4 must have. Many fail on 1.4.3 by design;
 * the plan's fix steps turn them green. Tests marked "guard" pass today and must
 * keep passing.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FORM_ID,
  DEFAULT_SECRET,
  DEFAULT_SECURE_API_KEY,
  DEFAULT_SECURE_SESSION_API_KEY,
  SECOND_FORM_ID,
} from '../examples/mock-api/src';
import { hmacHex } from './gateway-signature';
import { initSdk, installMock, loadSdk, settle, type InstalledMock } from './helpers';

type Sdk = Awaited<ReturnType<typeof loadSdk>>;
let sdk: Sdk;

const surveyOn = (formId: string, onPageDelay = 0) => ({ formId, onPageDelay });
const SURVEY_EVENTS = ['form:show', 'form:started', 'form:answered', 'form:complete', 'form:dismissed'];

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  sdk = await loadSdk();
});

afterEach(() => {
  sdk.Encatch.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Identifies `name` and waits for the reply. */
async function identified(server: InstalledMock, name = 'alice') {
  sdk.Encatch.identifyUser(name).catch(() => {});
  await settle(1_000);
  expect(sdk.Encatch.userId).toBe(server.userId(name));
}

// ============================================================================
// 1. Bursts from one device
// ============================================================================

describe('identifyUser dedupe', () => {
  it('sends one identify for a burst of identical calls', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    for (let i = 0; i < 20; i++) sdk.Encatch.identifyUser('alice', { $set: { plan: 'pro' } }).catch(() => {});
    await settle(5_000);

    expect(server.count('identify-user')).toBe(1);
    expect(sdk.Encatch.userId).toBe(server.userId('alice'));
  });

  it('skips a later identical call but sends one with changed traits', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    await sdk.Encatch.identifyUser('alice', { $set: { plan: 'pro' } });
    await settle(1_000);
    await sdk.Encatch.identifyUser('alice', { $set: { plan: 'pro' } });
    await settle(1_000);
    expect(server.count('identify-user')).toBe(1);

    await sdk.Encatch.identifyUser('alice', { $set: { plan: 'team' } });
    await settle(1_000);
    expect(server.count('identify-user')).toBe(2);
  });

  it('treats equal Date traits as the same call', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const at = Date.UTC(2026, 0, 1);

    await sdk.Encatch.identifyUser('alice', { $set: { signedUpAt: new Date(at) } });
    await settle(1_000);
    await sdk.Encatch.identifyUser('alice', { $set: { signedUpAt: new Date(at) } });
    await settle(1_000);

    expect(server.count('identify-user')).toBe(1);
  });

  it.each([
    ['locale', { locale: 'fr-FR' }],
    ['country', { country: 'FR' }],
  ])('guard: a changed %s is a different call', async (_name, opts) => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    await sdk.Encatch.identifyUser('alice');
    await settle(1_000);
    await sdk.Encatch.identifyUser('alice', undefined, opts);
    await settle(1_000);

    expect(server.count('identify-user')).toBe(2);
  });

  it('guard: a changed secure signature is a different call', async () => {
    const server = installMock(); // default key has no secret, so any signature passes
    await initSdk(sdk.Encatch);

    await sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig-1' } });
    await settle(1_000);
    await sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig-2' } });
    await settle(1_000);

    expect(server.count('identify-user')).toBe(2);
  });

  it('guard: identifies again after resetUser', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    await sdk.Encatch.identifyUser('alice');
    await settle(1_000);
    await sdk.Encatch.resetUser();
    await sdk.Encatch.identifyUser('alice');
    await settle(1_000);

    expect(server.count('identify-user')).toBe(2);
  });

  it('guard: sends the same identify again after an earlier one failed', async () => {
    const server = installMock({ scenario: { faults: [{ endpoint: 'identify-user', count: 3, status: 503 }] } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(60_000); // 3 attempts, then dropped
    expect(server.count('identify-user')).toBe(3);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);
    expect(server.count('identify-user')).toBe(4);
    expect(sdk.Encatch.userId).toBe(server.userId('alice'));
  });
});

describe('trackEvent / trackScreen collapse (decision 2: 1 s window)', () => {
  it('collapses identical trackEvent calls fired within a few hundred ms', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    for (let i = 0; i < 10; i++) {
      sdk.Encatch.trackEvent('cart_viewed').catch(() => {});
      await settle(10);
    }
    sdk.Encatch.trackEvent('checkout_started').catch(() => {});
    await settle(2_000);

    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['cart_viewed', 'checkout_started']);

    sdk.Encatch.trackEvent('cart_viewed').catch(() => {});
    await settle(2_000);
    expect(server.count('track-event')).toBe(3);
  });

  it('collapses identical trackScreen calls fired within a few hundred ms', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    for (let i = 0; i < 18; i++) sdk.Encatch.trackScreen('/home').catch(() => {});
    await settle(2_000);

    expect(server.count('track-screen')).toBe(1);
  });

  it('window edge: 900 ms apart is collapsed', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('tap').catch(() => {});
    await settle(900);
    sdk.Encatch.trackEvent('tap').catch(() => {});
    await settle(2_000);

    expect(server.count('track-event')).toBe(1);
  });

  it('guard: window edge: 1,100 ms apart is sent twice', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('tap').catch(() => {});
    await settle(1_100);
    sdk.Encatch.trackEvent('tap').catch(() => {});
    await settle(2_000);

    expect(server.count('track-event')).toBe(2);
  });

  it('guard: a quick visit away and back (/home → /cart → /home) within 1 s is tracked in full', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/home').catch(() => {});
    await settle(200);
    sdk.Encatch.trackScreen('/cart').catch(() => {});
    await settle(200);
    sdk.Encatch.trackScreen('/home').catch(() => {});
    await settle(2_000);

    expect(server.of('track-screen').map((r) => r.body.$deviceInfo.$urlOrScreenName)).toEqual(['/home', '/cart', '/home']);
  });

  it('guard: a collapsed trackScreen still updates the current screen (sent with the next ping)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/settings').catch(() => {});
    sdk.Encatch.trackScreen('/settings').catch(() => {});
    await settle(1_000);
    sdk.Encatch.startSession().catch(() => {}); // immediate ping
    await settle(1_000);

    expect(server.of('ping')[0].body.$deviceInfo.$urlOrScreenName).toBe('/settings');
  });
});

describe('request timeout', () => {
  it('a request that never answers is aborted after 30 s, so the queue moves on', async () => {
    const server = installMock({
      scenario: { faults: [{ endpoint: 'track-event', count: 1, match: { eventName: 'hangs' }, delayMs: 10 * 60_000 }] },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('hangs').catch(() => {});
    await settle(100);
    sdk.Encatch.trackEvent('next').catch(() => {});
    await settle(20_000);
    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['hangs']); // still waiting

    await settle(15_000); // past the 30 s timeout
    const sent = server.of('track-event').map((r) => r.body.eventName);
    expect(sent).toContain('next');
    // The aborted request is retried like a network failure.
    expect(sent.filter((n) => n === 'hangs').length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// 429 handling (decisions: no retry for identify / events / screens / show-form;
// pause new background calls; submit-form retried)
// ============================================================================

describe('429 handling', () => {
  const limitedOnce = (endpoint: string, seconds = 5) => ({
    scenario: {
      faults: [{ endpoint, count: 1, status: 429, retryAfterSeconds: seconds, body: { error: 'rate limit exceeded' } }],
    },
  });

  it('does not retry a track-event 429, and drops tracking calls made during the pause', async () => {
    const server = installMock(limitedOnce('track-event'));
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('first').catch(() => {});
    await settle(200);
    expect(server.count('track-event')).toBe(1);

    sdk.Encatch.trackEvent('second').catch(() => {});
    sdk.Encatch.trackScreen('/settings').catch(() => {});
    sdk.Encatch.startSession().catch(() => {}); // would normally ping immediately
    await settle(10_000);
    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['first']);
    expect(server.count('track-screen')).toBe(0);
    expect(server.count('ping')).toBe(0);

    sdk.Encatch.trackEvent('third').catch(() => {});
    await settle(1_000);
    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['first', 'third']);
  });

  it('does not send survey events during the pause', async () => {
    const server = installMock(limitedOnce('track-event'));
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.trackEvent('first').catch(() => {});
    await settle(200);
    for (const e of SURVEY_EVENTS) sdk.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['first']);
  });

  it('honours Retry-After given as an HTTP date', async () => {
    const until = new Date(Date.now() + 5_000).toUTCString();
    const server = installMock({
      scenario: { faults: [{ endpoint: 'track-event', count: 1, status: 429, retryAfter: until }] },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('first').catch(() => {});
    await settle(200);
    sdk.Encatch.trackEvent('during').catch(() => {});
    await settle(3_000);
    expect(server.count('track-event')).toBe(1);

    await settle(3_000);
    sdk.Encatch.trackEvent('after').catch(() => {});
    await settle(1_000);
    expect(server.of('track-event').map((r) => r.body.eventName)).toEqual(['first', 'after']);
  });

  it('guard: does not retry an identify 429, and sends the same identify again after the pause', async () => {
    const server = installMock(limitedOnce('identify-user'));
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(10_000);
    expect(server.count('identify-user')).toBe(1);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);
    expect(server.count('identify-user')).toBe(2);
    expect(sdk.Encatch.userId).toBe(server.userId('alice'));
  });

  it('holds only the latest identify made during a pause and sends it once the pause ends', async () => {
    const server = installMock(limitedOnce('track-event'));
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('first').catch(() => {}); // 429 → tracking paused for 5 s
    await settle(200);
    sdk.Encatch.identifyUser('alice').catch(() => {});
    sdk.Encatch.identifyUser('bob').catch(() => {});
    sdk.Encatch.identifyUser('carol').catch(() => {});
    await settle(3_000);
    expect(server.count('identify-user')).toBe(0); // held, not sent, during the pause

    await settle(5_000);
    expect(server.of('identify-user').map((r) => r.body.userName)).toEqual(['carol']);
    expect(sdk.Encatch.userId).toBe(server.userId('carol'));
  });

  it('does not retry a show-form 429, and skips automatic shows during the pause', async () => {
    const server = installMock({
      scenario: {
        triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID), '/b': surveyOn(SECOND_FORM_ID) } },
        faults: [{ endpoint: 'show-form', count: 1, status: 429, retryAfterSeconds: 5 }],
      },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/a').catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackScreen('/b').catch(() => {});
    await settle(10_000);

    expect(server.count('show-form')).toBe(1);
    // show-form's pause doesn't stop tracking.
    expect(server.count('track-screen')).toBe(2);
  });

  it('guard: does not block submit-form while tracking is rate limited', async () => {
    const server = installMock(limitedOnce('track-event', 30));
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('first').catch(() => {});
    await settle(200);
    sdk.Encatch.submitForm({ triggerType: 'manual', formDetails: { formConfigurationId: DEFAULT_FORM_ID } } as any).catch(() => {});
    await settle(200);

    expect(server.count('submit-form')).toBe(1);
  });

  it('retries submit-form after a 429 instead of losing the answers', async () => {
    const server = installMock(limitedOnce('submit-form', 2));
    await initSdk(sdk.Encatch);

    sdk.Encatch.submitForm({ triggerType: 'manual', formDetails: { formConfigurationId: DEFAULT_FORM_ID } } as any).catch(() => {});
    await settle(10_000);

    expect(server.of('submit-form').map((r) => r.status)).toEqual([429, 200]);
  });
});

describe('ping timing (the server\'s pingAgainIn)', () => {
  /** Ping times in whole seconds since `t0`. */
  const pingTimes = (server: InstalledMock, t0: number) => server.of('ping').map((r) => Math.round((r.at - t0) / 1000));
  const pingReply = (pingAgainIn: number, count = 1000) => ({
    endpoint: 'ping' as const,
    count,
    status: 200,
    body: { message: 'ok', pingAgainIn, pingOnNextPageVisit: true },
  });

  it('honours pingAgainIn on every reply (not only every other one)', async () => {
    const server = installMock({ scenario: { faults: [pingReply(120)] } });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(605_000);

    expect(pingTimes(server, t0)).toEqual([0, 120, 240, 360, 480, 600]);
  });

  it('with the server\'s usual 30 s, pings every 30 s as before', async () => {
    const server = installMock(); // the mock answers pingAgainIn: 30, like the server
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(185_000);

    expect(pingTimes(server, t0)).toEqual([0, 30, 60, 90, 120, 150, 180]);
  });

  it('keeps a long backoff (900 s, as on the user-pending path) and then follows the next value', async () => {
    const server = installMock({ scenario: { faults: [pingReply(900, 1), pingReply(10, 1)] } });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(965_000);

    // 0 → asks for 900 s; 900 → asks for 10 s; 910 → back to the usual 30 s.
    expect(pingTimes(server, t0)).toEqual([0, 900, 910, 940]);
  });

  it('new user not created yet (user pending): pings every 10 s as asked, then 30 s once created', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    await initSdk(sdk.Encatch);
    server.mock.update({ userPending: { enabled: true, exhaustAfter: 100 } }); // replies: pingAgainIn 10
    const t0 = Date.now();
    // Identify (a new user: pingAgainIn 10), then the user's pings get the pending reply (10).
    sdk.Encatch.identifyUser('new-user').catch(() => {});
    await settle(95_000);
    server.mock.update({ userPending: { enabled: false } }); // the contact now exists: pingAgainIn 30
    await settle(100_000);

    const pings = server.of('ping').map((r) => ({ t: Math.round((r.at - t0) / 1000), status: r.status }));
    const pending = pings.filter((p) => p.t <= 95).map((p) => p.t);
    expect(pending[0]).toBe(10); // the new user's identify reply asks for 10 s
    expect(pending.length).toBeGreaterThanOrEqual(9); // then every 10 s while pending
    pending.slice(1).forEach((t, i) => expect(t - pending[i], `gap before ${t}`).toBe(10));
    const after = pings.filter((p) => p.t > 95).map((p) => p.t);
    expect(after.length).toBeGreaterThanOrEqual(3);
    after.slice(1).forEach((t, i) => expect(t - after[i], `gap before ${t}`).toBe(30));
  });

  it('a pingAgainIn on another reply (track-screen) moves a scheduled ping', async () => {
    const server = installMock({
      scenario: {
        faults: [
          pingReply(120, 1),
          { endpoint: 'track-screen', count: 1, status: 200, body: { message: 'ok', pingAgainIn: 300, pingOnNextPageVisit: true } },
        ],
      },
    });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(60_000);
    sdk.Encatch.trackScreen('/later').catch(() => {});
    await settle(345_000);

    // The ping planned for 120 s moves to 60 + 300 = 360 s; then the usual 30 s.
    expect(pingTimes(server, t0)).toEqual([0, 360, 390]);
  });

  it('still sends no ping while a survey is open, and resumes after it closes', async () => {
    const server = installMock({ scenario: { faults: [pingReply(120)] } });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(10_000);
    sdk.Encatch.setFormVisible(true);
    await settle(200_000); // the scheduled ping at 120 s is skipped while the survey is open
    sdk.Encatch.setFormVisible(false);
    await settle(45_000);

    const times = pingTimes(server, t0);
    expect(times.filter((t) => t > 10 && t < 210)).toEqual([]);
    expect(times.filter((t) => t >= 210).length).toBe(1);
  });

  it('stopSession during a scheduled wait: no more pings', async () => {
    const server = installMock({ scenario: { faults: [pingReply(120)] } });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(60_000);
    await sdk.Encatch.stopSession();
    await settle(600_000);

    expect(pingTimes(server, t0)).toEqual([0]);
  });

  it('stopSession while a scheduled ping is in flight: the reply does not restart pings', async () => {
    const server = installMock({
      scenario: { faults: [pingReply(120, 1), { endpoint: 'ping', count: 1, status: 200, delayMs: 5_000, body: { message: 'ok', pingAgainIn: 120 } }] },
    });
    await initSdk(sdk.Encatch);
    const t0 = Date.now();
    sdk.Encatch.startSession().catch(() => {});
    await settle(121_000); // the 120 s ping is now waiting for its (slow) reply
    await sdk.Encatch.stopSession();
    await settle(600_000);

    expect(pingTimes(server, t0)).toEqual([0, 120]);
  });
});

describe('stopSession (stops what the SDK does on its own)', () => {
  it('is saved, so a restart stays stopped (init loads it)', async () => {
    installMock();
    await initSdk(sdk.Encatch);
    await sdk.Encatch.stopSession();

    expect(await sdk.storage.getItem('@encatch/session_stopped')).toBe('true');
  });

  it('while stopped, a survey the server picks in a reply still shows', async () => {
    const server = installMock({ scenario: { triggers: { events: { checkout: surveyOn(DEFAULT_FORM_ID) } } } });
    await initSdk(sdk.Encatch);
    await identified(server);
    await sdk.Encatch.stopSession();

    sdk.Encatch.trackEvent('checkout').catch(() => {});
    await settle(2_000);

    expect(server.of('track-event').filter((r) => r.body.eventName === 'checkout')).toHaveLength(1);
    expect(server.of('show-form').map((r) => r.status)).toEqual([200]);
  });

  it('while stopped, a pingAgainIn in a reply does not restart pings', async () => {
    const server = installMock({
      scenario: { faults: [{ endpoint: 'track-event', count: 1, status: 200, body: { message: 'ok', pingAgainIn: 10 } }] },
    });
    await initSdk(sdk.Encatch);
    await identified(server);
    await sdk.Encatch.stopSession();
    const before = server.count('ping');

    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(120_000);

    expect(server.count('ping')).toBe(before);
  });

  it('a successful identifyUser turns it back on and clears the saved stop', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await sdk.Encatch.stopSession();

    await identified(server, 'bob');
    await settle(65_000);

    expect(server.count('ping')).toBeGreaterThanOrEqual(1);
    expect(await sdk.storage.getItem('@encatch/session_stopped')).toBeNull();
  });

  it('resetUser clears the saved stop', async () => {
    installMock();
    await initSdk(sdk.Encatch);
    await sdk.Encatch.stopSession();

    await sdk.Encatch.resetUser();

    expect(await sdk.storage.getItem('@encatch/session_stopped')).toBeNull();
  });
});

describe('userPendingRetryExhausted', () => {
  it('resets the user when the server sends userPendingRetryExhausted (camelCase, as it does)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);
    server.mock.update({ userPending: { enabled: true } });

    for (let i = 0; i < 5; i++) {
      sdk.Encatch.trackEvent(`event_${i}`).catch(() => {});
      await settle(700);
    }
    await settle(1_000);

    expect(server.of('track-event').at(-1)!.status).toBe(200);
    expect(sdk.Encatch.userName).toBeNull();
  });

  it('guard: also resets on the snake_case spelling', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);
    server.mock.update({
      faults: [{ endpoint: 'track-event', count: 1, status: 200, body: { message: 'ok', user_pending_retry_exhausted: true } }],
    });

    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(1_000);

    expect(sdk.Encatch.userName).toBeNull();
  });
});

// ============================================================================
// 2. Duplicate show-form calls (surveys arrive as nextFeedbackId, S1)
// ============================================================================

describe('automatic show-form', () => {
  it('sends one show-form when many track-screen replies carry the same survey', async () => {
    const screens = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`/checkout/${i}`, surveyOn(DEFAULT_FORM_ID)]));
    const server = installMock({ scenario: { triggers: { screens } } });
    await initSdk(sdk.Encatch);

    for (let i = 0; i < 18; i++) sdk.Encatch.trackScreen(`/checkout/${i}`).catch(() => {});
    await settle(5_000);

    expect(server.count('show-form')).toBe(1);
    expect(server.count('track-screen')).toBe(18);
  });

  it('keeps only one pending delayed show (onPageDelay)', async () => {
    const server = installMock({
      scenario: { triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID, 3), '/b': surveyOn(SECOND_FORM_ID, 3) } } },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/a').catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackScreen('/b').catch(() => {});
    await settle(10_000);

    expect(server.count('show-form')).toBe(1);
  });

  it('ignores automatic shows while a survey is open, and allows them after it closes', async () => {
    const server = installMock({
      scenario: {
        triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID), '/b': surveyOn(SECOND_FORM_ID), '/c': surveyOn(SECOND_FORM_ID) } },
      },
    });
    await initSdk(sdk.Encatch);
    const shown = vi.fn();
    sdk.emitter.on('showForm', shown);

    sdk.Encatch.trackScreen('/a').catch(() => {});
    await settle(2_000);
    expect(shown).toHaveBeenCalledTimes(1);

    sdk.Encatch.trackScreen('/b').catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(1);

    sdk.Encatch.setFormVisible(false); // what EncatchWebView does on close
    sdk.Encatch.trackScreen('/c').catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(2);
  });

  it.each(['dismissForm()', 'a show-form error', 'onBeforeShowForm returning false'])(
    'guard: the guard clears after %s',
    async (how) => {
      const server = installMock({
        scenario: {
          triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID), '/b': surveyOn(SECOND_FORM_ID) } },
          faults: how === 'a show-form error' ? [{ endpoint: 'show-form', count: 1, status: 500 }] : [],
        },
      });
      let vetoNext = true;
      await initSdk(
        sdk.Encatch,
        how.startsWith('onBeforeShowForm') ? { onBeforeShowForm: () => (vetoNext ? ((vetoNext = false), false) : true) } : {}
      );

      sdk.Encatch.trackScreen('/a').catch(() => {});
      await settle(2_000);
      if (how === 'dismissForm()') sdk.Encatch.dismissForm(DEFAULT_FORM_ID).catch(() => {});
      await settle(1_000);
      sdk.Encatch.trackScreen('/b').catch(() => {});
      await settle(2_000);

      expect(server.count('show-form')).toBe(2);
    }
  );

  it('guard: treats a show-form 404 as not eligible: no retry, no throw, next show allowed', async () => {
    const server = installMock({
      scenario: {
        triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID), '/b': surveyOn(SECOND_FORM_ID) } },
        faults: [
          {
            endpoint: 'show-form',
            count: 1,
            status: 404,
            body: { status: 404, error: 'Not Found', message: 'Form not available: User is not eligible for this form' },
          },
        ],
      },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/a').catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(1);

    sdk.Encatch.trackScreen('/b').catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(2);
  });

  it('collapses repeated manual showForm calls for the same form while one is loading', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    for (let i = 0; i < 3; i++) sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.count('show-form')).toBe(1);
  });

  it('ignores a manual showForm for a form that is already open (keeps the answers in progress)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const shown = vi.fn();
    sdk.emitter.on('showForm', shown);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000); // loaded and open
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.count('show-form')).toBe(1);
    expect(shown).toHaveBeenCalledTimes(1);

    sdk.Encatch.setFormVisible(false); // closed: showing it again is allowed
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(2);
  });

  it('guard: a manual showForm for a different form still replaces the open one', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const shown = vi.fn();
    sdk.emitter.on('showForm', shown);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);
    sdk.Encatch.showForm(SECOND_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID, SECOND_FORM_ID]);
    expect(shown).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Inline slots (EncatchInlineForm). Routing uses the real presentation registry:
// an exact slot catches its form, a wildcard slot catches any form, otherwise the
// modal is used. One survey is on screen at a time (modal or inline).
// ============================================================================

describe('inline slots', () => {
  type Shown = { formId: string; presentation: string; inlineSlotId?: string };
  const shownList = () => {
    const shown: Shown[] = [];
    sdk.emitter.on('showForm', (p: any) => shown.push({ formId: p.formId, presentation: p.presentation, inlineSlotId: p.inlineSlotId }));
    return shown;
  };

  it('guard: a manual show for a form pinned to an inline slot goes inline and replaces an open modal survey', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const shown = shownList();

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {}); // no slot for it: modal
    await settle(2_000);
    const slot = sdk.registry.registerInlineSlot(SECOND_FORM_ID);
    sdk.Encatch.showForm(SECOND_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.count('show-form')).toBe(2);
    expect(shown).toEqual([
      { formId: DEFAULT_FORM_ID, presentation: 'modal', inlineSlotId: undefined },
      { formId: SECOND_FORM_ID, presentation: 'inline', inlineSlotId: slot },
    ]);
  });

  it('guard: a wildcard slot receives an automatic survey when nothing is open', async () => {
    const server = installMock({ scenario: { triggers: { screens: { '/feedback': surveyOn(DEFAULT_FORM_ID) } } } });
    await initSdk(sdk.Encatch);
    const shown = shownList();
    const slot = sdk.registry.registerInlineSlot(); // wildcard

    sdk.Encatch.trackScreen('/feedback').catch(() => {});
    await settle(2_000);

    expect(server.count('show-form')).toBe(1);
    expect(shown).toEqual([{ formId: DEFAULT_FORM_ID, presentation: 'inline', inlineSlotId: slot }]);
  });

  it('ignores an automatic survey while an inline survey is on screen', async () => {
    const server = installMock({ scenario: { triggers: { screens: { '/other': surveyOn(SECOND_FORM_ID) } } } });
    await initSdk(sdk.Encatch);
    const shown = shownList();
    sdk.registry.registerInlineSlot(DEFAULT_FORM_ID);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {}); // inline survey on screen
    await settle(2_000);
    sdk.Encatch.trackScreen('/other').catch(() => {}); // server picks another survey
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
    expect(shown.map((x) => x.presentation)).toEqual(['inline']);
  });

  it('shows an automatic survey again once the user leaves the inline screen', async () => {
    const server = installMock({
      scenario: { triggers: { screens: { '/other': surveyOn(SECOND_FORM_ID), '/later': surveyOn(SECOND_FORM_ID) } } },
    });
    await initSdk(sdk.Encatch);
    const shown = shownList();
    const slot = sdk.registry.registerInlineSlot(DEFAULT_FORM_ID);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);
    sdk.Encatch.trackScreen('/other').catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(1);

    // What EncatchInlineForm does when its screen loses focus.
    sdk.registry.unregisterInlineSlot(slot);
    sdk.Encatch.setFormVisible(false);
    sdk.Encatch.trackScreen('/later').catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID, SECOND_FORM_ID]);
    expect(shown.map((x) => x.presentation)).toEqual(['inline', 'modal']);
  });

  it('ignores a manual show for the form already open in an inline slot', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    sdk.registry.registerInlineSlot(DEFAULT_FORM_ID);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.count('show-form')).toBe(1);
  });

  it('guard: a manual show for a different form still goes through while an inline survey is open', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const shown = shownList();
    const slot = sdk.registry.registerInlineSlot(DEFAULT_FORM_ID);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {}); // inline
    await settle(2_000);
    sdk.Encatch.showForm(SECOND_FORM_ID).catch(() => {}); // modal, takes over
    await settle(2_000);

    expect(server.count('show-form')).toBe(2);
    expect(shown).toEqual([
      { formId: DEFAULT_FORM_ID, presentation: 'inline', inlineSlotId: slot },
      { formId: SECOND_FORM_ID, presentation: 'modal', inlineSlotId: undefined },
    ]);
  });
});

// ============================================================================
// Decision 8: the server can pick a survey in identify, ping, track-event and
// track-screen replies (nextFeedbackId). The SDK must show it from all four.
// ============================================================================

describe('survey chosen by the server in a reply (nextFeedbackId)', () => {
  it('shows the survey from an identify-user reply', async () => {
    const server = installMock({ scenario: { triggers: { identify: surveyOn(DEFAULT_FORM_ID) } } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('shows the survey from a track-event reply', async () => {
    const server = installMock({ scenario: { triggers: { events: { purchase_completed: surveyOn(DEFAULT_FORM_ID) } } } });
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.trackEvent('purchase_completed').catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('shows the survey from a ping reply', async () => {
    const server = installMock({ scenario: { triggers: { ping: surveyOn(DEFAULT_FORM_ID) } } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.startSession().catch(() => {});
    await settle(2_000);

    expect(server.count('ping')).toBeGreaterThanOrEqual(1);
    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('guard: shows the survey from a track-screen reply, after onPageDelay', async () => {
    const server = installMock({ scenario: { triggers: { screens: { '/checkout': surveyOn(DEFAULT_FORM_ID, 2) } } } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackScreen('/checkout').catch(() => {});
    await settle(1_000);
    expect(server.count('show-form')).toBe(0);
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('guard: ignores a survey from an identify reply while another survey is open', async () => {
    const server = installMock({ scenario: { triggers: { identify: surveyOn(SECOND_FORM_ID) } } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {}); // the user is looking at a survey
    await settle(1_000);
    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('shows a survey from a ping reply only after onPageDelay', async () => {
    const server = installMock({ scenario: { triggers: { ping: surveyOn(DEFAULT_FORM_ID, 3) } } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.startSession().catch(() => {});
    await settle(2_000);
    expect(server.count('show-form')).toBe(0);
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it('many track-event replies naming the same survey give one show-form', async () => {
    const events = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`event_${i}`, surveyOn(DEFAULT_FORM_ID)]));
    const server = installMock({ scenario: { triggers: { events } } });
    await initSdk(sdk.Encatch);
    await identified(server);

    for (let i = 0; i < 10; i++) sdk.Encatch.trackEvent(`event_${i}`).catch(() => {});
    await settle(5_000);

    expect(server.count('track-event')).toBe(10);
    expect(server.count('show-form')).toBe(1);
  });

  it('guard: an older server that sends formConfigurationId still shows the survey', async () => {
    const server = installMock({
      scenario: {
        faults: [{ endpoint: 'track-event', count: 1, status: 200, body: { message: 'ok', formConfigurationId: DEFAULT_FORM_ID } }],
      },
    });
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.trackEvent('purchase_completed').catch(() => {});
    await settle(2_000);

    expect(server.of('show-form').map((r) => r.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
  });

  it("guard: no loop when the open survey's form:show event reply names the same survey", async () => {
    const server = installMock({
      scenario: {
        triggers: { screens: { '/a': surveyOn(DEFAULT_FORM_ID) }, events: { 'form:show': surveyOn(DEFAULT_FORM_ID) } },
      },
    });
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.trackScreen('/a').catch(() => {});
    await settle(2_000);
    sdk.Encatch._trackFormEvent('form:show', DEFAULT_FORM_ID).catch(() => {});
    await settle(3_000);

    expect(server.count('show-form')).toBe(1);
  });
});

// ============================================================================
// Decision 1 (Option A): no survey events for visitors
// ============================================================================

describe('survey events for visitors', () => {
  it('does not send survey events when no user is identified', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    for (const e of SURVEY_EVENTS) sdk.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.count('track-event')).toBe(0);
  });

  it('a survey shown to a visitor sends no survey events (including dismiss) and gets no 403s', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(1_000);
    for (const e of SURVEY_EVENTS.filter((x) => x !== 'form:dismissed')) {
      sdk.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    }
    sdk.Encatch.dismissForm(DEFAULT_FORM_ID).catch(() => {}); // sends form:dismissed in 1.4.3
    await settle(2_000);

    expect(server.count('show-form')).toBe(1);
    expect(server.count('track-event')).toBe(0);
    expect(server.requests.filter((r) => r.status === 403)).toEqual([]);
  });

  it("does not send survey events during a new user's first identify, and sends them once identified", async () => {
    const server = installMock({ scenario: { faults: [{ endpoint: 'identify-user', count: 1, delayMs: 1_000 }] } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(100);
    sdk.Encatch._trackFormEvent('form:show', DEFAULT_FORM_ID).catch(() => {}); // id not known yet
    await settle(2_000);
    expect(server.count('track-event')).toBe(0);

    sdk.Encatch._trackFormEvent('form:started', DEFAULT_FORM_ID).catch(() => {});
    await settle(1_000);
    const [started] = server.of('track-event');
    expect(started.body.eventName).toBe('form:started');
    expect(started.headers['X-User-Id']).toBe(server.userId('alice'));
    expect(started.status).toBe(200);
  });

  it('guard: a returning user sends survey events from the first request after a cold start', async () => {
    const server = installMock();
    await sdk.storage.setItem('@encatch/user_name', 'alice');
    await sdk.storage.setItem('@encatch/user_id_alice', server.userId('alice'));
    await initSdk(sdk.Encatch);

    sdk.Encatch._trackFormEvent('form:show', DEFAULT_FORM_ID).catch(() => {});
    await settle(1_000);

    expect(server.of('track-event').map((r) => [r.body.eventName, r.status])).toEqual([['form:show', 200]]);
  });

  it("guard: the app's own events from visitors are still sent (Option A only covers survey events)", async () => {
    const server = installMock({ scenario: { allowTrackEventForVisitors: true } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('pricing_viewed').catch(() => {});
    await settle(1_000);

    expect(server.of('track-event').map((r) => [r.body.eventName, r.status])).toEqual([['pricing_viewed', 200]]);
  });

  it('guard: sends survey events for an identified user', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);

    for (const e of SURVEY_EVENTS) sdk.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.of('track-event').map((r) => [r.body.eventName, r.status])).toEqual(SURVEY_EVENTS.map((e) => [e, 200]));
  });
});

// ============================================================================
// 4. Identity (S2: both-or-neither; S11: identify-user's own headers)
// ============================================================================

describe('identity', () => {
  it('keeps the new user when resetUser() and identifyUser() are fired without awaiting', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.resetUser().catch(() => {});
    sdk.Encatch.identifyUser('bob').catch(() => {});
    await settle(2_000);

    expect(sdk.Encatch.userName).toBe('bob');
    expect(sdk.Encatch.userId).toBe(server.userId('bob'));
    expect(await sdk.storage.getItem('@encatch/user_name')).toBe('bob');

    sdk.Encatch.trackEvent('after_login').catch(() => {});
    await settle(1_000);
    const last = server.of('track-event').pop()!;
    expect(last.headers['X-User-Name']).toBe('bob');
    expect(last.headers['X-User-Id']).toBe(server.userId('bob'));
    expect(last.status).toBe(200);
  });

  it("never pairs the new user's name with the previous user's id while identify is in flight", async () => {
    const server = installMock({
      scenario: { faults: [{ endpoint: 'identify-user', count: 1, match: { userName: 'bob' }, delayMs: 1_000 }] },
    });
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.identifyUser('bob').catch(() => {});
    await settle(100);
    sdk.Encatch.trackEvent('during_switch').catch(() => {});
    await settle(3_000);

    for (const r of server.requests.filter((x) => x.headers['X-User-Name'] === 'bob')) {
      expect(r.headers['X-User-Id']).not.toBe(server.userId('alice'));
    }
    expect(server.requests.filter((r) => r.status === 401).map((r) => r.endpoint)).toEqual([]);
  });

  it("never sends only one identity header during a new user's first identify (S2)", async () => {
    const server = installMock({ scenario: { faults: [{ endpoint: 'identify-user', count: 1, delayMs: 1_000 }] } });
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(100);
    sdk.Encatch.trackEvent('during_identify').catch(() => {});
    sdk.Encatch.startSession().catch(() => {}); // provider-style immediate ping
    await settle(3_000);

    const half = server.requests.filter(
      (r) => r.endpoint !== 'identify-user' && !!r.headers['X-User-Name'] !== !!r.headers['X-User-Id']
    );
    expect(half.map((r) => r.endpoint)).toEqual([]);
    expect(server.requests.filter((r) => r.status === 401).map((r) => r.endpoint)).toEqual([]);
  });

  it('identify-user never sends X-User-Id (S11)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server); // alice, now with a stored id

    sdk.Encatch.identifyUser('alice', { $set: { plan: 'pro' } }).catch(() => {}); // same user again
    await settle(1_000);
    sdk.Encatch.identifyUser('bob').catch(() => {}); // switch
    await settle(1_000);

    for (const r of server.of('identify-user')) expect(r.headers['X-User-Id']).toBeUndefined();
  });

  it("identify-user's X-User-Name always equals its body userName, even when queued behind a quick switch (S11)", async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('carol').catch(() => {});
    sdk.Encatch.identifyUser('dave').catch(() => {});
    await settle(3_000);

    for (const r of server.of('identify-user')) expect(r.headers['X-User-Name']).toBe(r.body.userName);
  });

  it('guard: show-form and the submit that follows go out under the same identity', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(1_000);
    sdk.Encatch.submitForm({
      triggerType: 'manual',
      formDetails: { formConfigurationId: DEFAULT_FORM_ID, response: {} },
    } as any).catch(() => {});
    await settle(1_000);

    for (const r of [server.of('show-form')[0], server.of('submit-form')[0]]) {
      expect(r.headers['X-User-Name']).toBe('alice');
      expect(r.headers['X-User-Id']).toBe(server.userId('alice'));
      expect(r.status).toBe(200);
    }
  });

  it('guard: a returning user is sent with both headers from the first request after a cold start', async () => {
    const server = installMock();
    await sdk.storage.setItem('@encatch/user_name', 'alice');
    await sdk.storage.setItem('@encatch/user_id_alice', server.userId('alice'));
    await initSdk(sdk.Encatch);

    sdk.Encatch.trackEvent('opened').catch(() => {});
    await settle(1_000);

    const [first] = server.requests;
    expect(first.headers['X-User-Name']).toBe('alice');
    expect(first.headers['X-User-Id']).toBe(server.userId('alice'));
    expect(first.status).toBe(200);
  });
});

// ============================================================================
// Decision 9: secure identify, checked by the mock's copy of the gateway check
// ============================================================================

describe('secure identify', () => {
  it('is accepted by the gateway for a key with a secret and no session time', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_API_KEY);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: hmacHex('alice', DEFAULT_SECRET) } }).catch(() => {});
    await settle(1_000);

    expect(server.of('identify-user')[0].status).toBe(200);
  });

  it('is accepted by the gateway for a key with a secret and a session time', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_SESSION_API_KEY);
    const ts = String(Date.now());

    sdk.Encatch.identifyUser('alice', undefined, {
      secure: { signature: hmacHex(`alice${ts}`, DEFAULT_SECRET), generatedDateTimeinUTC: ts },
    }).catch(() => {});
    await settle(1_000);

    const [identify] = server.of('identify-user');
    expect(identify.headers['X-User-Session-Time']).toBe(ts);
    expect(identify.status).toBe(200);
  });

  it('guard: is rejected by the gateway when the signature is wrong (the check is real)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_API_KEY);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: hmacHex('mallory', DEFAULT_SECRET) } }).catch(() => {});
    await settle(1_000);

    expect(server.of('identify-user')[0]).toMatchObject({ status: 401, body: { userName: 'alice' } });
  });

  it('guard: keeps sending X-User-Signature-Time and the body signature for compatibility', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const ts = String(Date.now());

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig', generatedDateTimeinUTC: ts } }).catch(() => {});
    await settle(1_000);

    const [identify] = server.of('identify-user');
    expect(identify.headers['X-User-Signature-Time']).toBe(ts);
    expect(identify.body.userSignature).toBe('sig');
  });

  it('guard: sends no signature headers without secure options', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);

    const [identify] = server.of('identify-user');
    expect(identify.headers['X-User-Signature']).toBeUndefined();
    expect(identify.headers['X-User-Session-Time']).toBeUndefined();
  });

  // Step 9b: after a successful secure identify, the signature and its time go on
  // every request for that user (replaces the old "identify-user only" guard).
  const sigHeaders = (r: { headers: Record<string, string> }) => [
    r.headers['X-User-Signature'],
    r.headers['X-User-Session-Time'],
    r.headers['X-User-Signature-Time'],
  ];

  it('after a successful secure identify, the signature and time go on every request', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    const ts = String(Date.now());

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig', generatedDateTimeinUTC: ts } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    sdk.Encatch.trackScreen('/s').catch(() => {});
    sdk.Encatch.startSession().catch(() => {}); // ping
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);
    sdk.Encatch.submitForm({ triggerType: 'manual', formDetails: { formConfigurationId: DEFAULT_FORM_ID, response: {} } } as any).catch(() => {});
    await settle(1_000);

    const after = server.requests.filter((r) => r.endpoint !== 'identify-user');
    expect(after.map((r) => r.endpoint).sort()).toEqual(['ping', 'show-form', 'submit-form', 'track-event', 'track-screen']);
    for (const r of after) expect(sigHeaders(r)).toEqual(['sig', ts, ts]);
  });

  it.each([
    ['without a session time', DEFAULT_SECURE_API_KEY, false],
    ['with a session time', DEFAULT_SECURE_SESSION_API_KEY, true],
  ])('passes a gateway that checks every request (SV8), key %s', async (_name, apiKey, timed) => {
    const server = installMock({ scenario: { enforceSignatureOnAllRequests: true } });
    await initSdk(sdk.Encatch, {}, apiKey);
    const ts = String(Date.now());
    const secure = timed
      ? { signature: hmacHex(`alice${ts}`, DEFAULT_SECRET), generatedDateTimeinUTC: ts }
      : { signature: hmacHex('alice', DEFAULT_SECRET) };

    sdk.Encatch.identifyUser('alice', undefined, { secure }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    sdk.Encatch.trackScreen('/s').catch(() => {});
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    // show-form isn't queued, so it can overtake the queued calls: compare as a set.
    expect(server.requests.map((r) => `${r.endpoint} ${r.status}`).sort()).toEqual(
      ['identify-user 200', 'show-form 200', 'track-event 200', 'track-screen 200']
    );
  });

  it('guard: never sends the signature on visitor requests (before identify and after reset)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    sdk.Encatch.startSession().catch(() => {}); // visitor ping
    await settle(500);
    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig' } }).catch(() => {});
    await settle(1_000);
    await sdk.Encatch.resetUser();
    sdk.Encatch.trackScreen('/after-reset').catch(() => {});
    await settle(1_000);

    const visitorRequests = server.requests.filter((r) => !r.headers['X-User-Id'] && r.endpoint !== 'identify-user');
    expect(visitorRequests.length).toBeGreaterThanOrEqual(2);
    for (const r of visitorRequests) expect(sigHeaders(r)).toEqual([undefined, undefined, undefined]);
    expect(await sdk.storage.getItem('@encatch/user_signature_alice')).toBeNull();
  });

  it('guard: a failed secure identify does not set the signature', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_API_KEY);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: hmacHex('mallory', DEFAULT_SECRET) } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(1_000);

    expect(server.of('identify-user')[0].status).toBe(401);
    for (const r of server.of('track-event')) expect(r.headers['X-User-Signature']).toBeUndefined();
    expect(await sdk.storage.getItem('@encatch/user_signature_alice')).toBeNull();
  });

  it('guard: a superseded identify reply does not set the signature', async () => {
    const server = installMock({
      scenario: { faults: [{ endpoint: 'identify-user', count: 1, match: { userName: 'alice' }, delayMs: 1_000 }] },
    });
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'alice-sig' } }).catch(() => {});
    await settle(100);
    sdk.Encatch.identifyUser('bob').catch(() => {});
    await settle(3_000);
    sdk.Encatch.trackEvent('as_bob').catch(() => {});
    await settle(1_000);

    const event = server.of('track-event')[0];
    expect(event.headers['X-User-Name']).toBe('bob');
    expect(event.headers['X-User-Signature']).toBeUndefined();
    expect(await sdk.storage.getItem('@encatch/user_signature_alice')).toBeNull();
  });

  it('guard: an identify without secure options clears the signature', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'sig' } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.identifyUser('alice', { $set: { plan: 'pro' } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(1_000);

    expect(server.of('track-event')[0].headers['X-User-Signature']).toBeUndefined();
    expect(await sdk.storage.getItem('@encatch/user_signature_alice')).toBeNull();
  });

  it("guard: a user switch never sends the previous user's signature", async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: 'alice-sig' } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.identifyUser('bob').catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('as_bob').catch(() => {});
    await settle(1_000);

    for (const r of server.requests.filter((x) => x.headers['X-User-Name'] === 'bob')) {
      expect(r.headers['X-User-Signature']).toBeUndefined();
    }
  });

  it('is restored after a cold start and keeps passing a gateway that checks every request', async () => {
    const server = installMock({ scenario: { enforceSignatureOnAllRequests: true } });
    await sdk.storage.setItem('@encatch/user_name', 'alice');
    await sdk.storage.setItem('@encatch/user_id_alice', server.userId('alice'));
    await sdk.storage.setItem(
      '@encatch/user_signature_alice',
      JSON.stringify({ signature: hmacHex('alice', DEFAULT_SECRET), time: null })
    );
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_API_KEY);

    sdk.Encatch.trackEvent('opened').catch(() => {});
    await settle(1_000);

    const [first] = server.requests;
    expect(first.headers['X-User-Signature']).toBe(hmacHex('alice', DEFAULT_SECRET));
    expect(first.status).toBe(200);
  });

  it('expiry: a 401 on a timed signature pauses background calls and holds a submit until the next identify', async () => {
    const server = installMock({ scenario: { enforceSignatureOnAllRequests: true } });
    const warn = vi.mocked(console.warn);
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_SESSION_API_KEY); // session time 15 min
    const signedAt = (t: number) => ({ signature: hmacHex(`alice${t}`, DEFAULT_SECRET), generatedDateTimeinUTC: String(t) });

    sdk.Encatch.identifyUser('alice', undefined, { secure: signedAt(Date.now()) }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('fresh').catch(() => {});
    await settle(1_000);
    expect(server.of('track-event').map((r) => r.status)).toEqual([200]);

    // The 30 s ping keeps going: it passes until the session time runs out, then
    // the first ping after expiry gets 401 and the SDK stops sending. (Each ping
    // goes 30 s after the previous reply, so allow 17 minutes for 15 + 1.)
    const beforeExpiry = server.requests.length;
    await settle(17 * 60_000);
    const pings = server.requests.slice(beforeExpiry).filter((r) => r.endpoint === 'ping').map((r) => r.status);
    expect(pings.filter((st) => st === 401)).toHaveLength(1);
    expect(pings.at(-1)).toBe(401); // nothing after the first 401
    expect(pings.slice(0, -1).every((st) => st === 200)).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('signature expired'))).toHaveLength(1);

    // While expired: nothing in the background is sent, and a submit is held.
    const mark = server.requests.length;
    sdk.Encatch.trackEvent('skipped').catch(() => {});
    sdk.Encatch.trackScreen('/skipped').catch(() => {});
    sdk.Encatch.startSession().catch(() => {});
    sdk.Encatch.submitForm({ triggerType: 'manual', formDetails: { formConfigurationId: DEFAULT_FORM_ID, response: {} } } as any).catch(() => {});
    await settle(65_000); // includes two ping intervals
    expect(server.requests.length).toBe(mark);

    // The app identifies again with a fresh signature: the held submit goes out and tracking resumes.
    sdk.Encatch.identifyUser('alice', undefined, { secure: signedAt(Date.now()) }).catch(() => {});
    await settle(2_000);
    sdk.Encatch.trackEvent('resumed').catch(() => {});
    await settle(1_000);
    expect(server.requests.slice(mark).map((r) => [r.endpoint, r.status])).toEqual([
      ['identify-user', 200],
      ['submit-form', 200],
      ['track-event', 200],
    ]);
  });

  it('a key without a session time never enters the expired state', async () => {
    const server = installMock({
      scenario: { faults: [{ endpoint: 'track-event', count: 1, status: 401, body: { error: 'invalid api key' } }] },
    });
    await initSdk(sdk.Encatch, {}, DEFAULT_SECURE_API_KEY);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature: hmacHex('alice', DEFAULT_SECRET) } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('first').catch(() => {}); // 401 (injected), no timed signature
    await settle(1_500);
    sdk.Encatch.trackEvent('second').catch(() => {});
    await settle(1_000);

    expect(server.of('track-event').map((r) => [r.body.eventName, r.status])).toEqual([
      ['first', 401],
      ['second', 200],
    ]);
  });
});

// ============================================================================
// Behaviour guards: must keep working exactly as in 1.4.3
// ============================================================================

describe('SDK version (decision 5)', () => {
  it('reports the package.json version as $sdkVersion on every request', async () => {
    const { version } = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    for (const r of server.requests) expect(r.body.$deviceInfo.$sdkVersion).toBe(version);
    expect(version).not.toBe('2.0.0');
  });
});

describe('debug hooks (onRequest / onResponse, step 11)', () => {
  const ALLOWED_REQUEST_KEYS = ['attempt', 'endpoint'];
  const ALLOWED_RESPONSE_KEYS = ['attempt', 'durationMs', 'endpoint', 'outcome', 'rateLimited', 'reason', 'status'];

  async function withHooks(config: Record<string, unknown> = {}, apiKey?: string) {
    const requests: any[] = [];
    const responses: any[] = [];
    await initSdk(
      sdk.Encatch,
      { onRequest: (i: any) => requests.push(i), onResponse: (i: any) => responses.push(i), ...config },
      apiKey
    );
    return { requests, responses };
  }

  it('fires once per real request, with endpoint, attempt, status, duration and outcome', async () => {
    const server = installMock();
    const h = await withHooks();

    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    await settle(2_000);

    const sent = server.requests.map((r) => r.endpoint);
    expect(h.requests.map((i) => i.endpoint)).toEqual(sent);
    expect(h.responses.map((i) => i.endpoint)).toEqual(sent);
    for (const i of h.requests) expect(i.attempt).toBe(1);
    for (const i of h.responses) {
      expect(i).toMatchObject({ status: 200, outcome: 'ok', rateLimited: false });
      expect(i.durationMs).toBeGreaterThanOrEqual(50); // mock latency
    }
  });

  it('reports retry attempts and errors', async () => {
    installMock({
      scenario: { allowTrackEventForVisitors: true, faults: [{ endpoint: 'track-event', count: 2, status: 503 }] },
    });
    const h = await withHooks();

    sdk.Encatch.trackEvent('flaky').catch(() => {});
    await settle(20_000);

    expect(h.requests.filter((i) => i.endpoint === 'track-event').map((i) => i.attempt)).toEqual([1, 2, 3]);
    expect(h.responses.filter((i) => i.endpoint === 'track-event').map((i) => [i.attempt, i.status, i.outcome])).toEqual([
      [1, 503, 'error'],
      [2, 503, 'error'],
      [3, 200, 'ok'],
    ]);
  });

  it('reports a network failure as status 0, outcome network-error', async () => {
    installMock({ scenario: { faults: [{ endpoint: 'ping', count: 1, drop: true }] } });
    const h = await withHooks();

    sdk.Encatch.startSession().catch(() => {});
    await settle(1_000);

    expect(h.responses.find((i) => i.endpoint === 'ping')).toMatchObject({ status: 0, outcome: 'network-error' });
  });

  it('reports a 429 as rateLimited, and calls skipped during the pause as skipped', async () => {
    installMock({ scenario: { faults: [{ endpoint: 'track-event', count: 1, status: 429, retryAfterSeconds: 5 }] } });
    const h = await withHooks();

    sdk.Encatch.trackEvent('first').catch(() => {});
    await settle(500);
    sdk.Encatch.trackEvent('second').catch(() => {});
    sdk.Encatch.trackScreen('/s').catch(() => {});
    await settle(500);

    expect(h.responses).toEqual([
      expect.objectContaining({ endpoint: 'track-event', status: 429, outcome: 'error', rateLimited: true }),
      expect.objectContaining({ endpoint: 'track-event', outcome: 'skipped', reason: 'rate-limited', status: 0 }),
      expect.objectContaining({ endpoint: 'track-screen', outcome: 'skipped', reason: 'rate-limited', status: 0 }),
    ]);
    expect(h.requests).toHaveLength(1); // skipped calls never reach onRequest
  });

  it('reports collapsed, duplicate, visitor and survey-open skips with their reason', async () => {
    installMock({ scenario: { triggers: { screens: { '/promo': surveyOn(SECOND_FORM_ID) } } } });
    const h = await withHooks();

    sdk.Encatch._trackFormEvent('form:show', DEFAULT_FORM_ID).catch(() => {}); // visitor
    sdk.Encatch.trackEvent('tap').catch(() => {});
    sdk.Encatch.trackEvent('tap').catch(() => {}); // collapsed
    await settle(1_000);
    sdk.Encatch.identifyUser('alice').catch(() => {});
    await settle(1_000);
    sdk.Encatch.identifyUser('alice').catch(() => {}); // duplicate
    sdk.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {}); // a survey is open from here
    await settle(1_000);
    sdk.Encatch.trackScreen('/promo').catch(() => {}); // its survey is ignored: survey-open
    await settle(1_000);

    const skipped = h.responses.filter((i) => i.outcome === 'skipped').map((i) => [i.endpoint, i.reason]);
    expect(skipped).toEqual([
      ['track-event', 'visitor'],
      ['track-event', 'collapsed'],
      ['identify-user', 'duplicate'],
      ['show-form', 'survey-open'],
    ]);
  });

  it('never exposes the API key, headers, signature or bodies', async () => {
    installMock();
    const h = await withHooks({}, DEFAULT_SECURE_API_KEY);
    const signature = hmacHex('alice', DEFAULT_SECRET);

    sdk.Encatch.identifyUser('alice', { $set: { email: 'alice@example.com' } }, { secure: { signature } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(1_000);

    expect(h.requests.length).toBeGreaterThan(0);
    for (const i of h.requests) expect(Object.keys(i).sort()).toEqual(ALLOWED_REQUEST_KEYS);
    for (const i of h.responses) for (const k of Object.keys(i)) expect(ALLOWED_RESPONSE_KEYS).toContain(k);
    const all = JSON.stringify([h.requests, h.responses]);
    for (const secret of [DEFAULT_SECURE_API_KEY, signature, 'alice@example.com', 'X-Api-Key', 'X-User']) {
      expect(all).not.toContain(secret);
    }
  });

  it.each([
    ['throws', () => { throw new Error('hook failed'); }],
    ['returns a rejected promise', () => Promise.reject(new Error('hook failed'))],
  ])('a hook that %s does not affect the SDK', async (_name, bad) => {
    const server = installMock();
    await initSdk(sdk.Encatch, { onRequest: bad, onResponse: bad });

    const identify = sdk.Encatch.identifyUser('alice');
    await settle(1_000);
    const calls = [identify, sdk.Encatch.trackEvent('e'), sdk.Encatch.showForm(DEFAULT_FORM_ID)];
    const outcome = Promise.allSettled(calls);
    await settle(3_000);

    expect((await outcome).map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(server.requests.map((r) => [r.endpoint, r.status])).toEqual(
      expect.arrayContaining([['identify-user', 200], ['track-event', 200], ['show-form', 200]])
    );
  });

  it('guard: without hooks nothing changes (no hook fields needed)', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);
    await identified(server);

    sdk.Encatch.trackEvent('e').catch(() => {});
    await settle(1_000);

    expect(server.of('track-event').map((r) => r.status)).toEqual([200]);
  });
});

describe('debug log', () => {
  it('masks the API key and the secure-identify signature (headers and body)', async () => {
    installMock();
    const lines: string[] = [];
    for (const m of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    await initSdk(sdk.Encatch, { debugMode: true }, DEFAULT_SECURE_API_KEY);
    const signature = hmacHex('alice', DEFAULT_SECRET);

    sdk.Encatch.identifyUser('alice', undefined, { secure: { signature } }).catch(() => {});
    await settle(1_000);
    sdk.Encatch.trackEvent('after').catch(() => {}); // carries the stored signature (step 9b)
    await settle(1_000);

    const log = lines.join('\n');
    expect(log).toContain('Request body'); // debug logging really ran
    expect(log).not.toContain(signature);
    expect(log).not.toContain(DEFAULT_SECURE_API_KEY);
    expect(log).toContain('***');
  });
});

describe('guards', () => {
  it('calls before init do nothing', async () => {
    const server = installMock();

    await sdk.Encatch.identifyUser('alice');
    await sdk.Encatch.trackEvent('e');
    await sdk.Encatch.trackScreen('/s');
    await sdk.Encatch.showForm(DEFAULT_FORM_ID);
    await settle(2_000);

    expect(server.requests).toEqual([]);
  });

  it('fullscreen mode skips tracking', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch, { isFullScreen: true });

    sdk.Encatch.trackEvent('e').catch(() => {});
    sdk.Encatch.trackScreen('/s').catch(() => {});
    await settle(2_000);

    expect(server.count('track-event')).toBe(0);
    expect(server.count('track-screen')).toBe(0);
  });

  it.each([
    ['server errors', { status: 500 }],
    ['dropped connections', { drop: true }],
  ])('no public method rejects to the host app on %s', async (_name, fault) => {
    const endpoints = ['identify-user', 'track-event', 'track-screen', 'show-form', 'dismiss-form', 'submit-form', 'ping'];
    installMock({ scenario: { faults: endpoints.map((endpoint) => ({ endpoint, count: 100, ...fault })) } });
    await initSdk(sdk.Encatch);

    const calls = [
      sdk.Encatch.identifyUser('alice'),
      sdk.Encatch.trackEvent('e'),
      sdk.Encatch.trackScreen('/s'),
      sdk.Encatch.showForm(DEFAULT_FORM_ID),
      sdk.Encatch.dismissForm(DEFAULT_FORM_ID),
      sdk.Encatch.submitForm({ triggerType: 'manual', formDetails: { formConfigurationId: DEFAULT_FORM_ID } } as any),
      sdk.Encatch.startSession(),
    ];
    const outcome = Promise.allSettled(calls);
    await settle(120_000);

    expect((await outcome).map((r) => r.status)).toEqual(Array(calls.length).fill('fulfilled'));
  });

  it('ping is suppressed while a form is visible', async () => {
    const server = installMock();
    await initSdk(sdk.Encatch);

    sdk.Encatch.startSession().catch(() => {}); // immediate ping
    await settle(1_000);
    expect(server.count('ping')).toBe(1);

    sdk.Encatch.setFormVisible(true);
    await settle(65_000);
    expect(server.count('ping')).toBe(1);

    sdk.Encatch.setFormVisible(false);
    await settle(31_000);
    expect(server.count('ping')).toBeGreaterThanOrEqual(2);
  });
});
