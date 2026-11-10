#!/usr/bin/env node
/**
 * End-to-end flows E1–E11 for the 1.4.4 hotfix, against the local mock API only.
 *
 * Maestro drives the example app (release build, Mock environment); this script
 * resets the mock before each flow, sets the flow's scenario, runs the flow, then
 * checks the requests the mock received.
 *
 *   pnpm --filter @encatch/mock-api dev            # in another terminal
 *   node examples/expo/e2e/run.mjs --platform ios --device <simulator udid>
 *   node examples/expo/e2e/run.mjs --platform android --device emulator-5554 --only E1,E5
 *
 * Options: --out <dir> (screenshots and request logs for failures),
 *          --mock <url> (default http://localhost:8787).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'com.encatch.expotester';
const FORM_ID = '0190f1d2-0000-7000-8000-00000000f001';
const TRACKING = new Set(['identify-user', 'track-event', 'track-screen', 'ping']);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const PLATFORM = args.platform;
const DEVICE = args.device;
const MOCK = args.mock ?? 'http://localhost:8787';
const OUT = args.out ?? path.join(HERE, '.results');
const ONLY = args.only ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
if (!['ios', 'android'].includes(PLATFORM) || !DEVICE) {
  console.error('Usage: node run.mjs --platform ios|android --device <id> [--only E1,E2] [--out dir]');
  process.exit(2);
}

// ── Mock helpers ─────────────────────────────────────────────────────────────
async function mock(p, body) {
  const res = await fetch(`${MOCK}/__mock/${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`mock ${p}: ${res.status}`);
  return res.json();
}

/** Requests from this platform's app only (the other platform's app may also be running). */
const fromPlatform = (r) => {
  const os = r.body?.$deviceInfo?.$deviceOs;
  return os === undefined || os === PLATFORM;
};

const by = (log, endpoint) => log.filter((r) => r.endpoint === endpoint);
const eventName = (r) => r.body?.eventName;
const screenOf = (r) => r.body?.screenName ?? r.body?.$deviceInfo?.$urlOrScreenName;
const status = (log, code) => log.filter((r) => r.status === code);
const doneAt = (r) => r.at + r.durationMs;
const hasIdentity = (r) => Boolean(r.headers['x-user-name'] && r.headers['x-user-id']);

/** Collects failure messages for one flow. */
function checker() {
  const failures = [];
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
  };
  return { failures, expect };
}

/** Shared check for the 429 flows: no retries of 429'd calls and nothing sent while paused. */
function checkPause(log, expect) {
  const limited = log.filter((r) => r.status === 429 && TRACKING.has(r.endpoint));
  expect(limited.length > 0, 'expected at least one 429 on a tracking endpoint');
  if (limited.length === 0) return null;
  const first = limited[0];
  const retryAfterMs = Number(first.retryAfter ?? 60) * 1000;
  const pauseStart = doneAt(first);
  const pauseEnd = pauseStart + retryAfterMs;
  const during = log.filter((r) => TRACKING.has(r.endpoint) && r.at > pauseStart + 300 && r.at < pauseEnd - 300);
  expect(
    during.length === 0,
    `${during.length} tracking request(s) sent during the ${retryAfterMs / 1000}s pause: ${during.map((r) => `#${r.seq} ${r.endpoint}`).join(', ')}`
  );
  for (const r of limited) {
    const key = JSON.stringify([r.endpoint, eventName(r) ?? screenOf(r) ?? null]);
    const again = log.filter(
      (x) => x.seq > r.seq && JSON.stringify([x.endpoint, eventName(x) ?? screenOf(x) ?? null]) === key && x.endpoint !== 'ping'
    );
    expect(again.length === 0, `429'd ${r.endpoint} ${eventName(r) ?? screenOf(r) ?? ''} (#${r.seq}) was sent again (#${again.map((x) => x.seq).join(', #')})`);
  }
  return { pauseStart, pauseEnd };
}

// ── Flows ────────────────────────────────────────────────────────────────────
const FLOWS = [
  {
    id: 'E1',
    file: 'e1-login-navigate.yaml',
    check(log, { expect, user }) {
      const ids = by(log, 'identify-user');
      expect(ids.length === 1, `expected 1 identify-user, got ${ids.length}`);
      expect(ids.every((r) => r.status === 200), 'identify-user not 200');
      if (ids[0]) {
        // Compare with the name the app actually sent (Android text entry occasionally
        // doubles a typed character; that's the test harness, not the SDK).
        const sentName = ids[0].body?.userName ?? user;
        const later = log.filter((r) => r.at > doneAt(ids[0]));
        const bad = later.filter((r) => r.headers['x-user-name'] !== sentName || !r.headers['x-user-id']);
        expect(bad.length === 0, `${bad.length} later request(s) without both identity headers: ${bad.map((r) => `#${r.seq} ${r.endpoint}`).join(', ')}`);
        expect(by(later, 'track-screen').length >= 3, 'expected track-screen for the tabs visited');
      }
      expect(status(log, 401).length === 0, `${status(log, 401).length} × 401`);
    },
  },
  {
    id: 'E2',
    file: 'e2-bursts.yaml',
    check(log, { expect }) {
      const ids = by(log, 'identify-user');
      expect(ids.length === 3, `expected 3 identify-user (login, identical burst, reset+identify), got ${ids.length}`);
      const events = by(log, 'track-event');
      const same = events.filter((r) => eventName(r) === 'burst_event');
      expect(same.length === 1, `20 × identical trackEvent sent ${same.length} requests (expected 1)`);
      for (let i = 0; i < 20; i++) {
        const n = events.filter((r) => eventName(r) === `burst_event_${i}`).length;
        expect(n === 1, `burst_event_${i} sent ${n} times (expected 1)`);
      }
      const burstScreens = by(log, 'track-screen').filter((r) => screenOf(r) === '/burst');
      expect(burstScreens.length <= 2, `20 × identical trackScreen('/burst') sent ${burstScreens.length} (expected ≤ 2: tab + burst)`);
      const surveyScreens = by(log, 'track-screen').filter((r) => screenOf(r) === '/burst-survey');
      expect(surveyScreens.length === 1, `18 × trackScreen on the survey screen sent ${surveyScreens.length} (expected 1)`);
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      expect(status(log, 401).length === 0, `${status(log, 401).length} × 401`);
      expect(status(log, 404).length === 0, `${status(log, 404).length} × 404`);
      // The survey is closed with its X before submitting: one dismissal.
      const dismissals = by(log, 'dismiss-form');
      expect(dismissals.length === 1 && dismissals[0].status === 200, `expected 1 dismiss-form 200 after the X-close, got ${dismissals.map((r) => r.status).join(',') || 'none'}`);
      const dismissedEvents = by(log, 'track-event').filter((r) => eventName(r) === 'form:dismissed');
      expect(dismissedEvents.length === 1, `expected 1 form:dismissed event after the X-close, got ${dismissedEvents.length}`);
    },
  },
  {
    id: 'E3',
    file: 'e3-survey-screen-repeat.yaml',
    scenario: { triggers: { screens: { '/events': { formId: FORM_ID, onPageDelay: 12 } } } },
    check(log, { expect }) {
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      expect(status(log, 404).length === 0, `${status(log, 404).length} × 404`);
    },
  },
  {
    id: 'E4a',
    file: 'e4a-survey-from-identify.yaml',
    scenario: { triggers: { identify: { formId: FORM_ID, onPageDelay: 0 } } },
    check(log, { expect }) {
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      expect(shows[0]?.body?.triggerType === 'automatic', 'show-form not automatic');
    },
  },
  {
    id: 'E4b',
    file: 'e4b-survey-from-event.yaml',
    scenario: { triggers: { events: { home_viewed: { formId: FORM_ID, onPageDelay: 0 } } } },
    check(log, { expect }) {
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      expect(by(log, 'track-event').some((r) => eventName(r) === 'home_viewed' && r.status === 200), 'home_viewed not sent');
    },
  },
  {
    id: 'E4c',
    file: 'e4c-survey-from-ping.yaml',
    check(log, { expect }) {
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      // The SDK doesn't ping while a survey is open (as in 1.4.3 and the web SDK), so the
      // survey can't be offered again until it closes.
      const pingsWhileOpen = shows[0] ? by(log, 'ping').filter((r) => r.at > doneAt(shows[0])) : [];
      expect(pingsWhileOpen.length === 0, `${pingsWhileOpen.length} ping(s) sent while the survey was open`);
    },
  },
  {
    id: 'E5',
    file: 'e5-submit-survey.yaml',
    check(log, { expect, user }) {
      const submits = by(log, 'submit-form');
      expect(submits.length === 1 && submits[0].status === 200, `expected 1 submit-form 200, got ${submits.map((r) => r.status).join(',') || 'none'}`);
      const surveyEvents = by(log, 'track-event').filter((r) => String(eventName(r)).startsWith('form:'));
      expect(surveyEvents.length >= 2, `expected survey events, got ${surveyEvents.length}`);
      const anon = surveyEvents.filter((r) => r.headers['x-user-name'] !== user || !r.headers['x-user-id'] || r.status !== 200);
      expect(anon.length === 0, `${anon.length} survey event(s) not sent for the identified user with 200`);
      expect(by(log, 'dismiss-form').length === 0, 'a submitted survey was reported as dismissed (dismiss-form)');
      expect(!surveyEvents.some((r) => eventName(r) === 'form:dismissed'), 'a submitted survey was reported as dismissed (form:dismissed)');
    },
  },
  {
    id: 'E6',
    file: 'e6-visitor-survey.yaml',
    // The survey covers the login screen, so don't wait for it.
    env: { WAIT_LOGIN: 'false' },
    scenario: { triggers: { screens: { '/login': { formId: FORM_ID, onPageDelay: 0 } } } },
    check(log, { expect }) {
      const shows = by(log, 'show-form');
      expect(shows.length === 1 && shows[0].status === 200, `expected 1 show-form 200, got ${shows.map((r) => r.status).join(',') || 'none'}`);
      const surveyEvents = by(log, 'track-event').filter((r) => String(eventName(r)).startsWith('form:'));
      expect(surveyEvents.length === 0, `${surveyEvents.length} survey event(s) sent for a visitor`);
      expect(status(log, 403).length === 0, `${status(log, 403).length} × 403`);
      expect(log.every((r) => !r.headers['x-user-name']), 'a request carried X-User-Name');
      expect(by(log, 'dismiss-form').length === 0, 'a visitor X-close sent dismiss-form');
    },
  },
  ...['planned-prod', 'per-endpoint-5'].map((preset) => ({
    id: `E7-${preset}`,
    match: 'E7',
    file: 'e7-rate-limits.yaml',
    preset,
    check(log, { expect }) {
      const pause = checkPause(log, expect);
      const submits = by(log, 'submit-form');
      expect(submits.some((r) => r.status === 200), 'submit-form did not reach the mock with 200');
      if (pause) {
        expect(
          submits.some((r) => r.at > pause.pauseStart && r.at < pause.pauseEnd),
          'submit-form was not sent during the pause'
        );
        const after = log.filter((r) => TRACKING.has(r.endpoint) && r.at >= pause.pauseEnd - 300 && r.status === 200);
        expect(after.length > 0, 'no tracking request succeeded after the pause');
      }
    },
  })),
  ...[
    ['mock-secure-api-key', 'valid'],
    ['mock-secure-api-key', 'wrong'],
    ['mock-secure-session-api-key', 'valid'],
    ['mock-secure-session-api-key', 'wrong'],
  ].map(([apiKey, signature]) => ({
    id: `E8-${apiKey.includes('session') ? 'session' : 'plain'}-${signature}`,
    match: 'E8',
    file: 'e8-secure-identify.yaml',
    env: { API_KEY: apiKey, SIGNATURE: signature },
    check(log, { expect }) {
      const ids = by(log, 'identify-user');
      expect(ids.length === 1, `expected 1 identify-user, got ${ids.length}`);
      const id = ids[0];
      if (!id) return;
      expect(Boolean(id.headers['x-user-signature']), 'identify-user had no X-User-Signature');
      expect(!id.headers['x-user-id'], 'identify-user sent X-User-Id');
      const session = apiKey.includes('session');
      if (session) expect(Boolean(id.headers['x-user-session-time']), 'identify-user had no X-User-Session-Time');
      const later = log.filter((r) => r.at > doneAt(id));
      if (signature === 'valid') {
        expect(id.status === 200, `identify-user ${id.status} (expected 200)`);
        const bad = later.filter((r) => !hasIdentity(r) || !r.headers['x-user-signature'] || (session && !r.headers['x-user-session-time']));
        expect(later.length > 0, 'no requests after identify');
        expect(bad.length === 0, `${bad.length} later request(s) without identity + signature headers`);
      } else {
        expect(id.status === 401, `identify-user ${id.status} (expected 401)`);
        const ided = later.filter((r) => r.headers['x-user-id']);
        expect(ided.length === 0, `${ided.length} later request(s) sent as an identified user after a rejected identify`);
      }
    },
  })),
  {
    id: 'E9',
    file: 'e9-logout-login.yaml',
    check(log, { expect, user: typedUser, user2: typedUser2 }) {
      const ids = by(log, 'identify-user');
      // The names the app actually sent (see E1 about Android text entry).
      const user = ids[0]?.body?.userName ?? typedUser;
      const user2 = ids[1]?.body?.userName ?? typedUser2;
      expect(ids.length === 2 && ids.every((r) => r.status === 200), `expected 2 identify-user 200, got ${ids.map((r) => r.status).join(',')}`);
      const idFor = new Map();
      for (const r of log.filter(hasIdentity)) {
        const name = r.headers['x-user-name'];
        const seen = idFor.get(name);
        if (!seen) idFor.set(name, r.headers['x-user-id']);
        else expect(seen === r.headers['x-user-id'], `#${r.seq}: ${name} sent with a different X-User-Id`);
      }
      expect(new Set(idFor.values()).size === idFor.size, 'two user names shared one X-User-Id');
      const second = ids[1];
      expect(Boolean(second), 'no identify for the second user');
      if (second) {
        const later = log.filter((r) => r.at > doneAt(second));
        const bad = later.filter((r) => r.headers['x-user-name'] !== user2 || !r.headers['x-user-id']);
        expect(bad.length === 0, `${bad.length} request(s) after the second login not sent as ${user2}`);
        expect(!later.some((r) => r.headers['x-user-name'] === user), `the first user (${user}) appeared after logout`);
      }
      expect(status(log, 401).length === 0, `${status(log, 401).length} × 401`);
    },
  },
  {
    id: 'E10',
    file: 'e10-background-pause.yaml',
    preset: 'per-endpoint-5',
    check(log, { expect, hooks }) {
      checkPause(log, expect);
      const names = by(log, 'track-event').filter((r) => r.status === 200).map(eventName);
      const dup = names.filter((n, i) => names.indexOf(n) !== i);
      expect(dup.length === 0, `events sent twice: ${dup.join(', ')}`);
      const marker = hooks.find((h) => h?.marker === 'foreground');
      expect(Boolean(marker), 'no foreground marker');
      if (marker) {
        const burst = log.filter((r) => r.at >= marker.receivedAt - 3000 && r.at <= marker.receivedAt + 3000);
        expect(burst.length <= 3, `${burst.length} requests within 3 s of returning to the foreground`);
      }
    },
  },
  {
    id: 'E11',
    file: 'e11-debug-hooks.yaml',
    check(log, { expect, hooks }) {
      const reports = hooks.filter((h) => h?.hook);
      const onRequest = reports.filter((h) => h.hook === 'onRequest');
      const onResponse = reports.filter((h) => h.hook === 'onResponse');
      const sent = onResponse.filter((h) => h.info?.outcome !== 'skipped');
      const skipped = onResponse.filter((h) => h.info?.outcome === 'skipped');
      const sdkRequests = log.filter((r) => r.endpoint);
      expect(onRequest.length === sdkRequests.length, `onRequest fired ${onRequest.length} times for ${sdkRequests.length} requests`);
      expect(sent.length === sdkRequests.length, `onResponse (sent) fired ${sent.length} times for ${sdkRequests.length} requests`);
      const count = (xs, f) => xs.reduce((m, x) => m.set(f(x), (m.get(f(x)) ?? 0) + 1), new Map());
      const a = JSON.stringify([...count(onRequest, (h) => h.info?.endpoint)].sort());
      const b = JSON.stringify([...count(sdkRequests, (r) => r.endpoint)].sort());
      expect(a === b, `onRequest endpoints ${a} ≠ mock ${b}`);
      const collapsed = skipped.filter((h) => h.info?.reason === 'collapsed');
      expect(collapsed.length >= 19, `expected ≥ 19 collapsed reports for 20 identical events, got ${collapsed.length}`);
      const text = JSON.stringify(reports);
      expect(!/mock-api-key|x-api-key|signature/i.test(text), 'a hook report contained the API key or a signature');
    },
  },
];

// ── Device helpers ───────────────────────────────────────────────────────────
function stopApps() {
  const quiet = { stdio: 'ignore' };
  // Stop the app on both platforms: a running copy would add traffic to the mock.
  spawnSync('xcrun', ['simctl', 'terminate', PLATFORM === 'ios' ? DEVICE : 'booted', APP_ID], quiet);
  const adb = path.join(process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`, 'platform-tools/adb');
  spawnSync(adb, [...(PLATFORM === 'android' ? ['-s', DEVICE] : []), 'shell', 'am', 'force-stop', APP_ID], quiet);
}

function screenshot(file) {
  try {
    if (PLATFORM === 'ios') execFileSync('xcrun', ['simctl', 'io', DEVICE, 'screenshot', file], { stdio: 'ignore' });
    else {
      const adb = path.join(process.env.ANDROID_HOME ?? `${process.env.HOME}/Library/Android/sdk`, 'platform-tools/adb');
      writeFileSync(file, execFileSync(adb, ['-s', DEVICE, 'exec-out', 'screencap', '-p']));
    }
  } catch {
    /* best effort */
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const results = [];
const stamp = Date.now() % 100000;

for (const flow of FLOWS) {
  if (ONLY && !ONLY.has(flow.id.toUpperCase()) && !ONLY.has((flow.match ?? '').toUpperCase())) continue;
  const user = `e2e_${flow.id.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${stamp}`;
  const user2 = `${user}_b`;
  const env = { MOCK_URL: MOCK, ENV: 'mock', FORM_ID: FORM_ID, USER: user, USER2: user2, API_KEY: 'mock-api-key', SIGNATURE: 'none', WAIT_HOME: 'true', WAIT_LOGIN: 'true', ...flow.env };

  stopApps();
  await mock('reset', {});
  if (flow.preset) await mock('scenario', { preset: flow.preset });
  if (flow.scenario) await mock('scenario', flow.scenario);

  const started = Date.now();
  process.stdout.write(`${flow.id.padEnd(22)} `);
  const run = spawnSync(
    'maestro',
    ['--device', DEVICE, 'test', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), path.join(HERE, 'flows', flow.file)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  await sleep(1500);
  const all = await mock('requests?limit=5000');
  const hooks = await mock('hooks');
  const log = all.filter(fromPlatform);

  const { failures, expect } = checker();
  if (run.status !== 0) failures.push(`Maestro flow failed:\n${(run.stdout + run.stderr).split('\n').filter((l) => /FAILED|Error|Assertion/.test(l)).slice(0, 8).join('\n')}`);
  try {
    flow.check(log, { expect, user, user2, hooks });
  } catch (e) {
    failures.push(`check threw: ${e.stack}`);
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  const ok = failures.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${seconds}s  ${log.length} requests`);
  if (!ok) {
    for (const f of failures) console.log(`    - ${f.replace(/\n/g, '\n      ')}`);
    const base = path.join(OUT, `${PLATFORM}-${flow.id}`);
    screenshot(`${base}.png`);
    writeFileSync(`${base}-requests.json`, JSON.stringify({ log, hooks }, null, 2));
    writeFileSync(`${base}-maestro.log`, run.stdout + run.stderr);
  }
  results.push({ id: flow.id, ok, seconds, requests: log.length, failures });
}

writeFileSync(path.join(OUT, `${PLATFORM}-summary.json`), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${PLATFORM}: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
