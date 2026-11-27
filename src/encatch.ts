/**
 * Encatch React Native SDK — Core
 *
 * The main singleton class. Mirrors the web SDK's encatch.ts + api-client.ts
 * but uses React Native APIs (AsyncStorage, fetch, Platform) instead of
 * browser APIs (localStorage, ky, window).
 *
 * Architecture:
 *  - All public methods are static on the Encatch class.
 *  - An internal EventEmitter connects Encatch to EncatchWebView / EncatchInlineForm for form display.
 *  - A 30-second ping interval mirrors the web SDK behaviour.
 *  - A retry queue wraps identifyUser / trackEvent / trackScreen calls.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { TypedEmitter } from './emitter';
import { DEFAULT_API_BASE_URL, DEFAULT_WEB_HOST } from './constants';
import {
  getOrCreateDeviceId,
  getOrCreateSessionId,
  clearSession,
  setPersistUserAcrossRestarts,
  clearStoredUserData,
  clearMemoryUserData,
  getUserName,
  setUserName,
  clearUserName,
  getUserId,
  setUserId,
  getUserSignature,
  setUserSignature,
  clearUserSignature,
  clearUserId,
  getFeedbackTransactions,
  setFeedbackTransactions,
  clearFeedbackTransactions,
  getPreferences,
  setPreferences,
  clearPreferences,
  getSessionStopped,
  setSessionStopped,
  clearSessionStopped,
} from './storage';
import {
  getDeviceLocale,
  getDeviceTypeEnv,
  getDeviceSize,
  getOsVersion,
  getPlatform,
  getAppPackageId,
  getAppVersion,
  getTimezone,
} from './device-info';
import { currentQueueAttempt, enqueue, flush, removeQueued, startAppStateListener, stopAppStateListener } from './retry-queue';
import { HttpError, errorReasonOf, httpStatusOf, parseRetryAfter } from './http-error';
import { bucketOf, clearPauses, isPaused, pauseFor, pauseRemainingMs } from './rate-limit';
import { createEncatchLogger, type EncatchLogger } from './logger';
import { resolvePresentationTarget } from './form-presentation-registry';
import { cancelPendingCompletionCta } from './pendingCompletionCta';
import type {
  EncatchConfig,
  UserTraits,
  IdentifyOptions,
  StartSessionOptions,
  Theme,
  ShowFormOptions,
  InternalShowFormOptions,
  EventType,
  EventCallback,
  EventPayload,
  ApiDeviceInfo,
  IdentifyUserRequest,
  IdentifyUserResponse,
  TrackEventRequest,
  TrackEventResponse,
  TrackScreenRequest,
  TrackScreenResponse,
  ShowFormRequest,
  ShowFormResponse,
  DismissFormRequest,
  DismissFormResponse,
  PingRequest,
  PingResponse,
  RefineTextRequest,
  RefineTextResponse,
  SubmitFormRequest,
  SubmitFormResponse,
  EncatchInternalEvents,
  EncatchResponseInfo,
  QnaWithAiRequest,
  UploadFileRequest,
  UploadFileResponse,
} from './types';

// ============================================================================
// SDK version (kept in sync with package.json by the build process)
// ============================================================================

/**
 * Replaced at build time with the version from package.json (tsup `define`, and
 * the same `define` in vitest.config.ts). release-it bumps package.json, so the
 * reported $sdkVersion can't drift from the published version again. (1.4.3 and
 * earlier reported a hardcoded "2.0.0".)
 */
declare const __ENCATCH_SDK_VERSION__: string;
const SDK_VERSION: string =
  typeof __ENCATCH_SDK_VERSION__ === 'string' ? __ENCATCH_SDK_VERSION__ : '0.0.0-unknown';

/** Longest a single API request may take before it is aborted (see _post). */
const REQUEST_TIMEOUT_MS = 30_000;

/** submit-form attempts in all when the API answers 429 (see submitForm). */
const SUBMIT_MAX_ATTEMPTS = 3;

/** Survey submits kept while the secure signature is expired (oldest dropped first). */
const MAX_HELD_SUBMITS = 10;

/** Identical trackEvent / trackScreen calls within this window are sent once. */
const COLLAPSE_WINDOW_MS = 1_000;

/** JSON with object keys sorted and Dates as ISO strings, so equal values give equal strings. */
function stableKey(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    // Fingerprint what JSON would send: honour toJSON (as JSON.stringify does).
    if (v && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      return norm((v as { toJSON: () => unknown }).toJSON());
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = norm((v as Record<string, unknown>)[k]);
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(norm(value)) ?? '';
}

/**
 * True when the value can't go in a request body: JSON.stringify throws on it
 * (circular reference, BigInt, a toJSON that returns one), or it holds an
 * invalid Date (toISOString throws).
 */
function hasUnsendableValue(value: unknown): boolean {
  if (value === undefined) return false;
  try {
    JSON.stringify(value);
  } catch {
    return true;
  }
  const seen = new Set<object>();
  const invalidDate = (v: unknown): boolean => {
    if (v instanceof Date) return Number.isNaN(v.getTime());
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some(invalidDate);
  };
  return invalidDate(value);
}

/** Traits as sent: Date values in $set / $setOnce as ISO strings (matches the web SDK). */
function toWireTraits(traits: UserTraits | undefined): UserTraits | undefined {
  if (!traits) return undefined;
  const convertDates = (obj: Record<string, any> | undefined): Record<string, any> | undefined => {
    if (!obj) return undefined;
    return Object.keys(obj).reduce<Record<string, any>>((acc, k) => {
      acc[k] = obj[k] instanceof Date ? (obj[k] as Date).toISOString() : obj[k];
      return acc;
    }, {});
  };
  return { ...traits, $set: convertDates(traits.$set), $setOnce: convertDates(traits.$setOnce) };
}

/**
 * Traits as compared for duplicates: empty operations dropped ($set: {},
 * $unset: [], ...), $unset as a sorted copy (it's a set of names). Null when
 * nothing is left. The caller's object is never changed.
 */
function traitsForDedupe(traits?: UserTraits): Record<string, unknown> | null {
  if (!traits) return null;
  const out: Record<string, unknown> = {};
  for (const [op, v] of Object.entries(traits)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length > 0) out[op] = op === '$unset' ? [...v].sort() : v;
    } else if (typeof v === 'object') {
      const defined: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) defined[k] = x;
      if (Object.keys(defined).length > 0) out[op] = defined;
    } else {
      out[op] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ============================================================================
// API Endpoint paths
// ============================================================================

const ENDPOINTS = {
  IDENTIFY_USER: 'engage-product/encatch/api/v2/encatch/identify-user',
  TRACK_EVENT: 'engage-product/encatch/api/v2/encatch/track-event',
  TRACK_SCREEN: 'engage-product/encatch/api/v2/encatch/track-screen',
  SHOW_FORM: 'engage-product/encatch/api/v2/encatch/show-form',
  DISMISS_FORM: 'engage-product/encatch/api/v2/encatch/dismiss-form',
  PING: 'engage-product/encatch/api/v2/encatch/ping',
  REFINE_TEXT: 'engage-product/encatch/api/v2/encatch/refine-text',
  SUBMIT_FORM: 'engage-product/encatch/api/v2/encatch/submit-form',
  UPLOAD: 'engage-product/encatch/api/v2/encatch/upload',
  QNA_WITH_AI_STREAM: 'engage-product/encatch/api/v2/encatch/qna-with-ai/stream',
} as const;

// ============================================================================
// Internal event emitter (Encatch <-> EncatchWebView)
// ============================================================================

// Typed internal emitter — shared singleton imported by EncatchWebView
export const _internalEmitter = new TypedEmitter<EncatchInternalEvents>();

// ============================================================================
// Encatch singleton
// ============================================================================

/** "engage-product/encatch/api/v2/encatch/track-event" → "track-event". */
function endpointName(endpoint: string): string {
  const i = endpoint.indexOf('/encatch/');
  return i >= 0 ? endpoint.slice(endpoint.lastIndexOf('/encatch/') + '/encatch/'.length) : endpoint;
}

class EncatchSDK {
  // Initialisation state
  private _initialized = false;
  private _debugMode = false;

  // Config
  private _apiKey: string | null = null;
  private _apiBaseUrl = DEFAULT_API_BASE_URL;
  private _webHost = DEFAULT_WEB_HOST;
  private _isFullScreen = false;

  // Identity
  private _userName: string | null = null;
  private _userId: string | null = null;
  private _userSignature: string | null = null;
  /** generatedDateTimeinUTC of the stored signature (keys with a session time). */
  private _userSignatureTime: string | null = null;
  /**
   * The stored session-time signature expired (the gateway answered 401). Until
   * the app identifies again: background calls are skipped, submits are held.
   */
  private _signatureExpired = false;
  /**
   * The user each survey was shown to (by feedbackConfigurationId; null for a
   * visitor). A submit for it is made for that user, not whoever is current when
   * the user taps submit (the app may have switched user while it was open).
   */
  private _formShownFor = new Map<string, string | null>();
  /** Survey submits held while the signature is expired, with the user they were made for. */
  private _heldSubmits: Array<{ params: SubmitFormRequest; user: string | null }> = [];
  /**
   * Users onSignatureExpired was called for because the app's own new signature
   * was rejected as expired. Not called again for them until an identify for them
   * succeeds, so a signature that keeps being rejected can't cause a loop.
   * Entering the expired state always calls it (that happens once by itself) and
   * adds the user here too.
   */
  private _expiryNotifiedFor = new Set<string>();
  /**
   * A confirmed identity: restored at init, or set when an identify reply is
   * applied; cleared by resetUser / clearAll. What isIdentified() and the hook's
   * isIdentified report. During a user switch it keeps describing the previous
   * user until the new user's identify succeeds.
   */
  private _identityConfirmed = false;
  /**
   * The user whose identify succeeded (or who was restored with their id at
   * init): the only user setUserProperties() may update. Cleared by resetUser /
   * clearAll.
   */
  private _confirmedName: string | null = null;
  /** Identifies queued or retrying, by user name: setUserProperties() waits for them. */
  private _pendingIdentifies = new Map<string, Set<Promise<void>>>();

  // Preferences
  private _locale: string | null = null;
  private _country: string | null = null;
  private _theme: Theme = 'system';

  // Current screen (updated by EncatchProvider / trackScreen)
  private _currentScreen: string | null = null;

  // Async-loaded ids (populated after init)
  private _deviceId: string | null = null;
  private _sessionId: string | null = null;

  // Feedback transactions (persisted opaque string returned by API)
  private _feedbackTransactions: string | null = null;

  // Ping interval
  private _pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private _pingTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _pingIntervalMs = 30000;
  private _isPingActive = false;

  // Whether a form is currently visible (suppresses ping)
  private _isFormVisible = false;

  // Show-form guard: forms being requested, the form on screen (requested id and
  // server id), and the one pending delayed automatic show.
  private _loadingFormIds = new Set<string>();
  private _openFormIds: string[] = [];
  private _pendingAutoShow: ReturnType<typeof setTimeout> | null = null;

  // Session control state
  private _isSessionPaused = false;
  private _isSessionStopped = false;
  /** EncatchProvider's autoStartVisitorSession prop (default true). */
  private _autoStartVisitorSession = true;
  /**
   * Automatic tracking is held: no ping, no automatic screens (the app's own
   * calls still go out). Set at launch and on resetUser when
   * autoStartVisitorSession is false and the user is a visitor, and by clearAll()
   * whatever the setting (consent withdrawal: nothing automatic until the app
   * asks again, even after init()). Cleared by any startSession() (a successful
   * identify included).
   */
  private _visitorQuiet = false;
  /**
   * A session was asked for in this run: startSession() was called (directly or
   * by a successful identify) or EncatchProvider's launch start ran (even when a
   * saved stopSession() held it back). resetUser() keeps the ping running only
   * then, so it never starts a session that wasn't meant to run.
   */
  private _sessionRequested = false;

  // App version (can be set by consumer)
  private _appVersion = '1.0.0';
  private _appPackageName: string | null = null;

  // Event callbacks (external SDK consumers via Encatch.on())
  private _eventCallbacks: EventCallback[] = [];

  // Dedupe: identify memory, and recent event / screen calls.
  /**
   * identifyUser() dedupe, for this app run only (1.5.0, PostHog-style): the user
   * an identify was sent (or is in flight) for, the last traits and the last
   * options (signature) sent. Cleared when that identify fails or is dropped, and
   * by resetUser / clearAll; setUserProperties clears the traits.
   */
  private _identifiedName: string | null = null;
  private _lastTraitsKey: string | null = null;
  private _lastOptionsKey: string | null = null;
  /** Locale / country the last identify carried (only when it gave them). */
  private _lastIdentifyLocale: string | null = null;
  private _lastIdentifyCountry: string | null = null;
  /** The identify the memory above belongs to (a failed or dropped one clears it). */
  private _identifyMemoryToken: object | null = null;
  /** The identify that set _lastTraitsKey (when it's dropped, those traits weren't sent). */
  private _traitsMemoryToken: object | null = null;
  private _lastEventAt = new Map<string, number>();
  private _lastScreen: { name: string; at: number } | null = null;

  // Interceptor (optional — called before showing any form)
  private _onBeforeShowForm: EncatchConfig['onBeforeShowForm'] = undefined;

  // Optional debug hooks (never given the API key, headers, signature or bodies).
  private _onRequest: EncatchConfig['onRequest'] = undefined;
  private _onResponse: EncatchConfig['onResponse'] = undefined;
  private _signatureExpiredHook: EncatchConfig['onSignatureExpired'] = undefined;

  // Logger (uses react-native-logs when debugMode and package installed)
  private _logger: EncatchLogger = createEncatchLogger(false);

  // ============================================================================
  // Initialisation
  // ============================================================================

  async init(apiKey: string, config?: EncatchConfig): Promise<void> {
    this._debugMode = config?.debugMode ?? false;
    this._logger = createEncatchLogger(this._debugMode);

    if (this._initialized) {
      this._logger.debug('SDK already initialized');
      return;
    }

    this._apiKey = apiKey;

    this._apiBaseUrl = (config?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    this._webHost = (config?.webHost ?? DEFAULT_WEB_HOST).replace(/\/+$/, '');
    this._isFullScreen = config?.isFullScreen ?? false;

    if (config?.theme) {
      this._theme = config.theme;
    }
    this._onBeforeShowForm = config?.onBeforeShowForm;
    this._onRequest = config?.onRequest;
    this._onResponse = config?.onResponse;
    this._signatureExpiredHook = config?.onSignatureExpired;

    this._logger.debug('Initializing SDK...');

    // persistUserAcrossRestarts false: the user lives in memory for this run only,
    // and user data an earlier run saved on the device is deleted.
    const persistUser = config?.persistUserAcrossRestarts !== false;
    setPersistUserAcrossRestarts(persistUser);
    if (!persistUser) await clearStoredUserData();

    // Load persisted identity, app package, and app version
    const [storedName, deviceId, sessionId, prefs, appPackageId, appVersion] = await Promise.all([
      getUserName(),
      getOrCreateDeviceId(),
      getOrCreateSessionId(),
      getPreferences(),
      getAppPackageId(),
      getAppVersion(),
    ]);

    this._deviceId = deviceId;
    this._sessionId = sessionId;
    this._appPackageName = config?.appPackageId?.trim() || appPackageId || null;
    this._appVersion = config?.appVersion ?? appVersion ?? '1.0.0';

    if (!this._appPackageName) {
      // Logged at warn level so it shows even without debugMode: without a
      // Referer the API rejects every call and forms silently never appear.
      this._logger.warn(
        'Could not detect the app package name / bundle ID, so API requests will be ' +
          'rejected ("referer is required"). Install react-native-device-info ' +
          '(bare React Native) or expo-application (Expo), or pass appPackageId in the config.'
      );
    }

    // A stopSession() from a previous run stays in effect until startSession() or a
    // successful identify (matches the web SDK).
    this._isSessionStopped = await getSessionStopped();

    // Restore locale / country from previous session (matches web SDK hydration)
    if (prefs.locale != null) this._locale = prefs.locale;
    if (prefs.country != null) this._country = prefs.country;

    if (storedName) {
      this._userName = storedName;
      this._userId = await getUserId(storedName);
      await this._loadStoredSignature(storedName);
      this._feedbackTransactions = await getFeedbackTransactions(storedName);
    } else {
      this._feedbackTransactions = await getFeedbackTransactions('anonymous');
    }
    this._identityConfirmed = !!(this._userName && this._userId);
    this._confirmedName = this._identityConfirmed ? this._userName : null;

    this._initialized = true;
    // Survey X-close before submit, reported by the form views (once, even if init runs again).
    _internalEmitter.off('closedBeforeSubmit', this._closedBeforeSubmitListener);
    _internalEmitter.on('closedBeforeSubmit', this._closedBeforeSubmitListener);
    // EncatchProvider's automatic session start and screen tracking (respect stopSession()).
    _internalEmitter.off('startSessionOnLaunch', this._startSessionOnLaunchListener);
    _internalEmitter.on('startSessionOnLaunch', this._startSessionOnLaunchListener);
    _internalEmitter.off('autoTrackScreen', this._autoTrackScreenListener);
    _internalEmitter.on('autoTrackScreen', this._autoTrackScreenListener);

    // Start retry queue AppState listener
    startAppStateListener();

    // Flush any queued requests from a previous session
    flush().catch(() => {});

    this._logger.debug('SDK initialized. deviceId:', deviceId);
  }

  // ============================================================================
  // Identity
  // ============================================================================

  async identifyUser(
    userName: string,
    traits?: UserTraits,
    options?: IdentifyOptions
  ): Promise<void> {
    if (!this._initialized) return;
    // Identity changes run one after the other, so a resetUser() fired just
    // before (and not awaited) finishes first and can't undo this identify.
    return this._runIdentityOp(() => this._identifyNow(userName, traits, options));
  }

  private async _identifyNow(
    userName: string,
    traits?: UserTraits,
    options?: IdentifyOptions
  ): Promise<void> {
    // Traits a request body can't carry would fail inside the queue: refuse now.
    if (hasUnsendableValue(traits) || hasUnsendableValue(options?.secure)) {
      this._logger.warn(
        `identifyUser "${userName}" ignored: traits contain a value that can't be sent (circular object, BigInt or invalid Date).`
      );
      return;
    }

    // Dedupe (docs/1.5.0-IDENTIFY-DEDUPE-PLAN.md). Sent: the first identify of
    // this app run or a different user, a changed signature, a locale / country
    // that differs from what the last identify carried, new traits. Not sent:
    // the same user again with no traits, or the same traits, as the last
    // identify sent or still in flight. stopSession() and a signature expiry
    // clear this memory, so the next identify goes out (it ends both).
    let traitsKey: string | null;
    let optionsKey: string;
    try {
      const dedupeTraits = traitsForDedupe(traits);
      traitsKey = dedupeTraits ? stableKey(dedupeTraits) : null;
      optionsKey = stableKey({
        signature: options?.secure?.signature ?? null,
        signatureTime: options?.secure?.generatedDateTimeinUTC ?? null,
      });
    } catch {
      this._logger.warn(
        `identifyUser "${userName}" ignored: traits contain a value that can't be sent (circular object, BigInt or invalid Date).`
      );
      return;
    }
    const localeChanged = options?.locale != null && options.locale !== this._lastIdentifyLocale;
    const countryChanged = options?.country != null && options.country !== this._lastIdentifyCountry;
    const duplicate =
      userName === this._identifiedName &&
      optionsKey === this._lastOptionsKey &&
      !localeChanged &&
      !countryChanged &&
      (traitsKey === null || traitsKey === this._lastTraitsKey);
    if (duplicate) {
      this._logger.debug(
        `identifyUser "${userName}" skipped: same user and traits as the last identify in this app run. ` +
          `To update properties again on purpose (for example a repeated $increment), use setUserProperties("${userName}", traits).`
      );
      this._reportSkipped('identify-user', 'duplicate');
      return;
    }
    const memoryToken = {};
    if (userName !== this._identifiedName) {
      this._lastTraitsKey = null;
      this._traitsMemoryToken = null;
      this._lastIdentifyLocale = null;
      this._lastIdentifyCountry = null;
    }
    this._identifiedName = userName;
    this._lastOptionsKey = optionsKey;
    if (traitsKey !== null) {
      this._lastTraitsKey = traitsKey;
      this._traitsMemoryToken = memoryToken;
    }
    if (options?.locale != null) this._lastIdentifyLocale = options.locale;
    if (options?.country != null) this._lastIdentifyCountry = options.country;
    this._identifyMemoryToken = memoryToken;

    // Switching user: take this user's stored id (or none) together with the
    // name, so a request never pairs this name with another user's id. With no
    // stored id, requests go out as a visitor until the identify reply arrives
    // (the server rejects a name without its id).
    if (userName !== this._userName) {
      const storedId = await getUserId(userName);
      const previous = this._userName;
      this._userName = userName;
      this._userId = storedId;
      // The expired state and held submits belong to the previous user's signature:
      // end it and drop them, so that user's answers are never sent as this user.
      // Done together with the name change, so no call goes out in between.
      // Coming back to that user later starts afresh (onSignatureExpired can be called again).
      if (previous) this._expiryNotifiedFor.delete(previous);
      this._signatureExpired = false;
      if (this._heldSubmits.length > 0) {
        console.warn(
          `[Encatch] ${this._heldSubmits.length} held survey submit(s) dropped: identifyUser() switched to another user`
        );
        this._heldSubmits = [];
      }
      // Not confirmed until this user's identify succeeds (setUserProperties waits for it).
      this._confirmedName = null;
      await this._loadStoredSignature(userName);
    }
    await setUserName(userName);

    // Apply locale/country from IdentifyOptions if provided
    if (options?.locale != null) {
      this._locale = options.locale;
      setPreferences({ locale: options.locale }).catch(() => {});
    }
    if (options?.country != null) {
      this._country = options.country;
      setPreferences({ country: options.country }).catch(() => {});
    }

    // Convert Date objects in $set / $setOnce to ISO strings (matches web SDK)
    const userAttributes = toWireTraits(traits);

    // Build the request
    const deviceInfo = await this._buildDeviceInfo();
    const req: IdentifyUserRequest = {
      userName,
      userId: this._userId ?? undefined,
      userSignature: options?.secure?.signature ?? undefined,
      $deviceInfo: deviceInfo,
      userAttributes,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    // While tracking is paused after a 429, hold only the latest identify: it is
    // sent when the pause ends, so a sign-in during a pause isn't lost and
    // repeated calls don't pile up.
    if (isPaused('tracking')) removeQueued('identifyUser');

    const finishPending = this._addPendingIdentify(userName);
    const sendIdentify = async (): Promise<void> => {
      const res = await this._post<IdentifyUserResponse>(ENDPOINTS.IDENTIFY_USER, req, {
        identifyUserName: userName,
        signature: options?.secure?.signature,
        signatureTime: options?.secure?.generatedDateTimeinUTC,
      });
      // A reply for a user who is no longer current (reset or switched since):
      // keep the id for that user, but don't apply it.
      if (this._userName !== userName) {
        if (res.userId) await setUserId(userName, res.userId);
        this._logger.debug(`identify reply for "${userName}" ignored: no longer the current user`);
        return;
      }
      // Persist server-issued userId
      if (res.userId) {
        this._userId = res.userId;
        await setUserId(userName, res.userId);
      }
      // Secure identify: from now on the signature (and its time) go on every
      // request for this user, and survive restarts. An identify without
      // `secure` clears them.
      const secure = options?.secure;
      if (secure?.signature) {
        this._userSignature = secure.signature;
        this._userSignatureTime = secure.generatedDateTimeinUTC ?? null;
        await setUserSignature(userName, { signature: secure.signature, time: this._userSignatureTime });
      } else {
        this._userSignature = null;
        this._userSignatureTime = null;
        await clearUserSignature(userName);
      }
      this._expiryNotifiedFor.delete(userName);
      this._endSignatureExpired();
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        await setFeedbackTransactions(userName, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);

      // Notify listeners that the user is now fully identified (userName + userId)
      this._identityConfirmed = !!(this._userName && this._userId);
      if (this._identityConfirmed && this._userName === userName) this._confirmedName = userName;
      _internalEmitter.emit('userIdentified', {
        userName: this._userName,
        userId: this._userId,
      });

      // Start session after successful identify — ping interval runs but no
      // immediate ping or trackScreen fires (matches web SDK behaviour exactly).
      // Exception: a visitor whose session wasn't running (autoStartVisitorSession
      // false) also sends the current screen, which was skipped while quiet.
      const wasVisitorQuiet = this._visitorQuiet;
      await this.startSession({ skipImmediatePing: true, skipImmediateTrackScreen: !wasVisitorQuiet });

      // Apply pingAgainIn from identify response after session is started
      if (typeof res.pingAgainIn === 'number' && res.pingAgainIn > 0) {
        this._scheduleNextPing(res.pingAgainIn * 1000);
      }

      // Survey the server picked for this user
      this._handleSurveyInReply(res);
    };

    enqueue('identifyUser', async () => {
      await sendIdentify();
      finishPending();
    }, undefined, () => {
      finishPending();
      // Dropped without succeeding: allow the same identify to be sent again.
      if (this._identifyMemoryToken === memoryToken) this._clearIdentifyMemory();
      // Its traits weren't sent, even if a later identify (without traits) took over.
      else if (this._traitsMemoryToken === memoryToken) {
        this._lastTraitsKey = null;
        this._traitsMemoryToken = null;
      }
    });

    // Immediately flush so identify is best-effort real-time
    flush().catch(() => {});
  }

  /** Registers an identify for `userName` as pending; the returned function ends it. */
  private _addPendingIdentify(userName: string): () => void {
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const set = this._pendingIdentifies.get(userName) ?? new Set<Promise<void>>();
    set.add(done);
    this._pendingIdentifies.set(userName, set);
    return () => {
      finish();
      set.delete(done);
      if (set.size === 0 && this._pendingIdentifies.get(userName) === set) this._pendingIdentifies.delete(userName);
    };
  }

  /** A survey is loading, on screen, or about to be shown (pending automatic show). */
  private _isSurveyOpen(): boolean {
    return this._loadingFormIds.size > 0 || this._isFormVisible || this._pendingAutoShow !== null;
  }

  // Waiting for an open survey to close: one shared check every 500 ms, also run
  // when a survey closes. stop() / clearAll() release every waiter.
  private _surveyIdleWaiters: Array<() => void> = [];
  private _surveyIdleTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by stop() / clearAll(): waits started before then give up. */
  private _lifecycleGen = 0;
  /** Bumped by clearAll() only: a survey submit waiting from before then is dropped. */
  private _clearAllGen = 0;

  private _waitForSurveyIdle(): Promise<void> {
    return new Promise<void>((resolve) => {
      this._surveyIdleWaiters.push(resolve);
      if (!this._surveyIdleTimer) this._surveyIdleTimer = setInterval(() => this._checkSurveyIdle(), 500);
    });
  }

  private _checkSurveyIdle(release = false): void {
    if (!release && this._initialized && this._isSurveyOpen()) return;
    if (this._surveyIdleTimer) clearInterval(this._surveyIdleTimer);
    this._surveyIdleTimer = null;
    const waiters = this._surveyIdleWaiters;
    this._surveyIdleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // setUserProperties requests go out one after the other, in call order: the
  // next is queued only when the previous one is sent or dropped, so a retried
  // older update can't land after a newer one.
  private _userPropsWaiting: Array<() => void> = [];
  private _userPropsBusy = false;

  private _pumpUserProps(): void {
    if (this._userPropsBusy) return;
    const next = this._userPropsWaiting.shift();
    if (!next) return;
    this._userPropsBusy = true;
    next();
  }

  /**
   * Updates the identified user's properties (same operations as identifyUser's
   * traits). Never deduped: every call is sent. `userName` must be the current
   * user and their identify must have succeeded; otherwise the call is ignored,
   * so a pending or failed switch can't update the wrong person. Waits for an
   * identify of that user still in flight, and for an open survey to close.
   * Resolves once the update is queued or ignored.
   */
  async setUserProperties(userName: string, traits: UserTraits): Promise<void> {
    if (!this._initialized) return;
    if (hasUnsendableValue(traits)) {
      this._logger.warn(
        `setUserProperties("${userName}") ignored: traits contain a value that can't be sent (circular object, BigInt or invalid Date).`
      );
      return;
    }
    if (!traitsForDedupe(traits)) {
      this._logger.debug('setUserProperties ignored: no traits to set.');
      return;
    }
    // A copy of what will be sent, taken now: the caller may change the object meanwhile.
    const wire = JSON.parse(JSON.stringify(toWireTraits(traits))) as UserTraits;
    const counts =
      !!(wire.$increment && Object.keys(wire.$increment).length) || !!(wire.$decrement && Object.keys(wire.$decrement).length);

    // Identity calls made before this one run first; then wait (outside the
    // identity chain, so a resetUser() isn't held up) for an identify of this
    // user still in flight, and for an open survey to close.
    const gen = this._lifecycleGen;
    for (;;) {
      const pending = await this._runIdentityOp(async () => {
        const set = this._pendingIdentifies.get(userName);
        return set && set.size > 0 ? { wait: [...set] } : null;
      });
      if (pending) {
        await Promise.all(pending.wait);
      } else if (this._initialized && this._isSurveyOpen()) {
        await this._waitForSurveyIdle();
      } else {
        break;
      }
      if (gen !== this._lifecycleGen || !this._initialized) return;
    }
    return this._runIdentityOp(async () => this._setUserPropertiesNow(userName, wire, counts));
  }

  private async _setUserPropertiesNow(userName: string, wire: UserTraits, counts: boolean): Promise<void> {
    if (!this._initialized) return;
    if (!this._userName) {
      this._logger.debug('setUserProperties ignored: no user is identified. Call identifyUser() first.');
      this._reportSkipped('identify-user', 'not-identified');
      return;
    }
    if (this._userName !== userName) {
      this._logger.warn(`setUserProperties("${userName}") ignored: the current user is "${this._userName}".`);
      this._reportSkipped('identify-user', 'wrong-user');
      return;
    }
    if (!this._userId || this._confirmedName !== userName) {
      this._logger.warn(`setUserProperties("${userName}") ignored: "${userName}" isn't identified (identifyUser failed or was never called).`);
      this._reportSkipped('identify-user', 'not-identified');
      return;
    }
    if (this._signatureExpired) {
      this._logger.debug(`setUserProperties("${userName}") ignored: secure signature expired, waiting for identify`);
      this._reportSkipped('identify-user', 'signature-expired');
      return;
    }
    if (isPaused('tracking')) {
      this._logger.warn('setUserProperties ignored: rate limited, try again later.');
      this._reportSkipped('identify-user', 'rate-limited');
      return;
    }

    // A later identifyUser() with traits is sent again (properties may have changed since).
    this._lastTraitsKey = null;
    this._traitsMemoryToken = null;

    const userId = this._userId;
    const gen = this._lifecycleGen;
    const deviceInfo = await this._buildDeviceInfo();
    const req: IdentifyUserRequest = {
      userName,
      userId,
      $deviceInfo: deviceInfo,
      userAttributes: wire,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this._userPropsBusy = false;
      this._pumpUserProps();
    };
    const send = async (): Promise<void> => {
      // Checked again just before sending: a reset or switch may have happened.
      if (gen !== this._lifecycleGen || this._userName !== userName || this._confirmedName !== userName || this._userId !== userId) {
        this._logger.debug(`setUserProperties("${userName}") not sent: the user changed`);
        return finish();
      }
      if (this._signatureExpired) {
        this._reportSkipped('identify-user', 'signature-expired');
        return finish();
      }
      // A survey opened meanwhile: send after it closes (an identify-user during
      // an open survey can drop it on the server).
      if (this._isSurveyOpen()) {
        void this._waitForSurveyIdle().then(() => (gen === this._lifecycleGen ? queueIt() : finish()));
        return;
      }
      const res = await this._post<IdentifyUserResponse>(ENDPOINTS.IDENTIFY_USER, req, {
        identifyUserName: userName,
        signature: this._userSignature ?? undefined,
        signatureTime: this._userSignatureTime ?? undefined,
        storedSignature: true,
      });
      // A reply for a user who is no longer current (reset or switched since): ignore it.
      if (this._userName !== userName) return finish();
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        await setFeedbackTransactions(userName, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
      this._handleSurveyInReply(res);
      finish();
    };
    // Increments are sent once: a retry after a timeout could apply them twice.
    const queueIt = () => {
      enqueue('setUserProperties', send, counts ? 1 : undefined, finish);
      flush().catch(() => {});
    };
    this._userPropsWaiting.push(queueIt);
    this._pumpUserProps();
  }

  // ============================================================================
  // Preferences
  // ============================================================================

  setLocale(locale: string): void {
    this._locale = locale;
    setPreferences({ locale }).catch(() => {});
  }

  setCountry(country: string): void {
    this._country = country;
    setPreferences({ country }).catch(() => {});
  }

  setTheme(theme: Theme): void {
    this._theme = theme;
  }

  // ============================================================================
  // Event tracking
  // ============================================================================

  async trackEvent(eventName: string): Promise<void> {
    if (!this._initialized) return;
    // Skip tracking in fullscreen mode (matches web SDK)
    if (this._isFullScreen) return;
    // Rate limited (429): skip new events until the pause ends.
    if (isPaused('tracking')) {
      this._logger.debug(`trackEvent "${eventName}" skipped: rate limited`);
      this._reportSkipped('track-event', 'rate-limited');
      return;
    }
    if (this._signatureExpired) {
      this._logger.debug(`trackEvent skipped: secure signature expired, waiting for identify`);
      this._reportSkipped('track-event', 'signature-expired');
      return;
    }
    // Collapse the same event fired again within COLLAPSE_WINDOW_MS.
    const now = Date.now();
    const lastAt = this._lastEventAt.get(eventName);
    if (lastAt != null && now - lastAt < COLLAPSE_WINDOW_MS) {
      this._logger.debug(`trackEvent "${eventName}" collapsed (same event within ${COLLAPSE_WINDOW_MS} ms)`);
      this._reportSkipped('track-event', 'collapsed');
      return;
    }
    this._lastEventAt.set(eventName, now);
    if (this._lastEventAt.size > 200) {
      for (const [name, at] of this._lastEventAt) if (now - at >= COLLAPSE_WINDOW_MS) this._lastEventAt.delete(name);
    }

    const deviceInfo = await this._buildDeviceInfo();
    const req: TrackEventRequest = {
      eventName,
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    enqueue('trackEvent', async () => {
      const res = await this._post<TrackEventResponse>(ENDPOINTS.TRACK_EVENT, req);
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
      this._handleSurveyInReply(res);
    });

    flush().catch(() => {});
  }

  /**
   * Best-effort server call for form lifecycle events (form:show, form:started, etc.).
   * Not enqueued — matches web SDK behaviour where form events are fire-and-forget.
   */
  async _trackFormEvent(eventName: string, feedbackConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;
    if (isPaused('tracking')) {
      this._reportSkipped('track-event', 'rate-limited');
      return;
    }
    if (this._signatureExpired) {
      this._reportSkipped('track-event', 'signature-expired');
      return;
    }
    // Survey events (form:show, form:started, …) are only accepted for an
    // identified user; the server rejects them from visitors with 403. So they're
    // sent only when the request would carry both identity headers (this also
    // skips them during a new user's first identify, before the id arrives).
    if (!(this._userName && this._userId)) {
      this._logger.debug(`survey event "${eventName}" not sent: no identified user`);
      this._reportSkipped('track-event', 'visitor');
      return;
    }
    const deviceInfo = await this._buildDeviceInfo();
    const req: TrackEventRequest = {
      eventName,
      feedbackConfigurationId,
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };
    try {
      const res = await this._post<TrackEventResponse>(ENDPOINTS.TRACK_EVENT, req);
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
      this._handleSurveyInReply(res);
    } catch {
      /* best effort — do not throw */
    }
  }

  async trackScreen(screenName: string): Promise<void> {
    if (!this._initialized) return;
    // Skip tracking in fullscreen mode (matches web SDK)
    if (this._isFullScreen) return;

    this._currentScreen = screenName;
    // Rate limited (429): the current screen is still remembered (it goes with
    // the next ping), but no request is sent until the pause ends.
    if (isPaused('tracking')) {
      this._logger.debug(`trackScreen "${screenName}" skipped: rate limited`);
      this._reportSkipped('track-screen', 'rate-limited');
      return;
    }
    if (this._signatureExpired) {
      this._logger.debug(`trackScreen skipped: secure signature expired, waiting for identify`);
      this._reportSkipped('track-screen', 'signature-expired');
      return;
    }
    // Collapse only when the screen hasn't changed since the last one tracked
    // (a quick /home → /cart → /home is still sent in full).
    const screenAt = Date.now();
    if (this._lastScreen && this._lastScreen.name === screenName && screenAt - this._lastScreen.at < COLLAPSE_WINDOW_MS) {
      this._logger.debug(`trackScreen "${screenName}" collapsed (same screen within ${COLLAPSE_WINDOW_MS} ms)`);
      this._reportSkipped('track-screen', 'collapsed');
      return;
    }
    this._lastScreen = { name: screenName, at: screenAt };

    const deviceInfo = await this._buildDeviceInfo(screenName);
    const req: TrackScreenRequest = {
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    enqueue('trackScreen', async () => {
      const res = await this._post<TrackScreenResponse>(ENDPOINTS.TRACK_SCREEN, req);
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
      this._handleSurveyInReply(res);
    });

    flush().catch(() => {});
  }

  // ============================================================================
  // Form display
  // ============================================================================

  async showForm(formId: string, options?: ShowFormOptions): Promise<void> {
    if (!this._initialized) return;
    await this._showFormInternal(formId, { ...options, triggerType: 'manual' });
  }

  private async _showFormInternal(
    formId: string,
    options?: InternalShowFormOptions
  ): Promise<void> {
    if (isPaused('show-form')) {
      this._logger.debug(`showForm "${formId}" skipped: rate limited`);
      this._reportSkipped('show-form', 'rate-limited');
      return;
    }
    const triggerType = options?.triggerType ?? 'manual';
    // Automatic (server-chosen) shows never interrupt a survey that is loading or
    // on screen, modal or inline. A manual show is ignored only for the same form
    // while it is loading or open, so answers in progress aren't lost; a manual
    // show for a different form still replaces the open one.
    if (triggerType === 'automatic') {
      if (this._signatureExpired || this._loadingFormIds.size > 0 || this._isFormVisible) {
        this._logger.debug(`automatic showForm "${formId}" ignored: a survey is already loading or open`);
        this._reportSkipped('show-form', this._signatureExpired ? 'signature-expired' : 'survey-open');
        return;
      }
    } else if (this._loadingFormIds.has(formId) || (this._isFormVisible && this._openFormIds.includes(formId))) {
      this._logger.debug(`showForm "${formId}" ignored: that survey is already loading or open`);
      this._reportSkipped('show-form', 'duplicate');
      return;
    }
    this._loadingFormIds.add(formId);
    try {
      await this._requestAndShowForm(formId, triggerType, options);
    } finally {
      this._loadingFormIds.delete(formId);
    }
  }

  private async _requestAndShowForm(
    formId: string,
    triggerType: 'automatic' | 'manual',
    options?: InternalShowFormOptions
  ): Promise<void> {
    cancelPendingCompletionCta(formId);
    const resetMode = options?.reset ?? 'always';

    // Serialize context: convert Date values to ISO strings
    const serializedContext = options?.context
      ? Object.entries(options.context).reduce<Record<string, string | number | boolean>>(
          (acc, [key, value]) => {
            acc[key] = value instanceof Date ? value.toISOString() : (value as string | number | boolean);
            return acc;
          },
          {}
        )
      : undefined;

    const deviceInfo = await this._buildDeviceInfo();

    const req: ShowFormRequest = {
      formSlugOrId: formId,
      triggerType,
      language: this._locale ?? undefined,
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    try {
      const shownFor = this._userName;
      const res = await this._post<ShowFormResponse>(ENDPOINTS.SHOW_FORM, req);
      // Requested for a signed-in user who is no longer current (switched or signed
      // out meanwhile): don't show it to someone else.
      if (shownFor !== null && this._userName !== shownFor) {
        this._logger.debug(`showForm ${formId}: not shown, the user changed while it was loading`);
        return;
      }
      if (res.feedbackConfigurationId) this._formShownFor.set(res.feedbackConfigurationId, shownFor);

      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);

      cancelPendingCompletionCta(res.feedbackConfigurationId);

      const prefillResponses = this.getPendingResponses();
      const payload = {
        formId,
        formConfig: res,
        resetMode,
        triggerType,
        prefillResponses,
        locale: this._locale ?? undefined,
        theme: this._theme,
        context: serializedContext,
      };

      if (this._onBeforeShowForm) {
        const allow = await Promise.resolve(this._onBeforeShowForm(payload));
        if (!allow) {
          this.clearPendingResponses();
          return;
        }
      }

      // Resolve presentation: inline slot wins over modal when registered.
      const target = resolvePresentationTarget({ formId, formConfig: res });

      // Emit to EncatchWebView (modal) or EncatchInlineForm (inline)
      _internalEmitter.emit('showForm', {
        formId,
        formConfig: res,
        resetMode,
        triggerType,
        prefillResponses: Object.keys(prefillResponses).length > 0 ? prefillResponses : undefined,
        locale: this._locale ?? undefined,
        theme: this._theme,
        context: serializedContext,
        presentation: target.type,
        inlineSlotId: target.type === 'inline' ? target.slotId : undefined,
      });

      this._isFormVisible = true;
      this._openFormIds = [formId, res.feedbackConfigurationId].filter((id): id is string => !!id);
    } catch (err) {
      this._logger.warn('showForm API error:', err);
    }
  }

  /** Used internally when server returns a formConfigurationId auto-trigger */
  private _showFormById(
    formConfigurationId: string,
    options?: InternalShowFormOptions
  ): void {
    this._showFormInternal(formConfigurationId, options).catch(() => {});
  }

  /**
   * A survey the server picked in a reply to identify-user, track-event (including
   * survey events), track-screen or ping. The server sends nextFeedbackId +
   * onPageDelay; formConfigurationId is still read for older servers. Every
   * source goes through the same single pending show, so duplicates can't stack.
   */
  private _handleSurveyInReply(res: { nextFeedbackId?: string; onPageDelay?: number; formConfigurationId?: string }): void {
    if (res.nextFeedbackId) this._scheduleAutoShow(res.nextFeedbackId, res.onPageDelay);
    else if (res.formConfigurationId) this._scheduleAutoShow(res.formConfigurationId, 0);
  }

  /**
   * A survey the server picked (nextFeedbackId), shown after onPageDelay seconds.
   * Only one can be pending: later ones are ignored until it has run, and none is
   * scheduled while a survey is loading or open.
   */
  private _scheduleAutoShow(formId: string, onPageDelay?: number): void {
    if (this._signatureExpired) {
      this._reportSkipped('show-form', 'signature-expired');
      return;
    }
    if (this._pendingAutoShow || this._loadingFormIds.size > 0 || this._isFormVisible) {
      this._logger.debug(`automatic survey "${formId}" ignored: one is already pending, loading or open`);
      this._reportSkipped('show-form', 'survey-open');
      return;
    }
    const delaySec = typeof onPageDelay === 'number' && onPageDelay > 0 ? onPageDelay : 0;
    this._pendingAutoShow = setTimeout(() => {
      this._pendingAutoShow = null;
      this._showFormById(formId, { triggerType: 'automatic', reset: 'always' });
    }, delaySec * 1000);
  }

  /** The open survey was closed, dismissed or cleared. */
  private _markFormClosed(): void {
    this._isFormVisible = false;
    // Closed (any way: after submit, X, back, a CTA): no longer tied to who it was shown to.
    for (const id of this._openFormIds) this._formShownFor.delete(id);
    this._openFormIds = [];
    if (this._surveyIdleWaiters.length > 0) this._checkSurveyIdle();
  }

  private _cancelPendingAutoShow(): void {
    if (this._pendingAutoShow) {
      clearTimeout(this._pendingAutoShow);
      this._pendingAutoShow = null;
    }
  }

  async dismissForm(formConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;

    cancelPendingCompletionCta(formConfigurationId);

    _internalEmitter.emit('dismissForm', { formConfigurationId });
    this._markFormClosed();

    this._trackFormEvent('form:dismissed', formConfigurationId).catch(() => {});
    await this._sendDismiss(formConfigurationId);
    this.emitEvent('form:dismissed', { formId: formConfigurationId ?? '' });
  }

  /**
   * The user closed a survey with its X before the final submit (reported by the
   * form views). This is a dismissal: the dismiss-form request and the app's
   * form:dismissed event, for a visitor too (as the web SDK does), so the server
   * stops offering the survey; the form:dismissed survey event only for an
   * identified user, as the server rejects survey events from visitors. The view
   * closes itself.
   */
  private async _onClosedBeforeSubmit(formConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;
    // the survey event skips itself for a visitor (and says so), as in dismissForm()
    this._trackFormEvent('form:dismissed', formConfigurationId).catch(() => {});
    await this._sendDismiss(formConfigurationId);
    this.emitEvent('form:dismissed', { formId: formConfigurationId ?? '' });
  }

  private readonly _closedBeforeSubmitListener = (p: { formConfigurationId?: string }) => {
    this._onClosedBeforeSubmit(p.formConfigurationId).catch(() => {});
  };

  /** EncatchProvider starts the session at launch, unless a stopSession() is in effect. */
  private readonly _startSessionOnLaunchListener = () => {
    this._sessionRequested = true;
    if (this._isSessionStopped) {
      this._logger.debug('session not started at launch: stopSession() is in effect until startSession() or identifyUser()');
      return;
    }
    if (!this._autoStartVisitorSession && !(this._userName && this._userId)) {
      this._visitorQuiet = true;
      this._logger.debug('visitor session not started at launch: autoStartVisitorSession is false');
      return;
    }
    this.startSession().catch(() => {});
  };

  /**
   * EncatchProvider's autoStartVisitorSession prop. Read at launch and on
   * resetUser(), so a change while the app runs applies from the next sign-out
   * or launch. @internal
   */
  _setAutoStartVisitorSession(enabled: boolean): void {
    this._autoStartVisitorSession = enabled;
  }

  /**
   * A screen from EncatchProvider's navigation tracker. While stopped it isn't sent,
   * but it's remembered, so startSession() tracks the current screen. (The app's own
   * trackScreen() calls are still sent while stopped.)
   */
  private readonly _autoTrackScreenListener = (p: { screenName: string }) => {
    if (this._isSessionStopped) {
      if (this._initialized && !this._isFullScreen) this._currentScreen = p.screenName;
      this._logger.debug(`automatic screen "${p.screenName}" not sent: stopSession() is in effect`);
      return;
    }
    if (this._visitorQuiet) {
      if (this._initialized && !this._isFullScreen) this._currentScreen = p.screenName;
      this._logger.debug(`automatic screen "${p.screenName}" not sent: visitor session not started (autoStartVisitorSession is false)`);
      return;
    }
    this.trackScreen(p.screenName).catch(() => {});
  };

  /** POST dismiss-form (best effort). */
  private async _sendDismiss(formConfigurationId?: string): Promise<void> {
    if (formConfigurationId) this._formShownFor.delete(formConfigurationId);
    const deviceInfo = await this._buildDeviceInfo();
    const req: DismissFormRequest = {
      formConfigurationId,
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    try {
      const res = await this._post<DismissFormResponse>(ENDPOINTS.DISMISS_FORM, req);
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
    } catch {
      /* silent — dismiss is best effort */
    }
  }

  // ============================================================================
  // Form response helpers
  // ============================================================================

  // Pre-filled responses stored by addToResponse, sent with sdk:prefillResponses.
  // Keys may be question IDs or slugs; the form engine resolves slugs to IDs.
  private _pendingResponses: Record<string, unknown> = {};

  /**
   * Pre-fills a response before showing a form.
   * @param questionId - The ID or slug of the question to prepopulate. When a slug
   *   is provided the form engine resolves it to the matching question ID automatically.
   * @param value - The value to set
   */
  addToResponse(questionId: string, value: unknown): void {
    this._pendingResponses[questionId] = value;
  }

  getPendingResponses(): Record<string, unknown> {
    return { ...this._pendingResponses };
  }

  clearPendingResponses(): void {
    this._pendingResponses = {};
  }

  // ============================================================================
  // Submit form (called by EncatchWebView after form:submit)
  // ============================================================================

  async submitForm(params: SubmitFormRequest): Promise<void> {
    const formId = params.formDetails?.formConfigurationId;
    // Shown to a visitor (null) or not shown by the SDK: made for whoever submits it.
    // Kept until the survey closes, so a repeated final submit resolves the same way.
    const forUser = (formId ? this._formShownFor.get(formId) : undefined) ?? this._userName;
    return this._submitFormFor(params, forUser);
  }

  /**
   * Sends a submit made for `forUser` (the user current when the survey was
   * submitted). An identified user's answers are never sent as anyone else: if
   * that user is no longer current when it would go out (switched or reset while
   * it waited), it is dropped. A visitor's submit (`forUser` null) goes out as is.
   */
  private async _submitFormFor(params: SubmitFormRequest, forUser: string | null): Promise<void> {
    if (!this._initialized) return;
    const gen = this._clearAllGen;
    const userChanged = () => {
      if (gen !== this._clearAllGen) {
        // clearAll() while it waited (consent withdrawn): everything from before is gone.
        console.warn('[Encatch] A survey submit was dropped: clearAll() ran while it was waiting to be sent.');
        return true;
      }
      if (forUser === null || this._userName === forUser) return false;
      console.warn('[Encatch] A survey submit was dropped: the user it was made for is no longer the current user.');
      return true;
    };
    if (userChanged()) return;
    // Secure signature expired: hold the answers until the app identifies again.
    if (this._signatureExpired) {
      this._holdSubmit(params, forUser);
      return;
    }

    const deviceInfo = await this._buildDeviceInfo();
    const req: SubmitFormRequest = {
      ...params,
      $deviceInfo: deviceInfo as Record<string, unknown>,
    };

    // A submit carries the user's answers, so it is never dropped for a 429: it
    // waits for the pause to end and is retried, up to SUBMIT_MAX_ATTEMPTS times
    // in all. Kept in memory only (lost if the app is killed meanwhile).
    for (let attempt = 1; attempt <= SUBMIT_MAX_ATTEMPTS; attempt++) {
      const wait = pauseRemainingMs('submit-form');
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(() => resolve(), wait));
      // Checked right before sending: _post builds the identity headers synchronously.
      if (userChanged()) return;
      try {
        const res = await this._post<SubmitFormResponse>(ENDPOINTS.SUBMIT_FORM, req, { attempt });
        if (res.$feedbackTransactions) {
          this._feedbackTransactions = res.$feedbackTransactions;
          const key = this._userName ?? 'anonymous';
          await setFeedbackTransactions(key, res.$feedbackTransactions);
        }
        this._handleResponseMeta(res);
        return;
      } catch (err) {
        if (httpStatusOf(err) === 429 && attempt < SUBMIT_MAX_ATTEMPTS) continue;
        if (httpStatusOf(err) === 401 && this._signatureExpired) {
          this._holdSubmit(params, forUser);
          return;
        }
        this._logger.warn('submitForm API error:', err);
        return;
      }
    }
  }

  // ============================================================================
  // Refine text (called by EncatchWebView after form:refineTextRequest)
  // ============================================================================

  async refineText(params: RefineTextRequest): Promise<RefineTextResponse> {
    if (!this._initialized) throw new Error('[Encatch] SDK not initialized');

    const deviceInfo = await this._buildDeviceInfo();
    const req: RefineTextRequest = {
      ...params,
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    return this._post<RefineTextResponse>(ENDPOINTS.REFINE_TEXT, req);
  }

  // ============================================================================
  // Q&A with AI — streaming (SSE)
  // ============================================================================

  /**
   * Streams an AI-generated answer via Server-Sent Events.
   *
   * Uses XMLHttpRequest progress events because React Native fetch often does
   * not expose response.body.getReader().
   *
   * @param params - The Q&A request parameters
   * @param callbacks.onChunk - Called for each incremental delta
   * @param callbacks.onDone  - Called with the complete final answer when the stream ends
   */
  async streamQnaWithAi(
    params: QnaWithAiRequest,
    callbacks: {
      onChunk: (delta: string) => void;
      onDone: (answer: string) => void;
    }
  ): Promise<void> {
    if (!this._initialized) throw new Error('[Encatch] SDK not initialized');

    if (!params.feedbackConfigurationId || !params.questionId || !params.conversation?.length) {
      throw new Error('[Encatch] feedbackConfigurationId, questionId, and conversation are required for qna-with-ai stream');
    }

    const url = `${this._apiBaseUrl}/${ENDPOINTS.QNA_WITH_AI_STREAM}`;
    const headers = this._buildHeaders();

    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let processedLength = 0;
      let buffer = '';
      let finished = false;
      let accumulatedAnswer = '';

      const handleSseBlock = (block: string) => {
        const eventName = block.match(/^event:\s*(.+)$/m)?.[1]?.trim();
        const dataRaw = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.replace(/^data:\s?/, ''))
          .join('\n')
          .trim();
        if (!eventName || !dataRaw) return;

        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(dataRaw) as Record<string, unknown>;
        } catch {
          return;
        }

        if (eventName === 'chunk') {
          const delta = typeof payload.delta === 'string' ? payload.delta : '';
          accumulatedAnswer += delta;
          callbacks.onChunk(delta);
        } else if (eventName === 'done') {
          finished = true;
          const answer = typeof payload.answer === 'string' ? payload.answer : accumulatedAnswer;
          callbacks.onDone(answer);
          resolve();
        } else if (eventName === 'error') {
          finished = true;
          const msg = typeof payload.message === 'string' ? payload.message : 'Stream error';
          reject(new Error(msg));
        }
      };

      const processNewText = () => {
        const responseText = xhr.responseText ?? '';
        const chunk = responseText.slice(processedLength);
        processedLength = responseText.length;
        buffer += chunk;

        const blocks = buffer.split(/\r?\n\r?\n/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          if (finished) return;
          handleSseBlock(block);
        }
      };

      xhr.open('POST', url);
      for (const [key, value] of Object.entries(headers)) {
        xhr.setRequestHeader(key, value);
      }

      xhr.onprogress = processNewText;

      xhr.onload = () => {
        if (finished) return;
        processNewText();

        if (xhr.status < 200 || xhr.status >= 300) {
          let message = `HTTP ${xhr.status}`;
          try {
            const err = JSON.parse(xhr.responseText) as { message?: string; error?: string };
            message = err.message ?? err.error ?? message;
          } catch {
            // ignore parse failure; use default message
          }
          reject(new Error(message));
          return;
        }

        if (buffer.trim()) {
          handleSseBlock(buffer);
        }

        if (!finished) {
          callbacks.onDone(accumulatedAnswer);
          resolve();
        }
      };

      xhr.onerror = () => {
        if (!finished) reject(new Error('[Encatch] Network error during Q&A with AI stream'));
      };

      xhr.ontimeout = () => {
        if (!finished) reject(new Error('[Encatch] Q&A with AI stream timed out'));
      };

      xhr.send(JSON.stringify(params));
    });
  }

  // ============================================================================
  // File upload (XHR with progress tracking)
  // ============================================================================

  /**
   * Uploads a file to the Encatch server.
   *
   * Uses XMLHttpRequest instead of fetch so that upload progress can be tracked
   * via the xhr.upload.onprogress event, which fetch does not expose.
   *
   * Accepts either a standard Blob or a React Native file descriptor
   * ({ uri, name?, type? }) as returned by image pickers and document pickers.
   *
   * @param params - The upload parameters including the file and optional progress callback
   * @returns The permanent URL of the uploaded file
   */
  uploadFile(params: UploadFileRequest): Promise<UploadFileResponse> {
    if (!this._apiKey) {
      return Promise.reject(new Error('[Encatch] SDK not initialized'));
    }

    return new Promise<UploadFileResponse>((resolve, reject) => {
      const form = new FormData();
      form.append('formId', params.feedbackConfigurationId);
      form.append('questionId', params.questionId);

      const fileName = params.fileName ?? 'upload';
      // RN's FormData.append type only accepts 2 args, but the runtime supports
      // an optional filename as a 3rd arg (used by multipart boundary). Cast to any.
      (form as any).append('file', params.file, fileName);

      const xhr = new XMLHttpRequest();
      const url = `${this._apiBaseUrl}/${ENDPOINTS.UPLOAD}`;
      xhr.open('POST', url);

      // Mirror the auth headers used by _post()
      xhr.setRequestHeader('X-Api-Key', this._apiKey!);
      if (this._sessionId) xhr.setRequestHeader('X-Session-Id', this._sessionId);
      if (this._deviceId) xhr.setRequestHeader('X-Device-Id', this._deviceId);
      for (const [name, value] of Object.entries(this._identityHeaders())) xhr.setRequestHeader(name, value);
      if (this._userSignature) xhr.setRequestHeader('X-User-Signature', this._userSignature);
      if (this._appPackageName) xhr.setRequestHeader('Referer', this._appPackageName);

      // Throttle progress events by rounded percentage to reduce bridge traffic
      if (params.onProgress) {
        let lastReported = -1;
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const pct = Math.min(100, Math.max(0, Math.round((e.loaded / e.total) * 100)));
          if (pct !== lastReported) {
            lastReported = pct;
            params.onProgress!(pct);
          }
        };
      }

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText) as UploadFileResponse;
            resolve(data);
          } catch {
            reject(new Error('[Encatch] Failed to parse upload response'));
          }
        } else {
          let message = `Upload failed (${xhr.status})`;
          try {
            const errData = JSON.parse(xhr.responseText) as Record<string, unknown>;
            if (typeof errData.message === 'string' && errData.message) {
              message = errData.message;
            } else if (typeof errData.error === 'string' && errData.error) {
              message = errData.error;
            }
          } catch {
            // ignore parse failure; use default message
          }
          reject(new Error(message));
        }
      };

      xhr.onerror = () => {
        reject(new Error('[Encatch] Network error during file upload'));
      };

      xhr.ontimeout = () => {
        reject(new Error('[Encatch] File upload timed out'));
      };

      xhr.send(form);
    });
  }

  // ============================================================================
  // clearAll — full consent withdrawal
  // ============================================================================

  /**
   * Performs a full consent withdrawal: stops all background activity, dismisses
   * any open form, wipes every Encatch key from AsyncStorage, and resets all
   * in-memory state to its initial values.
   *
   * After calling clearAll() the SDK must be re-initialized (init()) before any
   * further use.  Equivalent to uninstalling and reinstalling the host app from an
   * SDK data perspective.
   *
   * Automatic tracking (the background ping and EncatchProvider's screen tracking)
   * stays off after that init() too, until the app calls startSession() or an
   * identifyUser() succeeds. The app's own calls (trackScreen, trackEvent,
   * showForm) work as soon as init() has run.
   */
  async clearAll(): Promise<void> {
    // Stop background activity
    this._stopPingInterval();
    stopAppStateListener();
    clearPauses();
    this._clearDedupe();

    // Dismiss any open form
    _internalEmitter.emit('dismissForm', {});
    this._markFormClosed();
    this._cancelPendingAutoShow();

    // Release anything waiting for a survey to close, and drop waiting
    // setUserProperties updates (they were for the user being cleared).
    this._lifecycleGen += 1;
    this._clearAllGen += 1;
    this._checkSurveyIdle(true);
    this._userPropsWaiting = [];
    this._userPropsBusy = false;

    // Wipe every @encatch/ key from AsyncStorage in a single batch (and the
    // in-memory user data used with persistUserAcrossRestarts false)
    clearMemoryUserData();
    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const encatchKeys = allKeys.filter((k) => k.startsWith('@encatch/'));
      if (encatchKeys.length > 0) {
        await AsyncStorage.multiRemove(encatchKeys);
      }
    } catch {
      // Best-effort — continue resetting in-memory state even if storage wipe fails
    }

    // Reset all in-memory state
    this._initialized = false;
    this._apiKey = null;
    this._userName = null;
    this._userId = null;
    this._userSignature = null;
    this._userSignatureTime = null;
    this._signatureExpired = false;
    this._expiryNotifiedFor.clear();
    this._heldSubmits = [];
    this._formShownFor.clear();
    this._onRequest = undefined;
    this._onResponse = undefined;
    this._signatureExpiredHook = undefined;
    this._feedbackTransactions = null;
    this._deviceId = null;
    this._sessionId = null;
    this._locale = null;
    this._country = null;
    this._theme = 'system';
    this._currentScreen = null;
    this._pendingResponses = {};
    this._isSessionPaused = false;
    this._isSessionStopped = false;
    this._isPingActive = false;
    this._identityConfirmed = false;
    this._confirmedName = null;
    // Consent withdrawal: automatic tracking stays off after the next init() too,
    // until startSession() or a successful identify.
    this._visitorQuiet = true;
    this._sessionRequested = false;

    // Notify any listeners that the user identity has been fully cleared
    _internalEmitter.emit('userIdentified', { userName: null, userId: null });
  }

  // ============================================================================
  // Session management
  // ============================================================================

  async startSession(options?: StartSessionOptions): Promise<void> {
    if (!this._initialized) return;

    // Clear stopped/paused state — startSession is the explicit re-enable after stopSession()
    this._isSessionStopped = false;
    this._isSessionPaused = false;
    this._visitorQuiet = false;
    this._sessionRequested = true;
    clearSessionStopped().catch(() => {});

    // Skip session tracking entirely in fullscreen mode (matches web SDK)
    if (this._isFullScreen) {
      this._logger.debug('Skipping session tracking - fullscreen mode');
      return;
    }

    // Refresh session ID
    this._sessionId = await getOrCreateSessionId();

    // Always start the 30s ping interval
    this._startPingInterval();

    if (!options?.skipImmediatePing) {
      this._doPing().catch(() => {});
    }

    if (!options?.skipImmediateTrackScreen && this._currentScreen) {
      this.trackScreen(this._currentScreen).catch(() => {});
    }
  }

  /**
   * Temporarily stops the automatic background ping without affecting open forms,
   * screen tracking, or user identity. Reversed by resumeSession().
   * Not persisted — clears automatically when the app process restarts.
   */
  pauseSession(): void {
    if (this._isSessionPaused) return;
    this._isSessionPaused = true;
    this._stopPingInterval();
  }

  /**
   * Restarts the background ping interval after a pauseSession() call.
   * No-op if the session was not paused.
   */
  resumeSession(): void {
    if (!this._isSessionPaused) return;
    this._isSessionPaused = false;
    this._startPingInterval();
  }

  /**
   * Stops what the SDK does on its own: the background ping and EncatchProvider's
   * automatic screen tracking. Closes an open survey and cancels a pending automatic
   * one. Saved, so it stays in effect across app restarts until startSession() or a
   * successful identifyUser(). While stopped, the app's own calls (trackScreen,
   * trackEvent, identifyUser, showForm, submits) still go out, and a survey the
   * server picks in a reply still shows. User identity is kept.
   */
  async stopSession(): Promise<void> {
    if (this._isSessionStopped) return;
    this._isSessionStopped = true;
    // The next identify turns the session back on, so it must go out even if it matches.
    this._clearIdentifyMemory();
    this._isSessionPaused = false;
    this._stopPingInterval();
    _internalEmitter.emit('dismissForm', {});
    this._markFormClosed();
    this._cancelPendingAutoShow();
    await setSessionStopped();
  }

  private async _loadStoredSignature(userName: string): Promise<void> {
    const stored = await getUserSignature(userName);
    this._userSignature = stored?.signature ?? null;
    this._userSignatureTime = stored?.time ?? null;
  }

  /**
   * A 401: did the current user's signature expire? The gateway says so with
   * `"reason":"user_signature_expired"` (since 2026-11-27; it checks the signature
   * on identify-user, and SV8 would extend that to every request). Any other 401
   * (inactive key, wrong referer, wrong signature) is not an expiry, except on
   * older gateways, which give no reason: there a 401 on the identify that carried
   * the stored session-time signature (setUserProperties) is taken as the expiry.
   *
   * - A reply for a user who has since been reset or switched away from is ignored.
   * - The app's own new signature (identifyUser with `secure`) rejected as expired:
   *   the app is told (once per user until an identify succeeds), but nothing else
   *   changes. That identify simply failed, as any rejected identify does; the
   *   stored signature and tracking are kept.
   * - The stored signature (setUserProperties, an identify that re-sent it, or any
   *   request under SV8): only if it is still the one in use (a late reply for an
   *   older one doesn't count). Enters the expired state and tells the app.
   */
  private _checkSignatureExpiry(
    responseText: string,
    headers: Record<string, string>,
    opts?: { identifyUserName?: string; storedSignature?: boolean }
  ): void {
    const user = opts?.identifyUserName ?? headers['X-User-Name'];
    if (!user || user !== this._userName) return;
    const expiredReason = errorReasonOf(responseText) === 'user_signature_expired';
    const signature = headers['X-User-Signature'];
    // A new identify that re-sent the stored signature counts as the stored one.
    const isStored = !!signature && signature === this._userSignature;
    if (opts?.identifyUserName && !opts.storedSignature && !(isStored && expiredReason)) {
      if (!expiredReason) return;
      console.warn(
        `[Encatch] identifyUser("${user}") rejected: the secure signature has expired. Get a fresh signature and call identifyUser() again.`
      );
      if (this._expiryNotifiedFor.has(user)) return;
      this._expiryNotifiedFor.add(user);
      this._notifySignatureExpired(user);
      return;
    }
    if (!isStored) return;
    if (expiredReason || (opts?.storedSignature && headers['X-User-Session-Time'])) this._onSignatureExpired();
  }

  /**
   * Calls onSignatureExpired for `user`, in a microtask: after the SDK has
   * updated its state for this reply (the expired state, the stored signature).
   * Skipped if the user changed or clearAll() / stop() ran meanwhile.
   */
  private _notifySignatureExpired(user: string): void {
    const hook = this._signatureExpiredHook;
    if (!hook) return;
    const gen = this._lifecycleGen;
    void Promise.resolve().then(() => {
      if (gen !== this._lifecycleGen || this._userName !== user) return;
      this._callHook(hook, { userName: user });
    });
  }

  /** The current user's signature expired: warn once, tell the app, and wait for a new identify. */
  private _onSignatureExpired(): void {
    if (this._signatureExpired) return;
    this._signatureExpired = true;
    // The next identify (with a fresh signature) must go out, even if it matches.
    this._clearIdentifyMemory();
    console.warn(
      '[Encatch] Secure identify signature expired (401). Call identifyUser() with a fresh signature; ' +
        'until then events, screens, ping and automatic surveys are skipped and survey submits are held.'
    );
    const user = this._userName;
    this._userSignature = null;
    this._userSignatureTime = null;
    if (user) {
      clearUserSignature(user).catch(() => {});
      // Always told on entering the state; a new signature then rejected again isn't told twice.
      this._expiryNotifiedFor.add(user);
      this._notifySignatureExpired(user);
    }
  }

  /** Calls a debug hook; a hook that throws or rejects can't affect the SDK. */
  private _callHook<I>(hook: ((info: I) => void) | undefined, info: I): void {
    if (!hook) return;
    try {
      const result: unknown = hook(info);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(undefined, () => {});
      }
    } catch {
      /* ignore hook errors */
    }
  }

  /** Reports a call the SDK skipped without sending it (onResponse, outcome "skipped"). */
  private _reportSkipped(endpoint: string, reason: NonNullable<EncatchResponseInfo['reason']>): void {
    this._callHook(this._onResponse, {
      endpoint,
      attempt: 1,
      status: 0,
      durationMs: 0,
      outcome: 'skipped',
      rateLimited: reason === 'rate-limited',
      reason,
    });
  }

  /** Keeps a submit until the next successful identify (in memory, at most 10). */
  private _holdSubmit(params: SubmitFormRequest, user: string | null): void {
    this._reportSkipped('submit-form', 'signature-expired');
    this._heldSubmits.push({ params, user });
    if (this._heldSubmits.length > MAX_HELD_SUBMITS) this._heldSubmits.shift();
    this._logger.debug('submitForm held until the next identify (secure signature expired)');
  }

  /** A successful identify ends the expired state and sends any held submits. */
  private _endSignatureExpired(): void {
    if (!this._signatureExpired && this._heldSubmits.length === 0) return;
    this._signatureExpired = false;
    const held = this._heldSubmits.splice(0);
    for (const { params, user } of held) this._submitFormFor(params, user).catch(() => {});
  }

  /** Forgets the identifyUser() dedupe memory. */
  private _clearIdentifyMemory(): void {
    this._identifiedName = null;
    this._lastTraitsKey = null;
    this._lastOptionsKey = null;
    this._lastIdentifyLocale = null;
    this._lastIdentifyCountry = null;
    this._identifyMemoryToken = null;
    this._traitsMemoryToken = null;
  }

  /** Runs identify / reset operations one after the other, in call order. */
  private _identityChain: Promise<unknown> = Promise.resolve();
  private _runIdentityOp<T>(op: () => Promise<T>): Promise<T> {
    const run = this._identityChain.then(op, op);
    this._identityChain = run.catch(() => {});
    return run;
  }

  /** Forgets the last identify and recent event/screen calls (new user or full reset). */
  private _clearDedupe(): void {
    this._clearIdentifyMemory();
    this._lastEventAt.clear();
    this._lastScreen = null;
  }

  async resetUser(): Promise<void> {
    // With autoStartVisitorSession false, go quiet now: apps navigate to their
    // sign-in screen straight after calling this, before the reset has finished,
    // and that automatic screen must not go out as a visitor.
    if (!this._autoStartVisitorSession) this._visitorQuiet = true;
    return this._runIdentityOp(() => this._resetNow());
  }

  private async _resetNow(): Promise<void> {
    this._clearDedupe();
    // Clear the in-memory identity first, so nothing is sent with a half-cleared one.
    const previous = this._userName;
    this._userName = null;
    this._userId = null;
    this._userSignature = null;
    this._userSignatureTime = null;
    this._signatureExpired = false;
    this._expiryNotifiedFor.clear();
    if (this._heldSubmits.length > 0) {
      console.warn(`[Encatch] ${this._heldSubmits.length} held survey submit(s) dropped: the user was reset`);
      this._heldSubmits = [];
    }
    this._feedbackTransactions = null;
    this._locale = null;
    this._country = null;

    if (previous) {
      await Promise.all([clearUserId(previous), clearFeedbackTransactions(previous), clearUserSignature(previous)]);
    }
    await clearFeedbackTransactions('anonymous');
    await clearUserName();
    await clearSession();
    await clearPreferences();

    this._sessionId = await getOrCreateSessionId();

    // Reset session control flags (a saved stopSession() too, like the web SDK)
    this._isSessionPaused = false;
    this._isSessionStopped = false;
    await clearSessionStopped();

    this._identityConfirmed = false;
    this._confirmedName = null;
    // Sign-out with autoStartVisitorSession false: the app goes quiet again (no
    // ping, no automatic screens). Otherwise the session carries on as a visitor:
    // the ping keeps running like automatic screens do (as in the web SDK), on the
    // regular interval with no extra ping now; a session that never ran (or
    // full-screen mode) isn't started.
    this._visitorQuiet = !this._autoStartVisitorSession;
    if (!this._visitorQuiet && this._sessionRequested && !this._isFullScreen) {
      this._startPingInterval();
    } else {
      this._stopPingInterval();
    }

    // Notify listeners that the user identity has been cleared
    _internalEmitter.emit('userIdentified', { userName: null, userId: null });
  }

  // ============================================================================
  // Ping mechanism (mirrors web SDK)
  // ============================================================================

  private _startPingInterval(): void {
    this._stopPingInterval();
    this._isPingActive = true;

    this._pingIntervalId = setInterval(() => {
      if (this._isFormVisible) return;
      this._doPing().catch(() => {});
    }, this._pingIntervalMs);
  }

  private _stopPingInterval(): void {
    this._isPingActive = false;
    this._clearPingTimers();
  }

  private _clearPingTimers(): void {
    if (this._pingIntervalId) {
      clearInterval(this._pingIntervalId);
      this._pingIntervalId = null;
    }
    if (this._pingTimeoutId) {
      clearTimeout(this._pingTimeoutId);
      this._pingTimeoutId = null;
    }
  }

  /**
   * The server asked for the next ping in `delayMs` (pingAgainIn). Pinging stays
   * active while waiting, so every reply's pingAgainIn is honoured, including the
   * scheduled ping's own reply. (Previously the wait marked pinging inactive, so
   * that reply was ignored and the SDK fell back to 30 s: 0, 120, 150, 270, 300…)
   */
  private _scheduleNextPing(delayMs: number): void {
    this._clearPingTimers();
    const timeoutId = setTimeout(async () => {
      if (this._pingTimeoutId === timeoutId) this._pingTimeoutId = null;
      if (!this._isFormVisible) {
        try {
          await this._doPing();
        } catch {
          /* ignore */
        }
      }
      // Back to the regular interval, unless the reply already scheduled the next
      // ping, or pinging was stopped (stopSession / pauseSession) in the meantime.
      if (this._isPingActive && !this._pingTimeoutId && !this._pingIntervalId) this._startPingInterval();
    }, delayMs);
    this._pingTimeoutId = timeoutId;
  }

  private async _doPing(): Promise<void> {
    // A ping already scheduled when the app went quiet (resetUser with
    // autoStartVisitorSession false) must not go out as a visitor.
    if (this._visitorQuiet) {
      this._reportSkipped('ping', 'visitor');
      return;
    }
    if (isPaused('tracking')) {
      this._reportSkipped('ping', 'rate-limited');
      return;
    }
    if (this._signatureExpired) {
      this._reportSkipped('ping', 'signature-expired');
      return;
    }
    const deviceInfo = await this._buildDeviceInfo(this._currentScreen ?? undefined);
    const req: PingRequest = {
      $deviceInfo: deviceInfo,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    const res = await this._post<PingResponse>(ENDPOINTS.PING, req);
    if (res.$feedbackTransactions) {
      this._feedbackTransactions = res.$feedbackTransactions;
      const key = this._userName ?? 'anonymous';
      await setFeedbackTransactions(key, res.$feedbackTransactions);
    }
    this._handleResponseMeta(res);
    this._handleSurveyInReply(res);
  }

  // ============================================================================
  // Form visibility state (used by EncatchWebView)
  // ============================================================================

  setFormVisible(visible: boolean): void {
    if (visible) this._isFormVisible = true;
    else this._markFormClosed();
  }

  // ============================================================================
  // API response meta handler
  // ============================================================================

  private _handleResponseMeta(res: { pingAgainIn?: number; pingOnNextPageVisit?: boolean }): void {
    if (typeof res.pingAgainIn === 'number' && res.pingAgainIn > 0 && this._isPingActive) {
      this._scheduleNextPing(res.pingAgainIn * 1000);
    }
    // Stop the ping interval when the server signals it should not resume on next page visit
    if (res.pingOnNextPageVisit === false) {
      this._stopPingInterval();
    }
  }

  // ============================================================================
  // SDK events (external callbacks)
  // ============================================================================

  on(callback: EventCallback): () => void {
    this._eventCallbacks.push(callback);
    return () => this.off(callback);
  }

  off(callback: EventCallback): void {
    const idx = this._eventCallbacks.indexOf(callback);
    if (idx !== -1) this._eventCallbacks.splice(idx, 1);
  }

  emitEvent(eventType: EventType, payload: Omit<EventPayload, 'timestamp'>): void {
    const full: EventPayload = { ...payload, timestamp: Date.now() };
    for (const cb of this._eventCallbacks) {
      try {
        cb(eventType, full);
      } catch {
        /* ignore callback errors */
      }
    }
  }

  // ============================================================================
  // Device info builder
  // ============================================================================

  private async _buildDeviceInfo(screenName?: string): Promise<ApiDeviceInfo> {
    const locale = await getDeviceLocale();
    const osVersion = getOsVersion();
    const platform = getPlatform();
    const timezone = getTimezone();
    const deviceType = getDeviceTypeEnv();
    const deviceSize = deviceType === 'web' ? getDeviceSize() : undefined;

    return {
      $deviceOs: platform,
      $deviceVersion: osVersion,
      $deviceOsVersion: osVersion,
      $deviceType: deviceType,
      $deviceSize: deviceSize,
      $sdkVersion: SDK_VERSION,
      $appVersion: this._appVersion,
      $app: this._appPackageName ?? undefined,
      $deviceLanguage: locale,
      $userLanguage: this._locale ?? locale,
      $countryCode: this._country ?? undefined,
      $preferredTheme: this._theme,
      $timezone: timezone ?? undefined,
      $urlOrScreenName: screenName ?? this._currentScreen ?? undefined,
    };
  }

  // ============================================================================
  // HTTP client (plain fetch, no external dependency)
  // ============================================================================

  /**
   * Builds the auth headers used by _post() and raw fetch calls (e.g. streamQnaWithAi).
   * Does not include Content-Type so callers can set it (or omit it for multipart/form-data).
   */
  /**
   * X-User-Name / X-User-Id. The core API rejects one without the other (401),
   * so they go out both or neither; without an id the request is sent as a
   * visitor. identify-user sends only its own user name, never an id: the
   * gateway's secure-identify check needs the name, and the core API reads the
   * identity from the body.
   */
  private _identityHeaders(identifyUserName?: string): Record<string, string> {
    if (identifyUserName != null) return { 'X-User-Name': identifyUserName };
    if (!(this._userName && this._userId)) return {};
    const headers: Record<string, string> = { 'X-User-Name': this._userName, 'X-User-Id': this._userId };
    // After a successful secure identify, the signature (and its time) go on every request.
    if (this._userSignature) {
      headers['X-User-Signature'] = this._userSignature;
      if (this._userSignatureTime) {
        headers['X-User-Session-Time'] = this._userSignatureTime;
        headers['X-User-Signature-Time'] = this._userSignatureTime;
      }
    }
    return headers;
  }

  private _buildHeaders(extra?: {
    signature?: string;
    signatureTime?: string;
    identifyUserName?: string;
  }): Record<string, string> {
    if (!this._apiKey) throw new Error('[Encatch] SDK not initialized');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': this._apiKey,
    };

    if (this._sessionId) headers['X-Session-Id'] = this._sessionId;
    Object.assign(headers, this._identityHeaders(extra?.identifyUserName));
    if (this._deviceId) headers['X-Device-Id'] = this._deviceId;
    // Secure identify. The gateway checks the signature on identify-user only,
    // reading X-User-Signature and, for keys with a session time,
    // X-User-Session-Time (the exact string signed with the user name).
    // X-User-Signature-Time is kept for compatibility with earlier SDK versions.
    if (extra?.signature) headers['X-User-Signature'] = extra.signature;
    if (extra?.signatureTime) {
      headers['X-User-Session-Time'] = extra.signatureTime;
      headers['X-User-Signature-Time'] = extra.signatureTime;
    }
    if (this._appPackageName) headers['Referer'] = this._appPackageName;

    return headers;
  }

  private async _post<T>(
    endpoint: string,
    body: unknown,
    opts?: {
      signature?: string;
      signatureTime?: string;
      identifyUserName?: string;
      attempt?: number;
      /** identify-user carrying the stored signature (setUserProperties): a 401 is an expiry. */
      storedSignature?: boolean;
    }
  ): Promise<T> {
    const url = `${this._apiBaseUrl}/${endpoint}`;
    const hookInfo = { endpoint: endpointName(endpoint), attempt: opts?.attempt ?? currentQueueAttempt() ?? 1 };
    const headers = this._buildHeaders({
      signature: opts?.signature,
      signatureTime: opts?.signatureTime,
      identifyUserName: opts?.identifyUserName,
    });

    const bodyStr = JSON.stringify(body);
    if (this._debugMode) {
      const headersForLog = { ...headers };
      if (headersForLog['X-Api-Key']) headersForLog['X-Api-Key'] = '***';
      if (headersForLog['X-User-Signature']) headersForLog['X-User-Signature'] = '***';
      this._logger.debug(`POST ${endpoint} -> ${url}`);
      this._logger.debug('Request headers:\n' + JSON.stringify(headersForLog, null, 2));
      // The secure-identify signature is masked in the body too.
      const bodyForLog =
        body && typeof body === 'object' && (body as { userSignature?: unknown }).userSignature
          ? { ...(body as Record<string, unknown>), userSignature: '***' }
          : body;
      this._logger.debug('Request body:\n' + JSON.stringify(bodyForLog, null, 2));
    }
    this._callHook(this._onRequest, hookInfo);
    const startedAt = Date.now();

    // A request that never answers would hold up the retry queue (it sends one
    // request at a time), and React Native's fetch has no read timeout on
    // Android. Abort after REQUEST_TIMEOUT_MS; the queue treats it like a
    // network failure and retries with backoff.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null;
    let res: Response;
    let responseText: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: bodyStr,
        ...(controller ? { signal: controller.signal } : {}),
      });
      responseText = await res.text().catch(() => '');
    } catch (err) {
      // No response: network failure or the REQUEST_TIMEOUT_MS abort.
      this._callHook(this._onResponse, {
        ...hookInfo,
        status: 0,
        durationMs: Date.now() - startedAt,
        outcome: 'network-error',
        rateLimited: false,
      });
      throw err;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    this._callHook(this._onResponse, {
      ...hookInfo,
      status: res.status,
      durationMs: Date.now() - startedAt,
      outcome: res.ok ? 'ok' : 'error',
      rateLimited: res.status === 429,
    });
    if (this._debugMode) {
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      this._logger.debug(`POST ${endpoint} <- ${res.status}`);
      this._logger.debug('Response headers:\n' + JSON.stringify(resHeaders, null, 2));
      try {
        const resBody = JSON.parse(responseText);
        this._logger.debug('Response body:\n' + JSON.stringify(resBody, null, 2));
      } catch {
        this._logger.debug('Response body:\n' + responseText);
      }
    }

    // Check for user_pending_retry_exhausted - stop SDK and reset user
    try {
      const parsedForCheck = JSON.parse(responseText);
      // The core API sends camelCase (userPendingRetryExhausted); snake_case is
      // kept for older servers.
      if (
        parsedForCheck &&
        typeof parsedForCheck === 'object' &&
        (parsedForCheck.userPendingRetryExhausted === true || parsedForCheck.user_pending_retry_exhausted === true)
      ) {
        console.log('USER identification timeout for encatch SDK');
        this._stopPingInterval();
        this.resetUser().catch(() => {});
      }
    } catch {
      // not JSON or parse failed, ignore
    }

    if (res.status === 401) this._checkSignatureExpiry(responseText, headers, opts);

    if (!res.ok) {
      const err = new HttpError(endpoint, res.status, responseText, parseRetryAfter(res.headers.get('Retry-After')));
      if (res.status === 429) pauseFor(bucketOf(endpoint), err.retryAfterMs);
      this._logger.warn(err.message);
      throw err;
    }

    return JSON.parse(responseText) as T;
  }

  // ============================================================================
  // Getters (read-only, used by EncatchWebView / EncatchProvider)
  // ============================================================================

  get isInitialized(): boolean {
    return this._initialized;
  }

  get apiKey(): string | null {
    return this._apiKey;
  }

  get baseUrl(): string {
    return this._apiBaseUrl;
  }

  get webHost(): string {
    return this._webHost;
  }

  get isFullScreen(): boolean {
    return this._isFullScreen;
  }

  get theme(): Theme {
    return this._theme;
  }

  get locale(): string | null {
    return this._locale;
  }

  get deviceId(): string | null {
    return this._deviceId;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get userName(): string | null {
    return this._userName;
  }

  get userId(): string | null {
    return this._userId;
  }

  /**
   * True when the SDK has a confirmed identity: the user was restored from the
   * device at init, or their identifyUser() succeeded. False before init, for
   * visitors, while a new user's first identify is pending or after it failed,
   * and after resetUser() / clearAll(). During a switch to another user it stays
   * true for the previous user until the new user's identify succeeds. Same
   * answer as useEncatch().isIdentified.
   */
  isIdentified(): boolean {
    return this._initialized && this._identityConfirmed;
  }

  get debugMode(): boolean {
    return this._debugMode;
  }

  // ============================================================================
  // Teardown
  // ============================================================================

  stop(): void {
    this._stopPingInterval();
    stopAppStateListener();
    this._lifecycleGen += 1;
    this._checkSurveyIdle(true);
  }
}

// ============================================================================
// Exported singleton
// ============================================================================

export const Encatch = new EncatchSDK();
