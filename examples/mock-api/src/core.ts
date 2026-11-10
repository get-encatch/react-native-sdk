/**
 * Core API layer (rust/core-api). Error bodies are `{status, error, message}`
 * (error.rs), except track-event's visitor 403 which is a TrackEventResponse.
 * Responses are camelCase; optional fields are omitted when absent.
 */
import { randomUUID } from 'node:crypto';
import { showFormReply } from './fixtures/forms';
import type { EndpointName, SurveyTrigger } from './scenario';
import type { MockState } from './state';
import { isUuid, uuidv5 } from './uuid';

export interface CoreReply {
  status: number;
  body: unknown;
  /** qna-with-ai/stream: the SSE events to send instead of a JSON body. */
  sse?: Array<{ event: string; data: unknown }>;
}

/** The core API's system events (services/track_event.rs SYSTEM_EVENTS). */
export const SYSTEM_EVENTS = ['form:show', 'form:started', 'form:dismissed', 'form:complete', 'form:answered'];

const REASON: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  413: 'Payload Too Large',
  429: 'Too Many Requests',
};
const err = (status: number, message: string): CoreReply => ({
  status,
  body: { status, error: REASON[status] ?? 'Error', message },
});
const ok = (body: unknown): CoreReply => ({ status: 200, body });

interface Identity {
  known: boolean;
  userName?: string;
  /** Stable key for per-person state: the user name, or the device id for visitors. */
  person: string;
}

export function handleCore(
  state: MockState,
  endpoint: EndpointName,
  headers: Record<string, string>,
  body: any,
  now: number = Date.now()
): CoreReply {
  const sc = state.scenario;

  // Required on every route (extractors/headers.rs).
  for (const h of ['X-Session-Id', 'X-Device-Id']) {
    if (!headers[h.toLowerCase()]?.trim()) return err(400, `Missing required header: ${h}`);
  }

  // Identity middleware (validate_user_identity.rs), skipped for identify-user.
  const name = headers['x-user-name']?.trim() || '';
  const id = headers['x-user-id']?.trim() || '';
  if (endpoint !== 'identify-user') {
    if (!!name !== !!id) return err(401, 'X-User-Name and X-User-Id must both be present or both absent');
    if (name && id) {
      if (!isUuid(id)) return err(401, 'X-User-Id is not a valid UUID');
      if (id.toLowerCase() !== expectedUserId(state, name)) {
        return err(
          401,
          'User ID does not match expected value for the given X-User-Name, X-Org-Id, and X-Project-Id'
        );
      }
    }
  }
  const who: Identity =
    name && id
      ? { known: true, userName: name, person: `user:${name}` }
      : { known: false, person: `device:${headers['x-device-id']}` };

  switch (endpoint) {
    case 'identify-user': {
      const userName = typeof body?.userName === 'string' ? body.userName.trim() : '';
      if (!userName) return err(401, 'userName not found');
      const person = `user:${userName}`;
      dropOpenFormOnBurst(state, person);
      // A user the server hasn't cached yet (a new user) is told to ping again in 10 s
      // (IDENTIFY_USER_PING_AGAIN_IN_UNCACHED, services/identify_user.rs); a cached one 30 s.
      const isNew = !state.identifiedUsers.has(userName);
      state.identifiedUsers.add(userName);
      const reply = { message: 'ok', userId: expectedUserId(state, userName), ...display(state, sc.triggers.identify, person) };
      return ok(isNew ? { ...reply, pingAgainIn: 10 } : reply);
    }

    case 'track-event': {
      const eventName: string = typeof body?.eventName === 'string' ? body.eventName : '';
      if (eventName.length < 1 || eventName.length > 100) {
        return err(400, 'Validation error: eventName must be between 1 and 100 characters');
      }
      if (!who.known) {
        const forbidden = { status: 403, body: { message: 'Event tracking not allowed for visitors' } };
        if (SYSTEM_EVENTS.includes(eventName)) return forbidden;
        if (!sc.allowTrackEventForVisitors || sc.disabledEvents.includes(eventName)) return forbidden;
      } else if (sc.disabledEvents.includes(eventName)) {
        return err(400, `Event '${eventName}' is not allowed to be captured`);
      }
      const pending = userPendingReply(state, who, now);
      if (pending) return ok(pending);
      dropOpenFormOnBurst(state, who.person);
      return ok({ message: 'ok', ...display(state, sc.triggers.events[eventName], who.person) });
    }

    case 'track-screen': {
      const pending = userPendingReply(state, who, now);
      if (pending) return ok(pending);
      dropOpenFormOnBurst(state, who.person);
      const screen = body?.$deviceInfo?.$urlOrScreenName;
      const trigger = typeof screen === 'string' ? sc.triggers.screens[screen] : undefined;
      return ok({ message: 'ok', ...display(state, trigger, who.person) });
    }

    case 'ping': {
      const pending = userPendingReply(state, who, now);
      if (pending) return ok(pending);
      return ok({ message: 'ok', ...display(state, sc.triggers.ping, who.person) });
    }

    case 'show-form': {
      const ref: string = body?.formSlugOrId || headers['x-feedback-configuration-id'] || '';
      if (!ref) return err(400, 'Missing required field: form_slug_or_id');
      const formId = findForm(state, ref);
      if (!formId) return err(404, `Form not found: ${ref}`);
      if (!who.known && !sc.visitorsEnabled) {
        return err(404, 'Form not available: Form is not available for visitors');
      }
      const key = `${who.person}|${formId}`;
      const automatic = body?.triggerType === 'automatic';
      if (state.dropped.has(key)) return err(404, 'Form not available: User is not eligible for this form');
      if (automatic) {
        const shownAt = state.shown.get(key);
        if (shownAt != null && now - shownAt < sc.autoShowCooldownMs) {
          return err(404, 'Form not available: User is not eligible for this form');
        }
        state.shown.set(key, now);
      }
      state.open.set(who.person, formId);
      return ok(showFormReply(formId, sc.forms[formId].title, randomUUID()));
    }

    case 'submit-form': {
      const details = body?.formDetails;
      if (!details) return err(400, 'Missing required field: form_details');
      const formId: string | undefined = details.formConfigurationId;
      if (!formId) return err(400, 'Missing required field: form_configuration_id');
      if (state.dropped.has(`${who.person}|${formId}`)) {
        return err(404, 'Form not available: User is not eligible for this form');
      }
      if (state.open.get(who.person) === formId && !details.isPartialSubmit) state.open.delete(who.person);
      return ok({ message: 'ok' });
    }

    case 'dismiss-form': {
      if (!who.known) return ok({ message: 'ok' });
      const formId = body?.formConfigurationId;
      if (!formId || !isUuid(String(formId))) return err(400, 'formConfigurationId must be a valid UUID');
      const pending = userPendingReply(state, who, now);
      if (pending) return ok(pending);
      if (state.open.get(who.person) === formId) state.open.delete(who.person);
      return ok({ message: 'ok', pingOnNextPageVisit: true });
    }

    case 'refine-text': {
      if (!body?.questionId || !body?.feedbackConfigurationId || typeof body?.userText !== 'string') {
        return err(400, 'Missing required field: questionId, feedbackConfigurationId or userText');
      }
      return ok({ message: 'ok', refinedText: `${body.userText.trim()} (refined by the mock API)` });
    }

    case 'upload': {
      if (!body?.formId || !body?.questionId || !body?.file) {
        return err(400, 'Missing required multipart field: formId, questionId or file');
      }
      return ok({ fileUrl: `https://mock-api.local/uploads/${randomUUID()}` });
    }

    case 'qna-with-ai/stream': {
      if (!body?.questionId || !body?.feedbackConfigurationId) {
        return err(400, 'Missing required field: questionId or feedbackConfigurationId');
      }
      if (!Array.isArray(body?.conversation) || body.conversation.length === 0) {
        return err(400, 'conversation must not be empty');
      }
      const answer = 'This answer was streamed by the mock API.';
      return {
        status: 200,
        body: null,
        sse: [
          ...answer.split(' ').map((w, i) => ({ event: 'chunk', data: { delta: (i ? ' ' : '') + w } })),
          { event: 'done', data: { answer } },
        ],
      };
    }
  }
}

export function expectedUserId(state: MockState, userName: string): string {
  const sc = state.scenario;
  return uuidv5(`${sc.orgId}:${sc.projectId}:${userName}`, sc.userIdNamespace);
}

/**
 * apply_display_result! (handlers/encatch.rs): when a survey is chosen,
 * nextFeedbackId + onPageDelay, pingAgainIn = 30 + onPageDelay, pingOnNextPageVisit = true.
 * The server keeps choosing it on every reply until the person is no longer a
 * candidate; repeated show-forms then get 404 (see show-form).
 */
function display(state: MockState, trigger: SurveyTrigger | undefined, person: string) {
  if (trigger && state.scenario.forms[trigger.formId] && !state.dropped.has(`${person}|${trigger.formId}`)) {
    const delay = trigger.onPageDelay ?? 0;
    return { nextFeedbackId: trigger.formId, onPageDelay: delay, pingAgainIn: 30 + delay, pingOnNextPageVisit: true };
  }
  return { pingAgainIn: 30, pingOnNextPageVisit: true };
}

/** Report section 4: a burst while a survey is open rebuilds the cache and drops it. */
function dropOpenFormOnBurst(state: MockState, person: string): void {
  if (!state.scenario.burstDropsOpenForm) return;
  const formId = state.open.get(person);
  if (formId) state.dropped.add(`${person}|${formId}`);
}

/** The "user pending creation" path (handlers/encatch.rs:694-729, config.rs:448-458). */
function userPendingReply(state: MockState, who: Identity, now: number) {
  const cfg = state.scenario.userPending;
  if (!cfg.enabled || !who.known) return null;
  const recent = (state.pendingFailures.get(who.person) ?? []).filter((t) => now - t < cfg.windowMs);
  recent.push(now);
  state.pendingFailures.set(who.person, recent);
  const exhausted = recent.length >= cfg.exhaustAfter;
  return {
    message: 'User does not exist / is pending creation',
    pingAgainIn: exhausted ? 900 : 10,
    pingOnNextPageVisit: true,
    ...(exhausted ? { userPendingRetryExhausted: true } : {}),
  };
}

function findForm(state: MockState, ref: string): string | undefined {
  const forms = state.scenario.forms;
  if (forms[ref]) return ref;
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return Object.keys(forms).find((id) => slug(forms[id].title) === ref);
}
