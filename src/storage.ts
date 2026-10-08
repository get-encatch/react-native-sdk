/**
 * AsyncStorage-backed persistence layer for the Encatch React Native SDK.
 *
 * Replaces both the old device-storage.ts and session-id-analytics.ts.
 * All keys are namespaced under '@encatch/'.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { uuidv7 } from 'uuidv7';

// ============================================================================
// Storage Keys
// ============================================================================

const KEY_DEVICE_ID = '@encatch/device_id';
const KEY_USER_NAME = '@encatch/user_name';
const KEY_USER_ID_PREFIX = '@encatch/user_id_';
const KEY_FT_PREFIX = '@encatch/ft_';
const KEY_PREFERENCES = '@encatch/preferences';
const KEY_SESSION_STOPPED = '@encatch/session_stopped';

// ============================================================================
// Device ID
// ============================================================================

/**
 * Returns the persisted device ID, creating and storing one if it doesn't exist.
 * Uses UUIDv7 (time-ordered). Device IDs survive app restarts; reinstall clears.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  try {
    const stored = await AsyncStorage.getItem(KEY_DEVICE_ID);
    if (stored) return stored;
    const id = uuidv7();
    await AsyncStorage.setItem(KEY_DEVICE_ID, id);
    return id;
  } catch {
    return uuidv7();
  }
}

// ============================================================================
// Session ID (in-memory only — reset when app closes)
// ============================================================================

let inMemorySessionId: string | null = null;

/**
 * Returns the current session ID. Creates a new one if none exists.
 * Session is in-memory only: reset when the app process ends (e.g. user closes app).
 */
export async function getOrCreateSessionId(): Promise<string> {
  if (inMemorySessionId) return inMemorySessionId;
  inMemorySessionId = uuidv7();
  return inMemorySessionId;
}

/** Clears the current session, forcing a new one to be created on next call. */
export async function clearSession(): Promise<void> {
  inMemorySessionId = null;
}

// ============================================================================
// User Name
// ============================================================================

export async function getUserName(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY_USER_NAME);
  } catch {
    return null;
  }
}

export async function setUserName(name: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_USER_NAME, name);
  } catch {
    /* ignore */
  }
}

export async function clearUserName(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_USER_NAME);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// User ID (keyed by userName, mirrors web SDK's localStorage pattern)
// ============================================================================

export async function getUserId(userName: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(`${KEY_USER_ID_PREFIX}${userName}`);
  } catch {
    return null;
  }
}

export async function setUserId(userName: string, userId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(`${KEY_USER_ID_PREFIX}${userName}`, userId);
  } catch {
    /* ignore */
  }
}

export async function clearUserId(userName: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${KEY_USER_ID_PREFIX}${userName}`);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Feedback Transactions
// Keyed by identity key ('anonymous' or userName) — persisted across sessions.
// ============================================================================

function ftKey(identityKey: string): string {
  return `${KEY_FT_PREFIX}${identityKey}`;
}

export async function getFeedbackTransactions(identityKey: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ftKey(identityKey));
  } catch {
    return null;
  }
}

export async function setFeedbackTransactions(
  identityKey: string,
  value: string
): Promise<void> {
  try {
    await AsyncStorage.setItem(ftKey(identityKey), value);
  } catch {
    /* ignore */
  }
}

export async function clearFeedbackTransactions(identityKey: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(ftKey(identityKey));
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Preferences (locale / country — persisted across restarts)
// Mirrors web SDK's encatch_preferences in localStorage.
// ============================================================================

export interface Preferences {
  locale?: string;
  country?: string;
}

export async function getPreferences(): Promise<Preferences> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREFERENCES);
    return raw ? (JSON.parse(raw) as Preferences) : {};
  } catch {
    return {};
  }
}

export async function setPreferences(updates: Preferences): Promise<void> {
  try {
    const current = await getPreferences();
    await AsyncStorage.setItem(KEY_PREFERENCES, JSON.stringify({ ...current, ...updates }));
  } catch {
    /* ignore */
  }
}

export async function clearPreferences(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_PREFERENCES);
  } catch {
    /* ignore */
  }
}

// ============================================================================
// Session stopped flag (persisted — survives app restarts)
// Written by stopSession(); cleared by startSession().
// ============================================================================

export async function getSessionStopped(): Promise<boolean> {
  try {
    const val = await AsyncStorage.getItem(KEY_SESSION_STOPPED);
    return val === 'true';
  } catch {
    return false;
  }
}

export async function setSessionStopped(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SESSION_STOPPED, 'true');
  } catch {
    /* ignore */
  }
}

export async function clearSessionStopped(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_SESSION_STOPPED);
  } catch {
    /* ignore */
  }
}
