#!/usr/bin/env node
/**
 * SDK checks against the real DEV API (test project only), driven by Maestro.
 *
 * Unlike run.mjs (mock API), the app talks to api.dev.encatch.com here. The local
 * mock only collects what the example app reports in its DEV environment: each
 * request's outcome (the SDK's onResponse debug hook), the form id the SDK is
 * about to show (onBeforeShowForm), and the SDK's app events (form:show, …).
 * No bursts or rate-limit checks here; those stay on the mock.
 *
 *   pnpm --filter @encatch/mock-api dev     # the local collector
 *   node examples/expo/e2e/run-dev.mjs --platform android --device emulator-5554
 *
 * Needs examples/expo/e2e/.results/dev-project.json (git-ignored): the dev SDK key
 * and the test forms' ids. Options: --only DV1,V2  --out <dir>  --mock <url>.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'com.encatch.expotester';
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
);
const PLATFORM = args.platform;
const DEVICE = args.device;
const MOCK = args.mock ?? 'http://localhost:8787';
const OUT = args.out ?? path.join(HERE, '.results');
const ONLY = args.only ? new Set(args.only.split(',').map((s) => s.trim().toUpperCase())) : null;
if (!['ios', 'android'].includes(PLATFORM) || !DEVICE) {
  console.error('Usage: node run-dev.mjs --platform ios|android --device <id> [--only DV1,V2] [--out dir]');
  process.exit(2);
}
const DEV = JSON.parse(readFileSync(path.join(HERE, '.results/dev-project.json'), 'utf8'));
const F = Object.fromEntries(Object.entries(DEV.forms).map(([k, v]) => [k, v.id]));
const AUTO_FORMS = [F.pageVisit, F.trackedEvent, F.immediate, F.delayed];

async function collector(p, body) {
  const res = await fetch(`${MOCK}/__mock/${p}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`collector ${p}: ${res.status}`);
  return res.json();
}

/** Turns the collector's reports into something the checks can query. */
function view(reports) {
  const responses = reports.filter((r) => r.hook === 'onResponse').map((r) => r.info);
  const sent = responses.filter((i) => i.outcome !== 'skipped');
  const events = reports.filter((r) => r.sdkEvent && r.sdkEvent !== 'beforeShowForm');
  const shown = reports.filter((r) => r.sdkEvent === 'beforeShowForm').map((r) => r.formId);
  return {
    sent,
    of: (endpoint) => sent.filter((i) => i.endpoint === endpoint),
    ok: (endpoint) => sent.filter((i) => i.endpoint === endpoint && i.status === 200),
    errors: sent.filter((i) => i.outcome !== 'ok'),
    events: (type) => events.filter((e) => e.sdkEvent === type),
    shown,
  };
}

const statuses = (xs) => xs.map((i) => `${i.endpoint} ${i.status ?? i.outcome}`).join(', ') || 'none';

function common(v, expect) {
  expect(v.errors.length === 0, `requests that didn't succeed: ${statuses(v.errors)}`);
}

function shownOnly(v, expect, formId, label) {
  expect(v.shown.filter((id) => id === formId).length === 1, `${label}: expected it shown once, shown ids: ${JSON.stringify(v.shown)}`);
  const others = v.shown.filter((id) => id !== formId);
  expect(others.length === 0, `other forms shown too: ${JSON.stringify(others)}`);
  expect(v.ok('show-form').length === 1, `expected 1 show-form 200, got ${statuses(v.of('show-form'))}`);
  const showEvents = v.events('form:show');
  expect(showEvents.length >= 1, 'no form:show app event');
  expect(showEvents.every((e) => e.formId === formId), `form:show app event carried form id ${JSON.stringify(showEvents.map((e) => e.formId))} (expected ${formId})`);
}

function dismissed(v, expect, formId) {
  expect(v.ok('dismiss-form').length === 1, `expected 1 dismiss-form 200, got ${statuses(v.of('dismiss-form'))}`);
  const ev = v.events('form:dismissed');
  expect(ev.length === 1, `expected 1 form:dismissed app event, got ${ev.length}`);
  expect(ev[0]?.formId === formId, `form:dismissed carried form id ${JSON.stringify(ev[0]?.formId)} (expected ${formId})`);
}

function notDismissed(v, expect) {
  expect(v.of('dismiss-form').length === 0, `dismiss-form was sent: ${statuses(v.of('dismiss-form'))}`);
  expect(v.events('form:dismissed').length === 0, 'a form:dismissed app event was emitted');
}

const FLOWS = [
  {
    id: 'DV1',
    title: 'Identified: manual form, answer, submit, close the thank-you screen',
    file: 'd1-manual-submit.yaml',
    env: { FORM_ID: F.manual },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.manual, 'manual form');
      expect(v.ok('submit-form').length >= 1, `expected submit-form 200, got ${statuses(v.of('submit-form'))}`);
      notDismissed(v, expect);
    },
  },
  {
    id: 'DV2',
    title: 'Identified: close the manual form on its welcome screen (dismissal)',
    file: 'd2-dismiss-welcome.yaml',
    env: { FORM_ID: F.manual },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.manual, 'manual form');
      dismissed(v, expect, F.manual);
      expect(v.of('submit-form').length === 0, 'submit-form was sent');
    },
  },
  {
    id: 'DV3',
    title: 'Identified: rate, then close before submitting (dismissal)',
    file: 'd3-dismiss-midform.yaml',
    env: { FORM_ID: F.manual },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.manual, 'manual form');
      dismissed(v, expect, F.manual);
    },
  },
  {
    id: 'DV4',
    title: 'Identified: page visit trigger (/dev-page)',
    file: 'd4-auto-screen.yaml',
    env: { SCREEN: '/dev-page', SURVEY_TIMEOUT: 25000 },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.pageVisit, 'page visit form');
      dismissed(v, expect, F.pageVisit);
    },
  },
  {
    id: 'DV5',
    title: 'Identified: tracked event trigger (dev_event)',
    file: 'd5-auto-event.yaml',
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.trackedEvent, 'tracked event form');
      dismissed(v, expect, F.trackedEvent);
    },
  },
  {
    id: 'DV6',
    title: 'Identified: immediate trigger (/dev-immediate)',
    file: 'd4-auto-screen.yaml',
    env: { SCREEN: '/dev-immediate', SURVEY_TIMEOUT: 45000 },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.immediate, 'immediate form');
      dismissed(v, expect, F.immediate);
    },
  },
  {
    id: 'DV7',
    title: 'Identified: delayed trigger, 20 s after session start (/dev-delayed)',
    file: 'd4-auto-screen.yaml',
    env: { SCREEN: '/dev-delayed', SURVEY_TIMEOUT: 80000 },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.delayed, 'delayed form');
      dismissed(v, expect, F.delayed);
    },
  },
  {
    id: 'DV8',
    title: 'New user signs in, logs out, signs in again as an existing user',
    file: 'd8-new-existing-user.yaml',
    check(v, expect) {
      common(v, expect);
      expect(v.ok('identify-user').length === 2, `expected 2 identify-user 200, got ${statuses(v.of('identify-user'))}`);
    },
  },
  {
    id: 'V1',
    title: 'Visitor: manual form, answer, submit',
    file: 'v-visitor.yaml',
    env: { FORM_ID: F.manual, ACTION: 'show', VALUE: 'unused', SUBMIT: 'true' },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.manual, 'manual form');
      expect(v.ok('submit-form').length >= 1, `expected submit-form 200, got ${statuses(v.of('submit-form'))}`);
      notDismissed(v, expect);
    },
  },
  {
    id: 'V2',
    title: 'Visitor: page visit trigger, closed with the X (no dismissal for visitors)',
    file: 'v-visitor.yaml',
    env: { ACTION: 'screen', VALUE: '/dev-page', SUBMIT: 'false' },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.pageVisit, 'page visit form');
      notDismissed(v, expect);
    },
  },
  {
    id: 'V3',
    title: 'Visitor: tracked event trigger, closed with the X',
    file: 'v-visitor.yaml',
    env: { ACTION: 'event', VALUE: 'dev_event', SUBMIT: 'false' },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.trackedEvent, 'tracked event form');
      notDismissed(v, expect);
    },
  },
  {
    id: 'V4',
    title: 'Visitor: immediate trigger, closed with the X',
    file: 'v-visitor.yaml',
    env: { ACTION: 'screen', VALUE: '/dev-immediate', SUBMIT: 'false' },
    check(v, expect) {
      common(v, expect);
      shownOnly(v, expect, F.immediate, 'immediate form');
      notDismissed(v, expect);
    },
  },
];

function stopApps() {
  const quiet = { stdio: 'ignore' };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
const stamp = Date.now() % 1000000;
const results = [];

for (const flow of FLOWS) {
  if (ONLY && !ONLY.has(flow.id.toUpperCase())) continue;
  const user = `rn_${PLATFORM}_${flow.id.toLowerCase()}_${stamp}`;
  const env = {
    MOCK_URL: MOCK,
    ENV: 'dev',
    API_KEY: DEV.sdkKey,
    FORM_ID: F.manual,
    USER: user,
    USER2: `${user}_b`,
    SIGNATURE: 'none',
    WAIT_HOME: 'true',
    WAIT_LOGIN: 'true',
    ...flow.env,
  };

  stopApps();
  await collector('reset', {});
  const started = Date.now();
  process.stdout.write(`${flow.id.padEnd(5)} ${flow.title.padEnd(78)} `);
  const run = spawnSync(
    'maestro',
    ['--device', DEVICE, 'test', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), path.join(HERE, 'flows/dev', flow.file)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  await sleep(2500);
  const reports = await collector('hooks');
  const v = view(reports);

  const failures = [];
  const expect = (ok, message) => {
    if (!ok) failures.push(message);
  };
  if (run.status !== 0) {
    failures.push(`Maestro flow failed:\n${(run.stdout + run.stderr).split('\n').filter((l) => /FAILED|Error|Assertion/.test(l)).slice(0, 6).join('\n')}`);
  }
  try {
    flow.check(v, expect);
  } catch (e) {
    failures.push(`check threw: ${e.stack}`);
  }

  const ok = failures.length === 0;
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${seconds}s`);
  if (!ok) {
    for (const f of failures) console.log(`      - ${f.replace(/\n/g, '\n        ')}`);
    const base = path.join(OUT, `dev-${PLATFORM}-${flow.id}`);
    screenshot(`${base}.png`);
    writeFileSync(`${base}-reports.json`, JSON.stringify(reports, null, 2));
    writeFileSync(`${base}-maestro.log`, run.stdout + run.stderr);
  }
  results.push({ id: flow.id, title: flow.title, user, ok, seconds, requests: v.sent.length, failures });
}

writeFileSync(path.join(OUT, `dev-${PLATFORM}-summary.json`), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\ndev ${PLATFORM}: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
