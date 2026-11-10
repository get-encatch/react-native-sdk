/**
 * A survey closed with its X before the final submit is a dismissal (1.4.4).
 *
 * Rule agreed for 1.4.4:
 * - Closed before the final submit (including after partial submits on a multi-page
 *   form) → for an identified user, send the `form:dismissed` survey event and the
 *   `dismiss-form` request, and emit the app's `form:dismissed` event.
 * - Closed on the thank-you page (after the final submit or `form:complete`),
 *   "remind me later" and call-to-action buttons → not a dismissal. "Remind me later"
 *   sends its own form:remindmelater survey event for an identified user.
 * - Visitors → nothing at all, not even the app's local event.
 *
 * Renders the real form views and feeds them the survey page's messages through
 * the (stub) WebView's onMessage prop.
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// These tests render the real form views; under a full parallel run the first render can take a few seconds.
vi.setConfig({ testTimeout: 20_000 });

async function load() {
  nodeRequire.cache[REACT_NAVIGATION_LOADER] = {
    id: REACT_NAVIGATION_LOADER,
    filename: REACT_NAVIGATION_LOADER,
    loaded: true,
    exports: { useIsFocused: () => true, useNavigationState: () => null },
  } as any;
  vi.resetModules();
  const { create, act } = await import('react-test-renderer');
  const { EncatchInlineForm } = await import('../src/EncatchInlineForm');
  const { EncatchWebView } = await import('../src/EncatchWebView');
  const { Encatch } = await import('../src/encatch');
  const { WebView } = await import('react-native-webview');
  return { create, act, EncatchInlineForm, EncatchWebView, Encatch, WebView };
}

/** Renders a form view, optionally identifies a user, and returns helpers to drive the survey page. */
async function setup(server: InstalledMock, opts: { view: 'inline' | 'modal'; user?: string }) {
  const l = await load();
  await l.Encatch.init(DEFAULT_API_KEY, { apiBaseUrl: 'http://mock.local', appPackageId: 'com.example.test' });
  const appEvents: string[] = [];
  const appEventPayloads: Array<{ type: string; formId?: string }> = [];
  l.Encatch.on((type: string, payload: { formId?: string }) => {
    appEvents.push(type);
    appEventPayloads.push({ type, formId: payload.formId });
  });

  let root: any;
  await l.act(async () => {
    root = l.create(opts.view === 'inline' ? h(l.EncatchInlineForm, { formId: DEFAULT_FORM_ID }) : h(l.EncatchWebView));
  });
  const settle = (ms = 150) => l.act(async () => wait(ms));

  if (opts.user) {
    await l.act(async () => {
      l.Encatch.identifyUser(opts.user!).catch(() => {});
    });
    await settle(300);
  }

  /** Opens a survey (manual show) and waits until its WebView is on screen. */
  const show = async (formId = DEFAULT_FORM_ID) => {
    await l.act(async () => {
      l.Encatch.showForm(formId).catch(() => {});
    });
    await settle(300);
    expect(root.root.findAllByType(l.WebView).length).toBe(1);
  };

  /**
   * Delivers one message from the survey page, as the WebView would. form:close is
   * sent exactly as the real page sends it (schema-definition react-native-sdk-form
   * +page.svelte): `{ formId, hasThankYouScreen }`, with no feedbackConfigurationId,
   * and the page's formId may be empty.
   */
  const page = async (
    type: string,
    data: Record<string, unknown> = {},
    formId = DEFAULT_FORM_ID,
    opts: { emptyIds?: boolean } = {}
  ) => {
    const webView = root.root.findAllByType(l.WebView)[0];
    if (!webView) throw new Error(`no WebView on screen for ${type}`);
    const message =
      type === 'form:close'
        ? { type, formId: '', data: { formId: '', hasThankYouScreen: false, ...data } }
        : opts.emptyIds
          ? // As the real page can send them: empty formId, no feedbackConfigurationId.
            { type, formId: '', data }
          : { type, formId, data: { feedbackConfigurationId: formId, ...data } };
    await l.act(async () => {
      await webView.props.onMessage({ nativeEvent: { data: JSON.stringify(message) } });
    });
    await settle();
  };

  const dismissedEvents = () => server.of('track-event').filter((r) => r.body.eventName === 'form:dismissed');
  return {
    ...l,
    show,
    page,
    settle,
    appEvents,
    appEventPayloads,
    dismissedEvents,
    dismissRequests: () => server.of('dismiss-form'),
    finish: async () => {
      l.Encatch.stop();
      await l.act(async () => root.unmount());
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete nodeRequire.cache[REACT_NAVIGATION_LOADER];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('closing a survey with its X', () => {
  for (const view of ['modal', 'inline'] as const) {
    it(`${view}: before submitting is a dismissal for an identified user`, async () => {
      const server = installMock({ scenario: { latencyMs: 0 } });
      const r = await setup(server, { view, user: 'alice' });
      await r.show();
      await r.page('form:answered');

      await r.page('form:close');

      expect(r.dismissedEvents()).toHaveLength(1);
      expect(r.dismissedEvents()[0].body.feedbackConfigurationId).toBe(DEFAULT_FORM_ID);
      expect(r.dismissRequests()).toHaveLength(1);
      expect(r.dismissRequests()[0].body.formConfigurationId).toBe(DEFAULT_FORM_ID);
      expect(r.dismissRequests()[0].headers['x-user-name']).toBe('alice');
      expect(r.appEvents.filter((t) => t === 'form:dismissed')).toHaveLength(1);
      await r.finish();
    });
  }

  it('after partial submits on a multi-page form (not the final submit) is a dismissal', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();
    await r.page('form:submit', { isPartialSubmit: true, response: {} });

    await r.page('form:close');

    expect(r.dismissedEvents()).toHaveLength(1);
    expect(r.dismissRequests()).toHaveLength(1);
    await r.finish();
  });

  it('on the thank-you page, after the final submit, is not a dismissal', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();
    await r.page('form:submit', { isPartialSubmit: false, response: {} });

    await r.page('form:close');

    expect(r.dismissedEvents()).toHaveLength(0);
    expect(r.dismissRequests()).toHaveLength(0);
    expect(r.appEvents).not.toContain('form:dismissed');
    await r.finish();
  });

  it('after form:complete is not a dismissal', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'inline', user: 'alice' });
    await r.show();

    // form:complete closes the form itself; no form:close follows.
    await r.page('form:complete');

    expect(r.dismissRequests()).toHaveLength(0);
    expect(r.dismissedEvents()).toHaveLength(0);
    await r.finish();
  });

  it('"remind me later" is not a dismissal; it sends form:remindmelater for an identified user', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();

    // As the page sends it: empty formId, no feedbackConfigurationId.
    await r.page('form:remindmelater', {}, DEFAULT_FORM_ID, { emptyIds: true });

    expect(r.dismissedEvents()).toHaveLength(0);
    expect(r.dismissRequests()).toHaveLength(0);
    const remind = server.of('track-event').filter((x) => x.body.eventName === 'form:remindmelater');
    expect(remind).toHaveLength(1);
    expect(remind[0].body.feedbackConfigurationId).toBe(DEFAULT_FORM_ID);
    expect(remind[0].headers['x-user-name']).toBe('alice');
    expect(r.appEventPayloads.find((e) => e.type === 'form:remindmelater')?.formId).toBe(DEFAULT_FORM_ID);
    await r.finish();
  });

  it('"remind me later" from a visitor sends nothing', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'inline' });
    await r.show();

    await r.page('form:remindmelater', {}, DEFAULT_FORM_ID, { emptyIds: true });

    expect(server.of('track-event').filter((x) => x.body.eventName === 'form:remindmelater')).toHaveLength(0);
    expect(server.requests.filter((x) => x.status >= 400)).toHaveLength(0);
    await r.finish();
  });

  it('a call-to-action that closes the form is not a dismissal', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();

    await r.page('form:ctaTriggered', { action: 'app_navigate', url: '/home' });

    expect(r.dismissedEvents()).toHaveLength(0);
    expect(r.dismissRequests()).toHaveLength(0);
    await r.finish();
  });

  it('for a visitor sends nothing and emits no form:dismissed event', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal' });
    await r.show();

    await r.page('form:close');

    expect(r.dismissedEvents()).toHaveLength(0);
    expect(r.dismissRequests()).toHaveLength(0);
    expect(r.appEvents).not.toContain('form:dismissed');
    expect(server.requests.filter((x) => x.status === 403)).toHaveLength(0);
    await r.finish();
  });

  it('a submitted survey does not carry over: the next survey closed early is a dismissal', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();
    await r.page('form:submit', { isPartialSubmit: false, response: {} });
    await r.page('form:close');
    expect(r.dismissRequests()).toHaveLength(0);

    await r.show(SECOND_FORM_ID);
    await r.page('form:close', {}, SECOND_FORM_ID);

    expect(r.dismissRequests().map((x) => x.body.formConfigurationId)).toEqual([SECOND_FORM_ID]);
    expect(r.dismissedEvents().map((x) => x.body.feedbackConfigurationId)).toEqual([SECOND_FORM_ID]);
    await r.finish();
  });

  it('frees the survey guard, so a later automatic survey still shows', async () => {
    const server = installMock({
      scenario: { latencyMs: 0, triggers: { screens: { '/next': { formId: SECOND_FORM_ID, onPageDelay: 0 } } } },
    });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();
    await r.page('form:close');

    await r.act(async () => {
      r.Encatch.trackScreen('/next').catch(() => {});
    });
    await r.settle(300);

    expect(server.of('show-form').map((x) => x.body.formSlugOrId)).toEqual([DEFAULT_FORM_ID, SECOND_FORM_ID]);
    await r.finish();
  });
});

describe('form ids on survey events when the page sends none', () => {
  for (const view of ['modal', 'inline'] as const) {
    it(`${view}: app events and survey events use the form that was opened`, async () => {
      const server = installMock({ scenario: { latencyMs: 0 } });
      const r = await setup(server, { view, user: 'alice' });
      await r.show();

      for (const type of ['form:show', 'form:started', 'form:section:change', 'form:answered']) {
        await r.page(type, {}, DEFAULT_FORM_ID, { emptyIds: true });
      }

      for (const type of ['form:show', 'form:started', 'form:section:change', 'form:answered']) {
        const ev = r.appEventPayloads.find((e) => e.type === type);
        expect(ev?.formId, `${type} app event`).toBe(DEFAULT_FORM_ID);
      }
      const surveyEvents = server.of('track-event').filter((x) => String(x.body.eventName).startsWith('form:'));
      expect(surveyEvents.map((x) => x.body.eventName)).toEqual(['form:show', 'form:started', 'form:answered']);
      for (const ev of surveyEvents) expect(ev.body.feedbackConfigurationId, String(ev.body.eventName)).toBe(DEFAULT_FORM_ID);
      await r.finish();
    });
  }

  it('the page\'s own form id still wins when it sends one', async () => {
    const server = installMock({ scenario: { latencyMs: 0 } });
    const r = await setup(server, { view: 'modal', user: 'alice' });
    await r.show();

    await r.page('form:started', {}, 'page-form-id');

    expect(r.appEventPayloads.find((e) => e.type === 'form:started')?.formId).toBe('page-form-id');
    await r.finish();
  });
});
