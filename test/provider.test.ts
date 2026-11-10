/**
 * EncatchProvider: context value memoisation and the navigation trackers.
 *
 * The provider loads expo-router / @react-navigation/native through the optional
 * loaders in ../optional/ with a plain `require`. Those packages aren't installed
 * at the repo root, so the tests put stand-in hooks into Node's require cache
 * under the loader paths before loading the provider.
 *
 * The stand-in hooks return new array/object identities on every render, as the
 * real ones can, which is what makes 1.4.3's trackers re-send the same screen.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_KEY } from '../examples/mock-api/src';
import { installMock } from './helpers';

const h = React.createElement;
const nodeRequire = createRequire(import.meta.url);
const ROOT = path.resolve(__dirname, '..');
const EXPO_ROUTER_LOADER = path.join(ROOT, 'optional/expo-router.js');
const REACT_NAVIGATION_LOADER = path.join(ROOT, 'optional/react-navigation-native.js');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/** Router state the stand-in hooks read. */
const router = { pathname: '/home', segments: ['(tabs)', 'home'], params: {} as Record<string, string> };
/** React Navigation state the stand-in hook reads. */
let navState: any = { index: 0, routes: [{ name: 'Home' }] };

function injectLoader(file: string, exports: unknown) {
  nodeRequire.cache[file] = { id: file, filename: file, loaded: true, exports } as any;
}

async function loadProvider() {
  injectLoader(EXPO_ROUTER_LOADER, {
    useSegments: () => [...router.segments],
    usePathname: () => router.pathname,
    useGlobalSearchParams: () => ({ ...router.params }),
  });
  injectLoader(REACT_NAVIGATION_LOADER, {
    useNavigationState: (selector: (s: any) => any) => selector(navState),
  });
  vi.resetModules();
  const { create, act } = await import('react-test-renderer');
  const provider = await import('../src/EncatchProvider');
  const { Encatch } = await import('../src/encatch');
  return { create, act, ...provider, Encatch };
}

const CONFIG = { apiBaseUrl: 'http://mock.local', appPackageId: 'com.example.test' };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  installMock({ scenario: { latencyMs: 0 } });
  router.pathname = '/home';
  router.segments = ['(tabs)', 'home'];
  router.params = {};
  navState = { index: 0, routes: [{ name: 'Home' }] };
});

afterEach(() => {
  delete nodeRequire.cache[EXPO_ROUTER_LOADER];
  delete nodeRequire.cache[REACT_NAVIGATION_LOADER];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders the provider inside a parent whose re-renders the test controls. */
async function renderProvider(
  navigationType: 'expo-router' | 'react-navigation' | null,
  opts: { storedBeforeLaunch?: Record<string, string> } = {}
) {
  const p = await loadProvider();
  if (opts.storedBeforeLaunch) {
    // What a previous run of the app left in storage (same module instance as the SDK).
    const storage = (await import('./mocks/async-storage')).default;
    for (const [k, v] of Object.entries(opts.storedBeforeLaunch)) await storage.setItem(k, v);
  }
  const seen: unknown[] = [];
  const memoRenders = { count: 0 };
  let rerenderParent: () => void = () => {};

  function Consumer() {
    seen.push(p.useEncatch());
    return null;
  }
  // A memoised consumer re-renders only when the context value changes, so its
  // render count shows whether consumers re-render needlessly.
  const MemoConsumer = React.memo(function MemoConsumer() {
    memoRenders.count += 1;
    p.useEncatch();
    return null;
  });
  function Parent() {
    const [, setTick] = React.useState(0);
    rerenderParent = () => setTick((t) => t + 1);
    return h(
      p.EncatchProvider,
      { apiKey: DEFAULT_API_KEY, config: CONFIG, navigationType },
      h(Consumer),
      h(MemoConsumer)
    );
  }

  let root: any;
  await p.act(async () => {
    root = p.create(h(Parent));
  });
  await p.act(async () => {
    await wait(100); // init + startSession settle
  });
  return {
    ...p,
    seen,
    memoRenders,
    /** The latest context value a consumer saw. */
    latest: () => seen.at(-1) as any,
    /** Runs something inside act() and lets the SDK settle. */
    run: async (fn: () => unknown, ms = 150) => {
      await p.act(async () => {
        fn();
        await wait(ms);
      });
    },
    root,
    rerender: async (times = 1) => {
      for (let i = 0; i < times; i++) {
        await p.act(async () => {
          rerenderParent();
        });
      }
      await p.act(async () => {
        await wait(50);
      });
    },
    unmount: async () => {
      await p.act(async () => root.unmount());
    },
  };
}

describe('EncatchProvider', () => {
  it('keeps the same context value when nothing changed', async () => {
    const r = await renderProvider(null);
    const before = r.seen.at(-1);

    await r.rerender(3);

    expect(r.seen.at(-1)).toBe(before);
    await r.unmount();
  });

  it('guard: the context value changes when identity state changes', async () => {
    const r = await renderProvider(null);
    const before = r.seen.at(-1) as any;

    await r.act(async () => {
      r.Encatch.identifyUser('alice').catch(() => {});
      await wait(100);
    });

    const after = r.seen.at(-1) as any;
    expect(after.userName).toBe('alice');
    expect(after).not.toBe(before);
    await r.unmount();
  });

  it('expo-router: tracks a screen once per path change, not on every render', async () => {
    const r = await renderProvider('expo-router');
    const track = vi.spyOn(r.Encatch, 'trackScreen');

    await r.rerender(5); // same path, new segments/params objects each render
    expect(track).not.toHaveBeenCalled();

    router.pathname = '/settings';
    router.segments = ['(tabs)', 'settings'];
    await r.rerender(3);
    expect(track.mock.calls.map((c) => c[0])).toEqual(['/settings']);
    await r.unmount();
  });

  it('react-navigation: tracks a screen once per route change, not on every state change', async () => {
    const r = await renderProvider('react-navigation');
    const track = vi.spyOn(r.Encatch, 'trackScreen');

    // A new state object for the same active route (e.g. a nested navigator updated).
    for (let i = 0; i < 4; i++) {
      navState = { ...navState, routes: [{ name: 'Home', key: `k${i}` }] };
      await r.rerender();
    }
    expect(track).not.toHaveBeenCalled();

    navState = { index: 1, routes: [{ name: 'Home' }, { name: 'Settings' }] };
    await r.rerender();
    expect(track.mock.calls.map((c) => c[0])).toEqual(['/Settings']);
    await r.unmount();
  });

  // The tracker's first call happens before init finishes and is ignored. In 1.4.3
  // the first screen is only sent because the provider re-renders after init and
  // the tracker fires again. Stopping the duplicate calls (step 3) must not lose it.
  it('guard: the first screen is tracked once init finishes, without extra renders', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderProvider('expo-router');

    expect(server.of('track-screen').map((x) => x.body.$deviceInfo.$urlOrScreenName)).toEqual(['/home']);
    await r.unmount();
  });
});

describe('EncatchProvider: stopSession across app restarts', () => {
  const STOPPED = { '@encatch/session_stopped': 'true' };

  it('a stop saved by a previous run keeps the SDK stopped at launch: no ping, no automatic screen', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderProvider('expo-router', { storedBeforeLaunch: STOPPED });

    router.pathname = '/settings';
    router.segments = ['(tabs)', 'settings'];
    await r.rerender();
    await r.run(() => {}, 200);

    expect(server.of('ping')).toHaveLength(0);
    expect(server.of('track-screen')).toHaveLength(0);
    await r.unmount();
  });

  it('while stopped, the app\'s own trackScreen still goes out', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderProvider('expo-router', { storedBeforeLaunch: STOPPED });

    await r.run(() => r.latest().trackScreen('/checkout'));

    expect(server.of('track-screen').map((x) => x.body.$deviceInfo.$urlOrScreenName)).toEqual(['/checkout']);
    await r.unmount();
  });

  it('startSession() turns it back on: ping and the current screen go out, and the saved stop is cleared', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderProvider('expo-router', { storedBeforeLaunch: STOPPED });
    router.pathname = '/settings';
    router.segments = ['(tabs)', 'settings'];
    await r.rerender();

    await r.run(() => r.Encatch.startSession(), 200);

    expect(server.of('ping').length).toBeGreaterThanOrEqual(1);
    expect(server.of('track-screen').map((x) => x.body.$deviceInfo.$urlOrScreenName)).toEqual(['/settings']);
    const storage = (await import('./mocks/async-storage')).default;
    expect(await storage.getItem('@encatch/session_stopped')).toBeNull();
    await r.unmount();
  });

  it('guard: without a saved stop, launch starts the session as before', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderProvider('expo-router');

    expect(server.of('ping').length).toBeGreaterThanOrEqual(1);
    expect(server.of('track-screen')).toHaveLength(1);
    await r.unmount();
  });
});

describe('EncatchProvider: identity transitions', () => {
  const FUNCTIONS = ['identifyUser', 'resetUser', 'trackEvent', 'trackScreen', 'showForm', 'dismissForm', 'submitForm', 'on', 'off'];
  const functionsOf = (v: any) => FUNCTIONS.map((k) => v[k]);

  it('consumers do not re-render when the parent re-renders and nothing changed', async () => {
    const r = await renderProvider(null);
    const before = r.memoRenders.count;

    await r.rerender(5);

    expect(r.memoRenders.count).toBe(before);
    await r.unmount();
  });

  it('guard: visitor → identified: a new value with isIdentified and the user name; consumers re-render', async () => {
    const r = await renderProvider(null);
    const before = r.latest();
    const rendersBefore = r.memoRenders.count;
    expect(before).toMatchObject({ isIdentified: false, userName: null });

    await r.run(() => r.Encatch.identifyUser('alice').catch(() => {}));

    expect(r.latest()).toMatchObject({ isIdentified: true, userName: 'alice' });
    expect(r.latest()).not.toBe(before);
    expect(r.memoRenders.count).toBeGreaterThan(rendersBefore);
    await r.unmount();
  });

  it('guard: identified → visitor on resetUser: a new value with the user cleared; consumers re-render', async () => {
    const r = await renderProvider(null);
    await r.run(() => r.Encatch.identifyUser('alice').catch(() => {}));
    const identified = r.latest();
    const rendersBefore = r.memoRenders.count;
    expect(identified).toMatchObject({ isIdentified: true, userName: 'alice' });

    await r.run(() => r.latest().resetUser());

    expect(r.latest()).toMatchObject({ isIdentified: false, userName: null });
    expect(r.latest()).not.toBe(identified);
    expect(r.memoRenders.count).toBeGreaterThan(rendersBefore);
    await r.unmount();
  });

  it('guard: identified → visitor when the server reports userPendingRetryExhausted', async () => {
    installMock({
      scenario: {
        latencyMs: 0,
        faults: [{ endpoint: 'track-event', count: 1, status: 200, body: { message: 'ok', userPendingRetryExhausted: true } }],
      },
    });
    const r = await renderProvider(null);
    await r.run(() => r.Encatch.identifyUser('alice').catch(() => {}));
    expect(r.latest()).toMatchObject({ isIdentified: true, userName: 'alice' });

    await r.run(() => r.Encatch.trackEvent('anything').catch(() => {}), 300);

    expect(r.latest()).toMatchObject({ isIdentified: false, userName: null });
    await r.unmount();
  });

  it('guard: user switch: keeps the old user until the new identify succeeds, then switches', async () => {
    installMock({
      scenario: { latencyMs: 0, faults: [{ endpoint: 'identify-user', count: 1, match: { userName: 'bob' }, delayMs: 500 }] },
    });
    const r = await renderProvider(null);
    await r.run(() => r.Encatch.identifyUser('alice').catch(() => {}));
    const alice = r.latest();

    await r.run(() => r.Encatch.identifyUser('bob').catch(() => {}), 100);
    expect(r.latest()).toBe(alice); // bob's identify still in flight
    expect(r.latest()).toMatchObject({ isIdentified: true, userName: 'alice' });

    await r.run(() => {}, 700);
    expect(r.latest()).toMatchObject({ isIdentified: true, userName: 'bob' });
    expect(r.latest()).not.toBe(alice);
    await r.unmount();
  });

  it('guard: the functions in the context stay the same across every transition', async () => {
    const r = await renderProvider(null);
    const initial = functionsOf(r.latest());

    await r.run(() => r.Encatch.identifyUser('alice').catch(() => {}));
    expect(functionsOf(r.latest())).toEqual(initial);
    await r.run(() => r.Encatch.identifyUser('bob').catch(() => {}));
    expect(functionsOf(r.latest())).toEqual(initial);
    await r.run(() => r.latest().resetUser());
    expect(functionsOf(r.latest())).toEqual(initial);
    await r.rerender(3);
    for (const [i, fn] of functionsOf(r.latest()).entries()) expect(fn).toBe(initial[i]);
    await r.unmount();
  });
});
