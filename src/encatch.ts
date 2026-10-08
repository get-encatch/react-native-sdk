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
import { enqueue, flush, startAppStateListener, stopAppStateListener } from './retry-queue';
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
  QnaWithAiRequest,
  UploadFileRequest,
  UploadFileResponse,
} from './types';

// ============================================================================
// SDK version (kept in sync with package.json by the build process)
// ============================================================================

const SDK_VERSION = '2.0.0';

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

  // Session control state
  private _isSessionPaused = false;
  private _isSessionStopped = false;

  // App version (can be set by consumer)
  private _appVersion = '1.0.0';
  private _appPackageName: string | null = null;

  // Event callbacks (external SDK consumers via Encatch.on())
  private _eventCallbacks: EventCallback[] = [];

  // Interceptor (optional — called before showing any form)
  private _onBeforeShowForm: EncatchConfig['onBeforeShowForm'] = undefined;

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

    // Restore locale / country from previous session (matches web SDK hydration)
    if (prefs.locale != null) this._locale = prefs.locale;
    if (prefs.country != null) this._country = prefs.country;

    if (storedName) {
      this._userName = storedName;
      this._userId = await getUserId(storedName);
      this._feedbackTransactions = await getFeedbackTransactions(storedName);
    } else {
      this._feedbackTransactions = await getFeedbackTransactions('anonymous');
    }

    this._initialized = true;

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

    this._userName = userName;
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
      userSignature: options?.secure?.signature ?? this._userSignature ?? undefined,
      $deviceInfo: deviceInfo,
      userAttributes,
      $feedbackTransactions: this._feedbackTransactions ?? undefined,
    };

    enqueue('identifyUser', async () => {
      const res = await this._post<IdentifyUserResponse>(ENDPOINTS.IDENTIFY_USER, req, {
        signatureTime: options?.secure?.generatedDateTimeinUTC,
      });
      // Persist server-issued userId
      if (res.userId) {
        this._userId = res.userId;
        await setUserId(userName, res.userId);
      }
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

      // Auto show form if server requested it
      if (res.formConfigurationId) {
        this._showFormById(res.formConfigurationId, { triggerType: 'automatic' });
      }
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
      if (res.formConfigurationId) {
        this._showFormById(res.formConfigurationId, { triggerType: 'automatic' });
      }
    });

    flush().catch(() => {});
  }

  /**
   * Best-effort server call for form lifecycle events (form:show, form:started, etc.).
   * Not enqueued — matches web SDK behaviour where form events are fire-and-forget.
   */
  async _trackFormEvent(eventName: string, feedbackConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;
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
      if (res.formConfigurationId) {
        this._showFormById(res.formConfigurationId, { triggerType: 'automatic' });
      }
    } catch {
      /* best effort — do not throw */
    }
  }

  async trackScreen(screenName: string): Promise<void> {
    if (!this._initialized) return;
    // Skip tracking in fullscreen mode (matches web SDK)
    if (this._isFullScreen) return;

    this._currentScreen = screenName;

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
      if (res.formConfigurationId) {
        this._showFormById(res.formConfigurationId, { triggerType: 'automatic' });
      }
      if (res.nextFeedbackId) {
        const delay = typeof res.onPageDelay === 'number' ? res.onPageDelay : 0;
        setTimeout(() => {
          this._showFormById(res.nextFeedbackId!, { triggerType: 'automatic', reset: 'always' });
        }, delay * 1000);
      }
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
    cancelPendingCompletionCta(formId);
    const resetMode = options?.reset ?? 'always';
    const triggerType = options?.triggerType ?? 'manual';

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

  async dismissForm(formConfigurationId?: string): Promise<void> {
    if (!this._initialized) return;

    cancelPendingCompletionCta(formConfigurationId);

    _internalEmitter.emit('dismissForm', { formConfigurationId });
    this._isFormVisible = false;

    this._trackFormEvent('form:dismissed', formConfigurationId).catch(() => {});

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

    this.emitEvent('form:dismissed', { formId: formConfigurationId ?? '' });
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

    const deviceInfo = await this._buildDeviceInfo();
    const req: SubmitFormRequest = {
      ...params,
      $deviceInfo: deviceInfo as Record<string, unknown>,
    };

    try {
      const res = await this._post<SubmitFormResponse>(ENDPOINTS.SUBMIT_FORM, req);
      if (res.$feedbackTransactions) {
        this._feedbackTransactions = res.$feedbackTransactions;
        const key = this._userName ?? 'anonymous';
        await setFeedbackTransactions(key, res.$feedbackTransactions);
      }
      this._handleResponseMeta(res);
    } catch (err) {
      this._logger.warn('submitForm API error:', err);
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
      if (this._userName) xhr.setRequestHeader('X-User-Name', this._userName);
      if (this._userId) xhr.setRequestHeader('X-User-Id', this._userId);
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

    // Dismiss any open form
    _internalEmitter.emit('dismissForm', {});
    this._isFormVisible = false;

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
   * Fully suspends all SDK activity — stops the background ping and closes any
   * open forms. User identity is preserved; no re-identification needed.
   * Persists across app restarts via AsyncStorage. Re-enable with startSession().
   */
  async stopSession(): Promise<void> {
    if (this._isSessionStopped) return;
    this._isSessionStopped = true;
    this._isSessionPaused = false;
    this._stopPingInterval();
    _internalEmitter.emit('dismissForm', {});
    this._isFormVisible = false;
    await setSessionStopped();
  }

  async resetUser(): Promise<void> {
    if (this._userName) {
      await Promise.all([
        clearUserId(this._userName),
        clearFeedbackTransactions(this._userName),
      ]);
    }
    await clearFeedbackTransactions('anonymous');
    await clearUserName();
    await clearSession();
    await clearPreferences();

    this._userName = null;
    this._userId = null;
    this._userSignature = null;
    this._feedbackTransactions = null;
    this._locale = null;
    this._country = null;
    this._sessionId = await getOrCreateSessionId();

    // Reset session control flags
    this._isSessionPaused = false;
    this._isSessionStopped = false;

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
    if (this._pingIntervalId) {
      clearInterval(this._pingIntervalId);
      this._pingIntervalId = null;
    }
    if (this._pingTimeoutId) {
      clearTimeout(this._pingTimeoutId);
      this._pingTimeoutId = null;
    }
  }

  private _scheduleNextPing(delayMs: number): void {
    this._stopPingInterval();
    this._pingTimeoutId = setTimeout(async () => {
      if (!this._isFormVisible) {
        try {
          await this._doPing();
        } catch {
          /* ignore */
        }
      }
      this._startPingInterval();
    }, delayMs);
  }

  private async _doPing(): Promise<void> {
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
    if (res.formConfigurationId) {
      this._showFormById(res.formConfigurationId, { triggerType: 'automatic' });
    }
  }

  // ============================================================================
  // Form visibility state (used by EncatchWebView)
  // ============================================================================

  setFormVisible(visible: boolean): void {
    this._isFormVisible = visible;
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
  private _buildHeaders(extra?: { signatureTime?: string }): Record<string, string> {
    if (!this._apiKey) throw new Error('[Encatch] SDK not initialized');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Api-Key': this._apiKey,
    };

    if (this._sessionId) headers['X-Session-Id'] = this._sessionId;
    if (this._userName) headers['X-User-Name'] = this._userName;
    if (this._userId) headers['X-User-Id'] = this._userId;
    if (this._userSignature) headers['X-User-Signature'] = this._userSignature;
    if (this._deviceId) headers['X-Device-Id'] = this._deviceId;
    if (extra?.signatureTime) headers['X-User-Signature-Time'] = extra.signatureTime;
    if (this._appPackageName) headers['Referer'] = this._appPackageName;

    return headers;
  }

  private async _post<T>(
    endpoint: string,
    body: unknown,
    opts?: { signatureTime?: string }
  ): Promise<T> {
    const url = `${this._apiBaseUrl}/${endpoint}`;
    const headers = this._buildHeaders({ signatureTime: opts?.signatureTime });

    const bodyStr = JSON.stringify(body);
    if (this._debugMode) {
      const headersForLog = { ...headers };
      if (headersForLog['X-Api-Key']) headersForLog['X-Api-Key'] = '***';
      this._logger.debug(`POST ${endpoint} -> ${url}`);
      this._logger.debug('Request headers:\n' + JSON.stringify(headersForLog, null, 2));
      this._logger.debug('Request body:\n' + JSON.stringify(body, null, 2));
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: bodyStr,
    });

    const responseText = await res.text().catch(() => '');
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
      if (parsedForCheck && typeof parsedForCheck === 'object' && parsedForCheck.user_pending_retry_exhausted === true) {
        console.log('USER identification timeout for encatch SDK');
        this._stopPingInterval();
        this.resetUser().catch(() => {});
      }
    } catch {
      // not JSON or parse failed, ignore
    }

    if (!res.ok) {
      const errMsg = `[Encatch API] ${endpoint} failed with status ${res.status}: ${responseText}`;
      this._logger.warn(errMsg);
      throw new Error(errMsg);
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
