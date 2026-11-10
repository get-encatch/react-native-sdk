/**
 * Renders the real EncatchInlineForm (with react-test-renderer) against the mock
 * API, so its own slot registration and Encatch.setFormVisible() calls are part
 * of the test.
 *
 * Screen focus comes from @react-navigation/native's useIsFocused, loaded through
 * the optional loader with a plain `require`; the test puts a stand-in into
 * Node's require cache so it can switch focus on and off.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_KEY, DEFAULT_FORM_ID, SECOND_FORM_ID } from '../examples/mock-api/src';
import { installMock, type InstalledMock } from './helpers';

const h = React.createElement;
const nodeRequire = createRequire(import.meta.url);
const REACT_NAVIGATION_LOADER = path.join(path.resolve(__dirname, '..'), 'optional/react-navigation-native.js');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let focused = true;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const surveyOn = (formId: string) => ({ formId, onPageDelay: 0 });

async function load() {
  nodeRequire.cache[REACT_NAVIGATION_LOADER] = {
    id: REACT_NAVIGATION_LOADER,
    filename: REACT_NAVIGATION_LOADER,
    loaded: true,
    exports: { useIsFocused: () => focused, useNavigationState: () => null },
  } as any;
  vi.resetModules();
  const { create, act } = await import('react-test-renderer');
  const { EncatchInlineForm } = await import('../src/EncatchInlineForm');
  const { Encatch, _internalEmitter } = await import('../src/encatch');
  const { WebView } = await import('react-native-webview');
  return { create, act, EncatchInlineForm, Encatch, emitter: _internalEmitter, WebView };
}

/** Renders one inline slot inside a parent whose re-renders the test controls. */
async function renderSlot(server: InstalledMock, formId?: string) {
  const l = await load();
  await l.Encatch.init(DEFAULT_API_KEY, { apiBaseUrl: 'http://mock.local', appPackageId: 'com.example.test' });
  const presentations: string[] = [];
  l.emitter.on('showForm', (p: any) => presentations.push(p.presentation));

  let rerender: () => void = () => {};
  function Screen() {
    const [, setTick] = React.useState(0);
    rerender = () => setTick((t) => t + 1);
    return h(l.EncatchInlineForm, { formId });
  }
  let root: any;
  await l.act(async () => {
    root = l.create(h(Screen));
  });

  const settle = (ms = 100) => l.act(async () => wait(ms));
  return {
    ...l,
    server,
    presentations,
    settle,
    /** Number of WebViews the inline slot is rendering (1 = a survey is shown inline). */
    inlineWebViews: () => root.root.findAllByType(l.WebView).length,
    setFocused: async (value: boolean) => {
      focused = value;
      await l.act(async () => rerender());
      await settle();
    },
    unmount: async () => l.act(async () => root.unmount()),
  };
}

beforeEach(() => {
  focused = true;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete nodeRequire.cache[REACT_NAVIGATION_LOADER];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EncatchInlineForm', () => {
  it('guard: an exact slot shows its form inline', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderSlot(server, DEFAULT_FORM_ID);

    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();

    expect(r.presentations).toEqual(['inline']);
    expect(r.inlineWebViews()).toBe(1);
    r.Encatch.stop();
    await r.unmount();
  });

  it('an automatic survey does not take over an inline survey on screen, and shows once the user leaves the screen', async () => {
    const server = installMock({
      scenario: { latencyMs: 0, triggers: { screens: { '/other': surveyOn(SECOND_FORM_ID), '/later': surveyOn(SECOND_FORM_ID) } } },
    });
    const r = await renderSlot(server, DEFAULT_FORM_ID);

    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();
    expect(r.inlineWebViews()).toBe(1);

    // The server picks another survey while the user is on the inline survey.
    await r.act(async () => {
      r.Encatch.trackScreen('/other').catch(() => {});
    });
    await r.settle(200);
    expect(server.of('show-form').map((x) => x.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID]);
    expect(r.inlineWebViews()).toBe(1); // still showing, not replaced

    // The user leaves the screen: the slot clears itself and frees the guard.
    await r.setFocused(false);
    expect(r.inlineWebViews()).toBe(0);
    await r.act(async () => {
      r.Encatch.trackScreen('/later').catch(() => {});
    });
    await r.settle(200);

    expect(server.of('show-form').map((x) => x.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID, SECOND_FORM_ID]);
    expect(r.presentations).toEqual(['inline', 'modal']);
    r.Encatch.stop();
    await r.unmount();
  });

  it('ignores a repeated manual show for the form already open inline (keeps answers in progress)', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderSlot(server, DEFAULT_FORM_ID);

    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();
    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();

    expect(server.count('show-form')).toBe(1);
    expect(r.presentations).toEqual(['inline']);
    r.Encatch.stop();
    await r.unmount();
  });

  it('guard: a manual show for a different form still takes over; the inline slot clears itself', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await renderSlot(server, DEFAULT_FORM_ID);

    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();
    await r.act(async () => {
      r.Encatch.showForm(SECOND_FORM_ID).catch(() => {});
    });
    await r.settle();

    expect(server.count('show-form')).toBe(2);
    expect(r.presentations).toEqual(['inline', 'modal']);
    expect(r.inlineWebViews()).toBe(0); // single-active-form contract
    r.Encatch.stop();
    await r.unmount();
  });

  it('guard: a slot on an unfocused screen does not catch surveys', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    focused = false;
    const r = await renderSlot(server); // wildcard, but its screen isn't focused

    await r.act(async () => {
      r.Encatch.showForm(DEFAULT_FORM_ID).catch(() => {});
    });
    await r.settle();

    expect(r.presentations).toEqual(['modal']);
    expect(r.inlineWebViews()).toBe(0);
    r.Encatch.stop();
    await r.unmount();
  });
});
