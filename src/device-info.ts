/**
 * Device information helpers with graceful fallbacks.
 *
 * Priority chain for locale:  expo-localization → react-native-localize → 'en'
 * Priority chain for type:    expo-device → react-native-device-info → Platform heuristic
 *
 * All optional packages are loaded through the loader modules in ../optional/,
 * which export null when a package is not installed (see the comment there for
 * why each lives in its own module). Calls stay inside try/catch because an
 * installed package can still throw (e.g. expo-application in Expo Go).
 */
import { Platform } from 'react-native';

// ============================================================================
// Locale
// ============================================================================

/**
 * Returns the device's primary language tag (e.g. 'en-US', 'fr-FR').
 * Falls back to 'en' if no localization package is available.
 */
export async function getDeviceLocale(): Promise<string> {
  // 1. expo-localization (Expo apps)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Localization = require('../optional/expo-localization.js');
    const locales = Localization?.getLocales?.();
    if (Array.isArray(locales) && locales.length > 0 && locales[0]?.languageTag) {
      return locales[0].languageTag as string;
    }
  } catch {
    /* expo-localization not installed */
  }

  // 2. react-native-localize (bare React Native)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const RNLocalize = require('../optional/react-native-localize.js');
    const locales = RNLocalize?.getLocales?.();
    if (Array.isArray(locales) && locales.length > 0 && locales[0]?.languageTag) {
      return locales[0].languageTag as string;
    }
  } catch {
    /* react-native-localize not installed */
  }

  return 'en';
}

// ============================================================================
// Device Type
// ============================================================================

export type DeviceType = 'mobile' | 'tablet' | 'desktop';

/**
 * Returns the device type classification.
 * Falls back to a screen-width heuristic when no package is available.
 */
export async function getDeviceType(): Promise<DeviceType> {
  // 1. expo-device (Expo apps)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Device = require('../optional/expo-device.js');
    const type = await Device?.getDeviceTypeAsync?.();
    // expo-device DeviceType enum: PHONE=1, TABLET=2, DESKTOP=3, TV=4
    if (type === Device?.DeviceType?.TABLET) return 'tablet';
    if (type === Device?.DeviceType?.DESKTOP) return 'desktop';
    if (type === Device?.DeviceType?.PHONE) return 'mobile';
  } catch {
    /* expo-device not installed */
  }

  // 2. react-native-device-info (bare React Native)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DeviceInfo = require('../optional/react-native-device-info.js');
    const type: string = DeviceInfo?.getDeviceType?.();
    if (type === 'Tablet') return 'tablet';
    if (type === 'Desktop') return 'desktop';
    if (type === 'Handset') return 'mobile';
  } catch {
    /* react-native-device-info not installed */
  }

  // 3. Platform.isPad (iOS only) — no native module needed
  if (Platform.OS === 'ios' && (Platform as any).isPad === true) {
    return 'tablet';
  }

  return 'mobile';
}

// ============================================================================
// OS Version
// ============================================================================

/**
 * Returns the OS version string.
 * Uses Platform.Version (built into React Native, no extra package required).
 */
export function getOsVersion(): string {
  const v = Platform.Version;
  if (typeof v === 'number') return String(v);
  return v ?? 'unknown';
}

// ============================================================================
// App Version
// ============================================================================

/**
 * Returns the native app version (e.g. "2.11.0").
 */
export async function getAppVersion(): Promise<string | null> {
  // 1. expo-application (Expo apps)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Application = require('../optional/expo-application.js');
    const v = Application?.nativeApplicationVersion;
    if (v && typeof v === 'string') return v;
  } catch {
    /* expo-application not installed */
  }

  // 2. react-native-device-info (bare RN)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DeviceInfo = require('../optional/react-native-device-info.js');
    const v = DeviceInfo?.getVersion?.();
    if (v && typeof v === 'string') return v;
  } catch {
    /* react-native-device-info not installed */
  }

  return null;
}

// ============================================================================
// App Package / Bundle ID
// ============================================================================

/**
 * Returns the host app's package name (Android) or bundle ID (iOS).
 * Used as Referer header in API requests to identify the installing app.
 *
 * Logic:
 * - Expo Go: use expo-device to detect, then "expo-go" (never touch react-native-device-info)
 * - Expo dev build: use expo-application
 * - Bare React Native: use react-native-device-info
 */
export async function getAppPackageId(): Promise<string | null> {
  // 1. Check if we're in Expo (expo-device works in both Expo Go and dev builds)
  let isExpo = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Device = require('../optional/expo-device.js');
    isExpo = typeof Device?.getDeviceTypeAsync === 'function';
  } catch {
    /* expo-device not installed — we're in bare RN */
  }

  if (isExpo) {
    // Expo environment: try expo-application (works in dev builds)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Application = require('../optional/expo-application.js');
      let id = Application?.applicationId;
      if (!id && typeof Application?.getApplicationIdAsync === 'function') {
        id = await Application.getApplicationIdAsync();
      }
      if (id && typeof id === 'string') return id;
    } catch {
      /* expo-application failed — likely Expo Go where it may not be available */
    }
    // Expo Go: return static string (expo-application can throw in Expo Go)
    try {
      const Constants = require('../optional/expo-constants.js');
      const env = Constants?.default?.executionEnvironment ?? Constants?.executionEnvironment;
      if (env === 'storeClient') return 'expo-go';
    } catch {
      /* fallthrough */
    }
    return 'expo-go';
  }

  // 2. Bare React Native: use react-native-device-info
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const DeviceInfo = require('../optional/react-native-device-info.js');
    const id = DeviceInfo?.getBundleId?.();
    if (id && typeof id === 'string') return id;
  } catch {
    /* react-native-device-info not installed */
  }

  return null;
}

// ============================================================================
// Timezone
// ============================================================================

/**
 * Returns the device timezone (e.g. 'Asia/Kolkata', 'America/New_York').
 * Uses Intl.DateTimeFormat; no native module required.
 */
export function getTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === 'string') return tz;
  } catch {
    /* Intl unavailable or returned invalid */
  }
  return null;
}

// ============================================================================
// Platform
// ============================================================================

export function getPlatform(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

// ============================================================================
// Device Type Env (native vs web)
// ============================================================================

/**
 * Returns 'native' (iOS/Android) or 'web' (React Native Web).
 * Used for $deviceType in API requests.
 */
export function getDeviceTypeEnv(): 'native' | 'web' {
  return getPlatform() === 'web' ? 'web' : 'native';
}

// ============================================================================
// Device Size (web only)
// ============================================================================

/**
 * Returns viewport-based size category (web only).
 * mobile: < 768px, tablet: 768–1023px, desktop: >= 1024px.
 * Returns undefined when not in a browser (e.g. native iOS/Android).
 */
export function getDeviceSize(): 'mobile' | 'tablet' | 'desktop' | undefined {
  const g = globalThis as typeof globalThis & { window?: { innerWidth: number } };
  if (typeof g.window === 'undefined' || typeof g.window.innerWidth !== 'number') {
    return undefined;
  }
  const w = g.window.innerWidth;
  if (w < 768) return 'mobile';
  if (w < 1024) return 'tablet';
  return 'desktop';
}
