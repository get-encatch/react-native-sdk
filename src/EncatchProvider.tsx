/**
 * EncatchProvider
 *
 * React context provider that:
 *  1. Calls Encatch.init() on mount (safe to call multiple times)
 *  2. Auto-tracks screen changes via Expo Router or React Navigation
 *  3. Exposes useEncatch() hook with the full SDK API surface
 *
 * Usage:
 *   <EncatchProvider apiKey="..." navigationType="expo-router">
 *     <App />
 *   </EncatchProvider>
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Encatch, _internalEmitter } from './encatch';
import type {
  EncatchConfig,
  UserTraits,
  IdentifyOptions,
  Theme,
  ShowFormOptions,
  EventCallback,
  EventType,
  EventPayload,
  SubmitFormRequest,
  RefineTextRequest,
  RefineTextResponse,
} from './types';

// ============================================================================
// Optional navigation imports (try/catch — same pattern as existing provider)
// ============================================================================

let useNavigationState: ((selector: (s: any) => any) => any) | null = null;
let useSegments: (() => string[]) | null = null;
let usePathname: (() => string) | null = null;
let useGlobalSearchParams: (() => Record<string, string>) | null = null;

try {
  const reactNavigation = require('../optional/react-navigation-native.js');
  useNavigationState = reactNavigation?.useNavigationState ?? null;
} catch {
  /* @react-navigation/native not installed */
}

try {
  const expoRouter = require('../optional/expo-router.js');
  useSegments = expoRouter?.useSegments ?? null;
  usePathname = expoRouter?.usePathname ?? null;
  useGlobalSearchParams = expoRouter?.useGlobalSearchParams ?? null;
} catch {
  /* expo-router not installed */
}

// ============================================================================
// Context types
// ============================================================================

export interface EncatchContextValue {
  isInitialized: boolean;
  /**
   * True when the SDK has a confirmed server-issued identity (both userName and
   * userId are present). Useful for gating auth-dependent UI without a separate
   * auth store. Automatically restored from storage on cold start (option 3) and
   * updated reactively when identifyUser succeeds or resetUser is called (option 1).
   */
  isIdentified: boolean;
  /** The identified user's userName, or null if not identified. */
  userName: string | null;
  /** Call Encatch.identifyUser */
  identifyUser: (userName: string, traits?: UserTraits, options?: IdentifyOptions) => void;
  /** Call Encatch.setLocale */
  setLocale: (locale: string) => void;
  /** Call Encatch.setCountry */
  setCountry: (country: string) => void;
  /** Call Encatch.setTheme */
  setTheme: (theme: Theme) => void;
  /** Call Encatch.trackEvent */
  trackEvent: (eventName: string) => void;
  /** Call Encatch.trackScreen */
  trackScreen: (screenName: string) => void;
  /** Call Encatch.showForm */
  showForm: (formId: string, options?: ShowFormOptions) => void;
  /** Call Encatch.dismissForm */
  dismissForm: (formConfigurationId?: string) => void;
  /** Call Encatch.addToResponse. Accepts a question ID or slug. */
  addToResponse: (questionId: string, value: unknown) => void;
  /** Call Encatch.resetUser */
  resetUser: () => void;
  /** Subscribe to SDK events */
  on: (callback: EventCallback) => () => void;
  /** Unsubscribe from SDK events */
  off: (callback: EventCallback) => void;
  /**
   * Submit form (for custom native forms when using onBeforeShowForm interceptor).
   * Sends responses to the Encatch API.
   */
  submitForm: (params: SubmitFormRequest) => void;
  /**
   * Emit a form event (for custom native forms when using onBeforeShowForm interceptor).
   * Use to mirror WebView form events: form:show, form:started, form:answered, form:submit, form:complete, form:close, etc.
   */
  emitEvent: (eventType: EventType, payload: Omit<EventPayload, 'timestamp'>) => void;
  /**
   * Refine text via AI (for custom native forms with AI enhance feature).
   */
  refineText: (params: RefineTextRequest) => Promise<RefineTextResponse>;
}

// ============================================================================
// Provider props
// ============================================================================

export interface EncatchProviderProps {
  children: ReactNode;
  /** Your Encatch API key */
  apiKey: string;
  /** SDK configuration (apiBaseUrl, webHost, theme, isFullScreen, debugMode) */
  config?: EncatchConfig;
  /**
   * Navigation library used for automatic screen tracking.
   * - 'expo-router': uses useSegments/usePathname from expo-router
   * - 'react-navigation': uses useNavigationState from @react-navigation/native
   * - null: no automatic tracking (call Encatch.trackScreen manually)
   * @default null
   */
  navigationType?: 'expo-router' | 'react-navigation' | null;
  /** Screen names that should be skipped for tracking */
  skippedRoutes?: string[];
}

// ============================================================================
// Helpers
// ============================================================================

function isRouteSkipped(path: string, skippedRoutes: string[]): boolean {
  return skippedRoutes.some((skip) => skip.toLowerCase() === path.toLowerCase());
}

// ============================================================================
// Expo Router tracker sub-component
// ============================================================================

const ExpoRouterTracker: React.FC<{ skippedRoutes: string[] }> = ({ skippedRoutes }) => {
  const segments = useSegments?.() ?? [];
  const pathname = usePathname?.() ?? '';
  const params = useGlobalSearchParams?.() ?? {};

  useEffect(() => {
    if (!pathname) return;

    // Extract dynamic segment names from the segments array
    const pathParamKeys = segments
      .filter((s) => s.startsWith('[') && s.endsWith(']'))
      .map((s) => s.slice(1, -1));

    const queryParams: Record<string, string> = {};
    for (const key of Object.keys(params)) {
      if (!pathParamKeys.includes(key) && key !== '#') {
        queryParams[key] = params[key];
      }
    }

    let fullPath = pathname;
    if (params['#']) fullPath += `#${params['#']}`;

    if (isRouteSkipped(fullPath, skippedRoutes)) return;

    Encatch.trackScreen(fullPath);
  }, [pathname, segments, params]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
};

// ============================================================================
// React Navigation tracker sub-component
// ============================================================================

const ReactNavigationTracker: React.FC<{ skippedRoutes: string[] }> = ({ skippedRoutes }) => {
  const navigationState = useNavigationState?.((state: any) => state);

  useEffect(() => {
    if (!navigationState) return;

    const getActiveRoute = (state: any): { path: string; params: Record<string, any> } => {
      if (!state?.routes) return { path: '/', params: {} };

      const route = state.routes[state.index ?? state.routes.length - 1];
      if (route.state) return getActiveRoute(route.state);

      const buildPath = (
        s: any,
        path = '',
        allParams: Record<string, any> = {}
      ): { path: string; params: Record<string, any> } => {
        if (!s?.routes) return { path, params: allParams };
        const r = s.routes[s.index ?? s.routes.length - 1];
        const merged = { ...allParams, ...(r.params ?? {}) };
        if (r.state) return buildPath(r.state, `${path}/${r.name}`, merged);
        return { path: `${path}/${r.name}`, params: merged };
      };

      return buildPath(state);
    };

    const { path, params } = getActiveRoute(navigationState);
    if (!path || isRouteSkipped(path, skippedRoutes)) return;

    Encatch.trackScreen(path);
  }, [navigationState]); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
};

// ============================================================================
// Context + Provider
// ============================================================================

const EncatchContext = createContext<EncatchContextValue | null>(null);

export const EncatchProvider: React.FC<EncatchProviderProps> = ({
  children,
  apiKey,
  config,
  navigationType = null,
  skippedRoutes = [],
}) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isIdentified, setIsIdentified] = useState(false);
  const [userName, setUserName] = useState<string | null>(null);
  const initCalled = useRef(false);

  useEffect(() => {
    if (initCalled.current) return;
    initCalled.current = true;

    Encatch.init(apiKey, config).then(async () => {
      setIsInitialized(true);
      // Option 3: restore identity from storage on cold start — init() has already
      // loaded userName + userId from AsyncStorage, so we can read them synchronously.
      setIsIdentified(!!Encatch.userName && !!Encatch.userId);
      setUserName(Encatch.userName);
      await Encatch.startSession();
    });

    return () => {
      Encatch.stop();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Option 1: react to live identity changes via the internal emitter
  // (identifyUser API success → identified, resetUser → cleared)
  useEffect(() => {
    const onUserIdentified = ({ userName: name, userId }: { userName: string | null; userId: string | null }) => {
      setIsIdentified(!!name && !!userId);
      setUserName(name);
    };
    _internalEmitter.on('userIdentified', onUserIdentified);
    return () => {
      _internalEmitter.off('userIdentified', onUserIdentified);
    };
  }, []);

  // ── Stable callback wrappers ────────────────────────────────────────────────

  const identifyUser = useCallback(
    (userName: string, traits?: UserTraits, opts?: IdentifyOptions) => {
      Encatch.identifyUser(userName, traits, opts).catch(() => {});
    },
    []
  );

  const setLocale = useCallback((locale: string) => Encatch.setLocale(locale), []);
  const setCountry = useCallback((country: string) => Encatch.setCountry(country), []);
  const setTheme = useCallback((theme: Theme) => Encatch.setTheme(theme), []);

  const trackEvent = useCallback(
    (eventName: string) => {
      Encatch.trackEvent(eventName).catch(() => {});
    },
    []
  );

  const trackScreen = useCallback(
    (screenName: string) => {
      Encatch.trackScreen(screenName).catch(() => {});
    },
    []
  );

  const showForm = useCallback(
    (formId: string, opts?: ShowFormOptions) => {
      Encatch.showForm(formId, opts).catch(() => {});
    },
    []
  );

  const dismissForm = useCallback(
    (formConfigurationId?: string) => {
      Encatch.dismissForm(formConfigurationId).catch(() => {});
    },
    []
  );

  const addToResponse = useCallback(
    (questionId: string, value: unknown) => Encatch.addToResponse(questionId, value),
    []
  );

  const resetUser = useCallback(() => {
    Encatch.resetUser().catch(() => {});
  }, []);

  const on = useCallback((callback: EventCallback) => Encatch.on(callback), []);
  const off = useCallback((callback: EventCallback) => Encatch.off(callback), []);

  const submitForm = useCallback(
    (params: SubmitFormRequest) => {
      Encatch.submitForm(params).catch(() => {});
    },
    []
  );

  const emitEvent = useCallback(
    (eventType: EventType, payload: Omit<EventPayload, 'timestamp'>) => {
      Encatch.emitEvent(eventType, payload);
    },
    []
  );

  const refineText = useCallback((params: RefineTextRequest) => {
    return Encatch.refineText(params);
  }, []);

  // ── Context value ─────────────────────────────────────────────────────────

  const contextValue: EncatchContextValue = {
    isInitialized,
    isIdentified,
    userName,
    identifyUser,
    setLocale,
    setCountry,
    setTheme,
    trackEvent,
    trackScreen,
    showForm,
    dismissForm,
    addToResponse,
    resetUser,
    on,
    off,
    submitForm,
    emitEvent,
    refineText,
  };

  return (
    <EncatchContext.Provider value={contextValue}>
      {navigationType === 'expo-router' && useSegments && (
        <ExpoRouterTracker skippedRoutes={skippedRoutes} />
      )}
      {navigationType === 'react-navigation' && useNavigationState && (
        <ReactNavigationTracker skippedRoutes={skippedRoutes} />
      )}
      {children}
    </EncatchContext.Provider>
  );
};

// ============================================================================
// useEncatch hook
// ============================================================================

export function useEncatch(): EncatchContextValue {
  const context = useContext(EncatchContext);
  if (!context) {
    throw new Error('[Encatch] useEncatch must be used within an <EncatchProvider>');
  }
  return context;
}
