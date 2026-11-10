/**
 * Step 0b: how the PUBLISHED 1.4.3 SDK behaves when the server rate-limits it.
 * Runs entirely against the in-process mock API (no network).
 *
 * These tests describe 1.4.3 as it is, including its bugs, so the server team can
 * size gateway limits for customers who haven't upgraded. They must keep passing
 * after the 1.4.4 fixes, because they test the published package, not src/.
 *
 * Set CHAR_RESULTS=/path/to/file.json to write every scenario's metrics.
 */
import { writeFileSync } from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FORM_ID } from '../../examples/mock-api/src';
import { advance, load143, measure, results, type Identity, type Loaded } from './harness';

const PRESETS = ['per-endpoint-5', 'planned-prod'] as const;
const IDENTITIES: Identity[] = ['visitor', 'new-user', 'returning-user'];
const fault429 = (endpoint: string, retryAfterSeconds = 60) => ({
  faults: [{ endpoint, count: 1, status: 429, retryAfterSeconds, body: { error: 'rate limit exceeded' } }],
});
const submitParams = { triggerType: 'automatic', formDetails: { formConfigurationId: DEFAULT_FORM_ID, response: {} } };

let loaded: Loaded[] = [];
const track = (l: Loaded) => (loaded.push(l), l);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const l of loaded) l.Encatch.stop();
  loaded = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (process.env.CHAR_RESULTS) writeFileSync(process.env.CHAR_RESULTS, JSON.stringify(results, null, 2));
});

const total = (m: ReturnType<typeof measure>, field: 'resentAfter429' | 'duplicates') =>
  Object.values(m.byEndpoint).reduce((a, e) => a + e[field], 0);
const status = (m: ReturnType<typeof measure>, ep: string, s: number) => m.byEndpoint[ep]?.byStatus[s] ?? 0;

describe.each(PRESETS)('preset %s', (preset) => {
  describe.each(IDENTITIES)('%s', (identity) => {
    it('R1: mixed burst (~30 calls in 1 s) — no 429 is ever retried', async () => {
      const l = track(await load143({ preset, identity }));
      for (let i = 0; i < 10; i++) {
        l.host.mix();
        await advance(100);
      }
      await advance(5_000);
      const m = measure(l);
      results[`R1 ${preset} ${identity}`] = m;
      expect(total(m, 'resentAfter429')).toBe(0);
    });

    it('R2: sustained storm (mix every 200 ms for 3 min) — traffic reaching the server', async () => {
      const l = track(await load143({ preset, identity }));
      for (let i = 0; i < 900; i++) {
        l.host.mix();
        await advance(200);
      }
      await advance(5_000);
      const m = measure(l);
      results[`R2 ${preset} ${identity}`] = m;
      expect(total(m, 'resentAfter429')).toBe(0);
      // Most calls are never sent: they wait in the queue behind 429s.
      expect(m.queueBacklog).toBeGreaterThan(100);
      // Every limited endpoint gets far more requests per minute than its limit:
      // the SDK keeps sending, and the gateway keeps rejecting.
      expect(m.byEndpoint['track-event'].maxPerMinute).toBeGreaterThan(5 * 10);
    }, 30_000); // 2,700 calls through the fake clock: allow for a busy machine
  });
});

describe('R3: the FIRST identify of a new user gets 429', () => {
  it('leaves the SDK half-identified: every later request is 401, even after a restart, until identify succeeds', async () => {
    const l = track(await load143({ preset: 'off', identity: 'new-user', scenario: fault429('identify-user') }));
    l.host.identify();
    await advance(1_000);
    l.host.event();
    l.host.screen();
    await advance(35_000); // includes a 30 s ping
    const m = measure(l);
    results['R3 new user, identify 429'] = m;
    expect(status(m, 'identify-user', 429)).toBe(1);
    expect(m.byEndpoint['identify-user'].sent).toBe(1); // not retried
    expect(m.final).toEqual({ userName: 'alice', userId: null });
    expect(m.halfIdentity).toBeGreaterThan(0);
    expect(status(m, 'track-event', 401)).toBeGreaterThanOrEqual(1); // plus an in-flight duplicate
    // The 401 stops the queue flush (\`return\` on any 4xx), so the screen call
    // queued behind it is never sent and waits in the queue.
    expect(m.byEndpoint['track-screen']).toBeUndefined();
    expect(m.queueBacklog).toBeGreaterThanOrEqual(1);

    // App restart: the name was saved, the id wasn't.
    const mark = l.mock.requests().at(-1)!.seq;
    const l2 = track(await load143({ preset: 'off', identity: 'new-user', storage: l.dumpStorage(), mock: l.mock }));
    l2.host.event();
    await advance(1_000);
    const afterRestart = measure(l2, mark);
    results['R3 after restart'] = afterRestart;
    expect(afterRestart.final).toEqual({ userName: 'alice', userId: null });
    expect(status(afterRestart, 'track-event', 401)).toBeGreaterThanOrEqual(1);

    // Only another identify call from the host fixes it.
    l2.host.identify();
    await advance(1_000);
    const mark2 = l.mock.requests().at(-1)!.seq;
    l2.host.event();
    await advance(1_000);
    const fixed = measure(l2, mark2);
    expect(status(fixed, 'track-event', 200)).toBe(1);
    expect(fixed.final.userId).toBeTruthy();
  });
});

describe('R4: identify gets 429 for a returning user', () => {
  it('same user: nothing breaks, the stored id keeps working', async () => {
    const l = track(await load143({ preset: 'off', identity: 'returning-user', scenario: fault429('identify-user') }));
    l.host.identify();
    await advance(1_000);
    l.host.event();
    await advance(35_000);
    const m = measure(l);
    results['R4 returning user, identify 429'] = m;
    expect(status(m, 'identify-user', 429)).toBe(1);
    expect(m.status401).toBe(0);
    expect(status(m, 'track-event', 200)).toBe(1);
  });

  it("user switch (alice → bob) gets 429: bob's name is sent with alice's id, so everything is 401", async () => {
    const l = track(await load143({ preset: 'off', identity: 'returning-user', scenario: fault429('identify-user') }));
    l.host.identify('bob');
    await advance(1_000);
    l.host.event();
    await advance(35_000);
    const m = measure(l);
    results['R4 user switch, identify 429'] = m;
    expect(m.final.userName).toBe('bob');
    expect(m.final.userId).toBeTruthy(); // still alice's id
    expect(status(m, 'track-event', 401)).toBe(1);
  });
});

describe('R5: survey triggers and 429', () => {
  const trigger = { triggers: { screens: { '/checkout': { formId: DEFAULT_FORM_ID, onPageDelay: 0 } } } };

  it.each(['visitor', 'returning-user'] as Identity[])(
    '%s: a 429 on the track-screen that carries the survey loses it until the host tracks that screen again',
    async (identity) => {
      const l = track(
        await load143({ preset: 'off', identity, scenario: { ...trigger, ...fault429('track-screen') } })
      );
      l.Encatch.trackScreen('/checkout');
      await advance(65_000);
      const lost = measure(l);
      results[`R5 ${identity} survey trigger 429`] = lost;
      expect(status(lost, 'track-screen', 429)).toBe(1);
      expect(lost.byEndpoint['show-form']).toBeUndefined();

      l.Encatch.trackScreen('/checkout');
      await advance(2_000);
      expect(measure(l).byEndpoint['show-form']?.sent).toBe(1);
    }
  );

  it.each(PRESETS)('%s: the production burst — 18 track-screens on a screen with a survey', async (preset) => {
    const l = track(await load143({ preset, identity: 'returning-user', scenario: trigger }));
    for (let i = 0; i < 18; i++) l.Encatch.trackScreen('/checkout');
    await advance(10_000);
    const m = measure(l);
    results[`R5 ${preset} 18 x track-screen /checkout`] = m;
    // At most one show-form succeeds; the rest are 404 (already shown) or 429.
    expect(status(m, 'show-form', 200)).toBe(1);
  });
});

describe('R6: submit while the limit is used up', () => {
  it('per-endpoint model: a 429 on submit-form loses the answers (sent once, never retried)', async () => {
    const l = track(await load143({ preset: 'off', identity: 'returning-user', scenario: fault429('submit-form') }));
    l.Encatch.submitForm(submitParams).catch(() => {}); // resolves; no error reaches the host
    await advance(120_000);
    const m = measure(l);
    results['R6 submit 429'] = m;
    expect(m.byEndpoint['submit-form']).toMatchObject({ sent: 1, byStatus: { 429: 1 } });
  });

  it('shared-bucket model (gateway code): a tracking burst uses the budget and the submit is lost', async () => {
    const l = track(await load143({ preset: 'code-defaults-test', identity: 'returning-user' })); // user 10/min
    for (let i = 0; i < 12; i++) l.host.event();
    await advance(2_000);
    l.Encatch.submitForm(submitParams).catch(() => {});
    await advance(120_000);
    const m = measure(l);
    results['R6 shared bucket, submit after burst'] = m;
    expect(m.byEndpoint['submit-form']).toMatchObject({ sent: 1, byStatus: { 429: 1 } });
  });
});

describe('R7: survey events and the track-event limit (planned-prod: track-event 5/min)', () => {
  const surveyEvents = ['form:show', 'form:started', 'form:answered', 'form:complete', 'form:dismissed'];

  it('identified user: one survey (5 survey events) uses the whole budget; host events then get 429', async () => {
    const l = track(await load143({ preset: 'planned-prod', identity: 'returning-user' }));
    for (const e of surveyEvents) l.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    await advance(2_000);
    l.host.event();
    l.host.event();
    await advance(2_000);
    const m = measure(l);
    results['R7 identified, survey events then host events'] = m;
    expect(status(m, 'track-event', 200)).toBe(5);
    expect(status(m, 'track-event', 429)).toBe(2);
  });

  it('visitor: survey events are 403 but still use the budget; host events then get 429', async () => {
    const l = track(
      await load143({ preset: 'planned-prod', identity: 'visitor', scenario: { allowTrackEventForVisitors: true } })
    );
    for (const e of surveyEvents) l.Encatch._trackFormEvent(e, DEFAULT_FORM_ID).catch(() => {});
    await advance(2_000);
    l.host.event();
    await advance(2_000);
    const m = measure(l);
    results['R7 visitor, survey events then host event'] = m;
    expect(status(m, 'track-event', 403)).toBe(5);
    expect(status(m, 'track-event', 429)).toBe(1);
  });
});

describe('R8: after the window resets', () => {
  it('the held backlog drains into the next window, and fresh calls wait behind it', async () => {
    const l = track(await load143({ preset: 'per-endpoint-5', identity: 'returning-user' }));
    for (let i = 0; i < 10; i++) {
      l.host.mix();
      await advance(100);
    }
    await advance(5_000);
    const burst = measure(l);
    const mark = l.mock.requests().at(-1)!.seq;

    await advance(61_000); // window resets
    l.setAppState('background');
    l.setAppState('active'); // the SDK flushes its queue on foreground
    await advance(5_000);
    const afterForeground = measure(l, mark);

    const mark2 = l.mock.requests().at(-1)!.seq;
    l.host.event();
    await advance(2_000);
    const fresh = measure(l, mark2);

    results['R8 burst'] = burst;
    results['R8 after window + foreground'] = afterForeground;
    results['R8 fresh call'] = fresh;
    // Calls held behind the burst's 429s are sent when the app returns to the
    // foreground, and use up the NEW window.
    expect(burst.queueBacklog).toBeGreaterThan(0);
    expect(afterForeground.total).toBeGreaterThan(0);
    expect(total(afterForeground, 'resentAfter429')).toBe(0);
    // The host's next call waits behind the rest of the backlog: the first queued
    // item gets 429 again, the flush stops, and the fresh event is not sent.
    expect(fresh.byEndpoint['track-event']).toBeUndefined();
    expect(fresh.byEndpoint['identify-user']?.byStatus[429]).toBe(1);
  });
});
