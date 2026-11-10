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
import { HttpError, httpStatusOf, parseRetryAfter } from './http-error';
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
  private _heldSubmits: SubmitFormRequest[] = [];

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

  // App version (can be set by consumer)
  private _appVersion = '1.0.0';
  private _appPackageName: string | null = null;

  // Event callbacks (external SDK consumers via Encatch.on())
  private _eventCallbacks: EventCallback[] = [];

  // Dedupe: the last identify sent or in flight, and recent event / screen calls.
  private _lastIdentifyKey: string | null = null;
  private _lastEventAt = new Map<string, number>();
  private _lastScreen: { name: string; at: number } | null = null;

  // Interceptor (optional — called before showing any form)
  private _onBeforeShowForm: EncatchConfig['onBeforeShowForm'] = undefined;

  // Optional debug hooks (never given the API key, headers, signature or bodies).
  private _onRequest: EncatchConfig['onRequest'] = undefined;
  private _onResponse: EncatchConfig['onResponse'] = undefined;

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

    this._logger.debug('Initializing SDK...');

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
    // Skip a call identical to the last identify sent or still in flight. The
    // key is cleared if that identify is dropped, and on resetUser / clearAll.
    const identifyKey = stableKey({
      userName,
      traits: traits ?? null,
      locale: options?.locale ?? null,
      country: options?.country ?? null,
      signature: options?.secure?.signature ?? null,
      signatureTime: options?.secure?.generatedDateTimeinUTC ?? null,
    });
    if (identifyKey === this._lastIdentifyKey) {
      this._logger.debug(`identifyUser "${userName}" skipped: same as the last identify`);
      this._reportSkipped('identify-user', 'duplicate');
      return;
    }
    this._lastIdentifyKey = identifyKey;

    // Switching user: take this user's stored id (or none) together with the
    // name, so a request never pairs this name with another user's id. With no
    // stored id, requests go out as a visitor until the identify reply arrives
    // (the server rejects a name without its id).
    if (userName !== this._userName) {
      const storedId = await getUserId(userName);
      this._userName = userName;
      this._userId = storedId;
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
    const convertDates = (obj: Record<string, any> | undefined): Record<string, any> | undefined => {
      if (!obj) return undefined;
      return Object.keys(obj).reduce<Record<string, any>>((acc, k) => {
        acc[k] = obj[k] instanceof Date ? (obj[k] as Date).toISOString() : obj[k];
        return acc;
      }, {});
    };
    const userAttributes: UserTraits | undefined = traits
      ? {
          ...traits,
          $set: convertDates(traits.$set),
          $setOnce: convertDates(traits.$setOnce),
        }
      : undefined;

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

    enqueue('identifyUser', async () => {
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
      this._endSignatureExpired();
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        await setFeedbackTransactions(userName, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);

      // Notify listeners that the user is now fully identified (userName + userId)
      _internalEmitter.emit('userIdentified', {
        userName: this._userName,
        userId: this._userId,
      });

      // Start session after successful identify — ping interval runs but no
      // immediate ping or trackScreen fires (matches web SDK behaviour exactly)
      await this.startSession({ skipImmediatePing: true, skipImmediateTrackScreen: true });

      // Apply pingAgainIn from identify response after session is started
      if (typeof res.pingAgainIn === 'number' && res.pingAgainIn > 0) {
        this._scheduleNextPing(res.pingAgainIn * 1000);
      }

      // Survey the server picked for this user
      this._handleSurveyInReply(res);
    }, undefined, () => {
      // Dropped without succeeding: allow the same identify to be sent again.
      if (this._lastIdentifyKey === identifyKey) this._lastIdentifyKey = null;
    });

    // Immediately flush so identify is best-effort real-time
    flush().catch(() => {});
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
      const res = await this._post<ShowFormResponse>(ENDPOINTS.SHOW_FORM, req);

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
    this._openFormIds = [];
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
   * form views). For an identified user this is a dismissal: the form:dismissed
   * survey event, the dismiss-form request and the app's form:dismissed event.
   * Visitors get nothing, not even the local event. The view closes itself.
   */
  private async _onClosedBeforeSubmit(formConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;
    if (!(this._userName && this._userId)) {
      this._logger.debug('survey closed before submit: not a recorded dismissal for a visitor');
      return;
    }
    this._trackFormEvent('form:dismissed', formConfigurationId).catch(() => {});
    await this._sendDismiss(formConfigurationId);
    this.emitEvent('form:dismissed', { formId: formConfigurationId ?? '' });
  }

  private readonly _closedBeforeSubmitListener = (p: { formConfigurationId?: string }) => {
    this._onClosedBeforeSubmit(p.formConfigurationId).catch(() => {});
  };

  /** EncatchProvider starts the session at launch, unless a stopSession() is in effect. */
  private readonly _startSessionOnLaunchListener = () => {
    if (this._isSessionStopped) {
      this._logger.debug('session not started at launch: stopSession() is in effect until startSession() or identifyUser()');
      return;
    }
    this.startSession().catch(() => {});
  };

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
    this.trackScreen(p.screenName).catch(() => {});
  };

  /** POST dismiss-form (best effort). */
  private async _sendDismiss(formConfigurationId?: string): Promise<void> {
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
    if (!this._initialized) return;
    // Secure signature expired: hold the answers until the app identifies again.
    if (this._signatureExpired) {
      this._holdSubmit(params);
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
          this._holdSubmit(params);
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

    // Wipe every @encatch/ key from AsyncStorage in a single batch
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
    this._heldSubmits = [];
    this._onRequest = undefined;
    this._onResponse = undefined;
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

  /** The stored session-time signature expired: warn once and wait for a new identify. */
  private _onSignatureExpired(): void {
    if (this._signatureExpired) return;
    this._signatureExpired = true;
    console.warn(
      '[Encatch] Secure identify signature expired (401). Call identifyUser() with a fresh signature; ' +
        'until then events, screens, ping and automatic surveys are skipped and survey submits are held.'
    );
    const user = this._userName;
    this._userSignature = null;
    this._userSignatureTime = null;
    if (user) clearUserSignature(user).catch(() => {});
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
  private _holdSubmit(params: SubmitFormRequest): void {
    this._reportSkipped('submit-form', 'signature-expired');
    this._heldSubmits.push(params);
    if (this._heldSubmits.length > MAX_HELD_SUBMITS) this._heldSubmits.shift();
    this._logger.debug('submitForm held until the next identify (secure signature expired)');
  }

  /** A successful identify ends the expired state and sends any held submits. */
  private _endSignatureExpired(): void {
    if (!this._signatureExpired && this._heldSubmits.length === 0) return;
    this._signatureExpired = false;
    const held = this._heldSubmits.splice(0);
    for (const params of held) this.submitForm(params).catch(() => {});
  }

  /** Runs identify / reset operations one after the other, in call order. */
  private _identityChain: Promise<unknown> = Promise.resolve();
  private _runIdentityOp(op: () => Promise<void>): Promise<void> {
    const run = this._identityChain.then(op, op);
    this._identityChain = run.catch(() => {});
    return run;
  }

  /** Forgets the last identify and recent event/screen calls (new user or full reset). */
  private _clearDedupe(): void {
    this._lastIdentifyKey = null;
    this._lastEventAt.clear();
    this._lastScreen = null;
  }

  async resetUser(): Promise<void> {
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

    this._stopPingInterval();

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
    opts?: { signature?: string; signatureTime?: string; identifyUserName?: string; attempt?: number }
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

    // A 401 on a request that carried the stored session-time signature: it has
    // expired (the session time is meant to cover an app session).
    if (res.status === 401 && !opts?.identifyUserName && headers['X-User-Signature'] && headers['X-User-Session-Time']) {
      this._onSignatureExpired();
    }

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

  get debugMode(): boolean {
    return this._debugMode;
  }

  // ============================================================================
  // Teardown
  // ============================================================================

  stop(): void {
    this._stopPingInterval();
    stopAppStateListener();
  }
}

// ============================================================================
// Exported singleton
// ============================================================================

export const Encatch = new EncatchSDK();
