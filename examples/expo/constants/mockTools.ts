/**
 * Test helpers for the end-to-end flows in examples/expo/e2e.
 *
 * - Mock environment: everything here talks to the local mock API (examples/mock-api).
 * - DEV environment: the app talks to the dev API as usual; only the reports below
 *   (debug hooks and SDK events) go to the local mock, which acts as a log collector.
 *   If the mock isn't running, the reports fail silently.
 * Never used for UAT or production.
 */
import type { EncatchConfig, EventPayload, EventType } from '@encatch/react-native-sdk';
import { MOCK_API_URL, type EncatchEnvironment } from './environments';

/** Environments whose SDK activity is reported to the local collector. */
export const reportsToLocalCollector = (env: EncatchEnvironment) => env === 'mock' || env === 'dev';

function report(entry: Record<string, unknown>) {
  fetch(`${MOCK_API_URL}/__mock/hooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...entry, at: Date.now() }),
  }).catch(() => {});
}

/**
 * The SDK's optional debug hooks, reporting every call to the local collector so the
 * E2E flows can check each request's outcome (and, on the mock, compare them with
 * the requests the mock received).
 */
export const mockDebugHooks: Pick<EncatchConfig, 'onRequest' | 'onResponse'> = {
  onRequest: (info) => report({ hook: 'onRequest', info }),
  onResponse: (info) => report({ hook: 'onResponse', info }),
};

/** Reports the form id the SDK is about to show (from onBeforeShowForm). */
export function reportFormShown(formId: string) {
  report({ sdkEvent: 'beforeShowForm', formId });
}

/** Reports the SDK's app events (form:show, form:dismissed, …) with their form ids. */
export function reportSdkEvent(type: EventType, payload: EventPayload) {
  report({ sdkEvent: type, formId: payload.formId ?? null });
}

export type MockSignature = 'none' | 'valid' | 'wrong';

/**
 * Secure mode: in production the customer's backend signs the user name. Here the
 * mock stands in for that backend. 'wrong' flips the signature so the gateway
 * rejects it.
 */
export async function mockSignIdentify(
  userName: string,
  apiKey: string,
  kind: Exclude<MockSignature, 'none'>
): Promise<{ signature: string; generatedDateTimeinUTC?: string }> {
  const res = await fetch(
    `${MOCK_API_URL}/__mock/sign?userName=${encodeURIComponent(userName)}&apiKey=${encodeURIComponent(apiKey)}`
  );
  // `time` comes back only for keys with a session time.
  const { signature, time } = (await res.json()) as { signature: string; time?: string };
  const signed = kind === 'wrong' ? signature.split('').reverse().join('') : signature;
  return { signature: signed, generatedDateTimeinUTC: time };
}
