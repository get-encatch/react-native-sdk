/**
 * Everything a test, the burst screen or a developer can change about the mock.
 * Defaults model the real gateway + core API (see CONTRACT.md).
 */

export type EndpointName =
  | 'identify-user'
  | 'track-event'
  | 'track-screen'
  | 'ping'
  | 'show-form'
  | 'submit-form'
  | 'dismiss-form'
  | 'refine-text'
  | 'upload'
  | 'qna-with-ai/stream';

export const ENDPOINTS: readonly EndpointName[] = [
  'identify-user',
  'track-event',
  'track-screen',
  'ping',
  'show-form',
  'submit-form',
  'dismiss-form',
  'refine-text',
  'upload',
  'qna-with-ai/stream',
];

export interface ApiKeyConfig {
  /** Referers allowed for this key; '*' allows any non-empty referer. */
  allowedReferers: string[];
  /** Secure identify: the key's secret. Without it, the signature check is skipped. */
  secret?: string;
  /** Secure identify: signature lifetime in minutes; > 0 means the timestamp is signed. */
  sessionTimeMinutes?: number;
  /** 'T' (test) or 'P' (prod) — selects the gateway's default limits. */
  environment: 'T' | 'P';
}

/**
 * Gateway rate-limit models.
 * - `scopes`: the real gateway (ugw-ratelimit). One shared set of buckets for every
 *   endpoint: user (keyed on X-User-Id, skipped when absent), IP and project.
 * - `per-endpoint`: one bucket per endpoint, each with its own key.
 */
export type RateLimitKey = 'user' | 'userName' | 'ip' | 'device';

export interface RateLimitConfig {
  mode: 'off' | 'scopes' | 'per-endpoint';
  windowMs: number;
  scopes: { user?: number; ip?: number; project?: number };
  perEndpoint: Partial<Record<EndpointName, { limit: number; key: RateLimitKey }>>;
}

export interface SurveyTrigger {
  /** The form the server picks (sent as `nextFeedbackId`). */
  formId: string;
  /** Seconds the SDK waits before showing it (sent as `onPageDelay`). */
  onPageDelay?: number;
}

export interface Fault {
  endpoint: EndpointName;
  /** How many matching requests this fault applies to. */
  count: number;
  /** Only requests whose JSON body has these top-level values (shallow match). */
  match?: Record<string, unknown>;
  /** Extra delay for the matching request, in ms. Without `status` or `drop`, the request then continues normally. */
  delayMs?: number;
  /** HTTP status to return. Ignored when `drop` is true. */
  status?: number;
  body?: unknown;
  /** Adds a Retry-After header in seconds, as the gateway does on 429. */
  retryAfterSeconds?: number;
  /** Adds a Retry-After header with this exact value (e.g. an HTTP date). */
  retryAfter?: string;
  /** Simulate a network failure: the fetch rejects. */
  drop?: boolean;
}

export interface Scenario {
  orgId: string;
  projectId: string;
  /** Namespace for X-User-Id = UUIDv5("{org}:{project}:{userName}"). */
  userIdNamespace: string;
  apiKeys: Record<string, ApiKeyConfig>;
  rateLimit: RateLimitConfig;
  /** Fixed latency added to every request, in ms. */
  latencyMs: number;
  /** Random extra latency up to this many ms. */
  jitterMs: number;
  /** Surveys the server picks, by reply type. */
  triggers: {
    identify?: SurveyTrigger;
    ping?: SurveyTrigger;
    events: Record<string, SurveyTrigger>;
    screens: Record<string, SurveyTrigger>;
  };
  /** Forms that exist. Key = form id (UUID) or slug. */
  forms: Record<string, { title: string }>;
  /** Visitors may see forms (in-app "visitors_enabled"). */
  visitorsEnabled: boolean;
  /** Project setting `allow_track_event_for_visitors` (custom events only). */
  allowTrackEventForVisitors: boolean;
  /** Events disabled in admin: 400 "Event '<name>' is not allowed to be captured". */
  disabledEvents: string[];
  /**
   * After an automatic show, further automatic shows of the same form to the same
   * person get 404 "User is not eligible for this form" for this long (ms).
   * Models the production "1 × 200 then 16 × 404".
   */
  autoShowCooldownMs: number;
  /**
   * Report section 4: an identify / track-event / track-screen arriving while a
   * survey is open for that person drops it from their display candidates, so the
   * submit gets 404.
   */
  burstDropsOpenForm: boolean;
  /** The core API's "user pending creation" path for identified users. */
  userPending: { enabled: boolean; exhaustAfter: number; windowMs: number };
  faults: Fault[];
  /**
   * SV8 (planned gateway change): for keys with a secret, check the signature
   * (and session-time expiry) on every /v2/encatch request, not only identify-user.
   * Off by default, like today's gateway.
   */
  enforceSignatureOnAllRequests: boolean;
}

export const DEFAULT_API_KEY = 'mock-api-key';
export const DEFAULT_SECURE_API_KEY = 'mock-secure-api-key';
export const DEFAULT_SECURE_SESSION_API_KEY = 'mock-secure-session-api-key';
export const DEFAULT_SECRET = 'mock-secret';
export const DEFAULT_FORM_ID = '0190f1d2-0000-7000-8000-00000000f001';
export const SECOND_FORM_ID = '0190f1d2-0000-7000-8000-00000000f002';

export const RATE_LIMIT_PRESETS = {
  off: { mode: 'off', windowMs: 60_000, scopes: {}, perEndpoint: {} },
  /** Gateway code defaults for a test ('T') key (ugw-ratelimit/src/model.rs). */
  'code-defaults-test': { mode: 'scopes', windowMs: 60_000, scopes: { user: 10, ip: 50, project: 50 }, perEndpoint: {} },
  /** Gateway code defaults for a prod ('P') key. */
  'code-defaults-prod': { mode: 'scopes', windowMs: 60_000, scopes: { user: 100, ip: 300, project: 40_000 }, perEndpoint: {} },
  /** As described in the production report: 500/min shared, show-form and submit-form separate. */
  report: {
    mode: 'per-endpoint',
    windowMs: 60_000,
    scopes: {},
    perEndpoint: {
      'identify-user': { limit: 500, key: 'device' },
      'track-event': { limit: 500, key: 'device' },
      'track-screen': { limit: 500, key: 'device' },
      ping: { limit: 500, key: 'device' },
      'show-form': { limit: 500, key: 'device' },
      'submit-form': { limit: 500, key: 'device' },
    },
  },
  /** Step 0b: 5 per minute for each endpoint. */
  'per-endpoint-5': {
    mode: 'per-endpoint',
    windowMs: 60_000,
    scopes: {},
    perEndpoint: {
      'identify-user': { limit: 5, key: 'device' },
      'track-event': { limit: 5, key: 'device' },
      'track-screen': { limit: 5, key: 'device' },
      ping: { limit: 5, key: 'device' },
      'show-form': { limit: 5, key: 'device' },
      'submit-form': { limit: 5, key: 'device' },
      'dismiss-form': { limit: 5, key: 'device' },
    },
  },
  /** Decision 7: the limits planned for production. */
  'planned-prod': {
    mode: 'per-endpoint',
    windowMs: 60_000,
    scopes: {},
    perEndpoint: {
      'identify-user': { limit: 5, key: 'userName' },
      'track-screen': { limit: 20, key: 'device' },
      'track-event': { limit: 5, key: 'device' },
      'show-form': { limit: 100, key: 'device' },
      'submit-form': { limit: 100, key: 'device' },
    },
  },
  /** Very small shared limit, for quick tests. */
  tiny: { mode: 'scopes', windowMs: 60_000, scopes: { ip: 5 }, perEndpoint: {} },
} satisfies Record<string, RateLimitConfig>;

export type RateLimitPreset = keyof typeof RATE_LIMIT_PRESETS;

export function defaultScenario(): Scenario {
  return {
    orgId: '1006',
    projectId: '1009',
    userIdNamespace: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
    apiKeys: {
      [DEFAULT_API_KEY]: { allowedReferers: ['*'], environment: 'T' },
      [DEFAULT_SECURE_API_KEY]: { allowedReferers: ['*'], environment: 'T', secret: DEFAULT_SECRET },
      [DEFAULT_SECURE_SESSION_API_KEY]: {
        allowedReferers: ['*'],
        environment: 'T',
        secret: DEFAULT_SECRET,
        sessionTimeMinutes: 15,
      },
    },
    rateLimit: structuredClone(RATE_LIMIT_PRESETS.off) as RateLimitConfig,
    latencyMs: 50,
    jitterMs: 0,
    triggers: { events: {}, screens: {} },
    forms: {
      [DEFAULT_FORM_ID]: { title: 'Mock survey' },
      [SECOND_FORM_ID]: { title: 'Second mock survey' },
    },
    visitorsEnabled: true,
    allowTrackEventForVisitors: false,
    disabledEvents: [],
    autoShowCooldownMs: 24 * 60 * 60 * 1000,
    burstDropsOpenForm: false,
    userPending: { enabled: false, exhaustAfter: 5, windowMs: 5 * 60 * 1000 },
    faults: [],
    enforceSignatureOnAllRequests: false,
  };
}

/** Deep-merges a partial scenario (objects merge, arrays and primitives replace). */
export function mergeScenario<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (base as any)?.[k];
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)
        ? mergeScenario(cur, v)
        : v;
  }
  return out;
}
