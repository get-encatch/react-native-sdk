/**
 * Schedules exit_form completion CTAs after form:complete when the WebView
 * is torn down before a WebView setTimeout can fire (inline forms).
 */

import { Linking } from 'react-native';
import { Encatch } from './encatch';
import {
  CTA_AFTER_CLOSE_DELAY_MS,
  openRedirectInternalUrl,
  REDIRECT_INTERNAL_AFTER_CLOSE_DELAY_MS,
} from './redirect-browser';

export interface PendingCompletionCta {
  action: 'dismiss' | 'app_navigate' | 'redirect_internal' | 'redirect_external';
  url?: string;
  route?: string;
  surface: 'inApp' | 'link';
  trigger: 'auto';
  autoTriggerDelayMs: number;
}

export function parsePendingCompletionCta(
  raw: unknown
): PendingCompletionCta | null {
  if (!raw || typeof raw !== 'object') return null;
  const map = raw as Record<string, unknown>;
  const action = map.action;
  if (typeof action !== 'string' || !action) return null;
  const delayRaw = map.autoTriggerDelayMs;
  const autoTriggerDelayMs =
    typeof delayRaw === 'number' && delayRaw >= 0 ? delayRaw : 0;
  return {
    action: action as PendingCompletionCta['action'],
    url: typeof map.url === 'string' ? map.url : undefined,
    route: typeof map.route === 'string' ? map.route : undefined,
    surface: map.surface === 'link' ? 'link' : 'inApp',
    trigger: 'auto',
    autoTriggerDelayMs,
  };
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

function getEffectivePendingDelayMs(pending: PendingCompletionCta): number {
  if (pending.autoTriggerDelayMs > 0) return pending.autoTriggerDelayMs;
  if (pending.action === 'redirect_internal') return REDIRECT_INTERNAL_AFTER_CLOSE_DELAY_MS;
  if (pending.action !== 'dismiss') return CTA_AFTER_CLOSE_DELAY_MS;
  return 0;
}

export function cancelPendingCompletionCta(formId?: string): void {
  if (formId) {
    const timer = pendingTimers.get(formId);
    if (timer) {
      clearTimeout(timer);
      pendingTimers.delete(formId);
    }
    return;
  }
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer);
  }
  pendingTimers.clear();
}

function executePendingCompletionCta(
  formId: string,
  pending: PendingCompletionCta,
  logTag: string
): void {
  const { action, url } = pending;
  console.log(`[${logTag}] exit_form: executePendingCompletionCta — action:`, action, '| url:', url ?? '(none)', '| route:', pending.route ?? '(none)');

  const data: Record<string, unknown> = {
    action,
    surface: pending.surface,
    trigger: pending.trigger,
    ...(pending.url ? { url: pending.url } : {}),
    ...(pending.route ? { route: pending.route } : {}),
  };

  if (action === 'dismiss') {
    console.log(`[${logTag}] exit_form: action is dismiss — nothing to do`);
    return;
  }

  if (action === 'app_navigate') {
    console.log(`[${logTag}] exit_form: emitting form:ctaTriggered for app_navigate — route:`, pending.route);
    Encatch.emitEvent('form:ctaTriggered', { formId, data });
    return;
  }

  if (action === 'redirect_internal' && url) {
    console.log(`[${logTag}] exit_form: opening redirect_internal — url:`, url);
    // Defer one frame so the native modal teardown has finished (iOS SFSafariViewController).
    setTimeout(() => {
      openRedirectInternalUrl(url, logTag);
      Encatch.emitEvent('form:ctaTriggered', { formId, data });
    }, 0);
    return;
  }

  if (action === 'redirect_external' && url) {
    console.log(`[${logTag}] exit_form: opening redirect_external — url:`, url);
    Linking.openURL(url).catch((err) => {
      console.warn(`[${logTag}] pendingCompletionCta redirect_external failed:`, url, err);
    });
    Encatch.emitEvent('form:ctaTriggered', { formId, data });
    return;
  }

  console.warn(`[${logTag}] exit_form: executePendingCompletionCta — unhandled case: action="${action}" url="${url}"`);
}

export function schedulePendingCompletionCta(
  formId: string,
  pending: PendingCompletionCta,
  logTag = 'Encatch'
): void {
  cancelPendingCompletionCta(formId);
  const rawDelay = pending.autoTriggerDelayMs;
  const delayMs = getEffectivePendingDelayMs(pending);
  console.log(`[${logTag}] exit_form: schedulePendingCompletionCta — action:`, pending.action, '| rawDelay:', rawDelay, '| effectiveDelay:', delayMs, '| url:', pending.url ?? '(none)', '| route:', pending.route ?? '(none)');
  if (delayMs <= 0) {
    console.log(`[${logTag}] exit_form: executing pending CTA immediately`);
    executePendingCompletionCta(formId, pending, logTag);
    return;
  }
  console.log(`[${logTag}] exit_form: pending CTA will fire in ${delayMs}ms`);
  const timer = setTimeout(() => {
    console.log(`[${logTag}] exit_form: timer fired — executing pending CTA now`);
    pendingTimers.delete(formId);
    executePendingCompletionCta(formId, pending, logTag);
  }, delayMs);
  pendingTimers.set(formId, timer);
}
