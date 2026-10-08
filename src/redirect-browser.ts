/**
 * Opens completionCta redirect_internal URLs in an in-app browser when available.
 */

import { Linking, Platform } from 'react-native';

type ExpoWebBrowser = {
  openBrowserAsync: (
    url: string,
    options?: { createTask?: boolean }
  ) => Promise<unknown>;
};

let _expoWebBrowser: ExpoWebBrowser | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _expoWebBrowser = require('../optional/expo-web-browser.js');
} catch {
  _expoWebBrowser = null;
}

/** Android: open in the app task so Custom Tabs are not torn down with the RN Modal. */
const ANDROID_BROWSER_OPTIONS = { createTask: false as const };

/**
 * Minimum delay before opening the in-app browser after tearing down the form modal.
 * SFSafariViewController / Custom Tabs fail or dismiss instantly if presented too soon
 * (exit_form pending CTA at autoTriggerDelayMs 0 is especially sensitive).
 */
export const REDIRECT_INTERNAL_AFTER_CLOSE_DELAY_MS = 400;

/** Default delay for other zero-delay pending exit_form CTAs (app_navigate, etc.). */
export const CTA_AFTER_CLOSE_DELAY_MS = 50;

export function openRedirectInternalUrl(url: string, logTag: string): void {
  if (_expoWebBrowser) {
    const options = Platform.OS === 'android' ? ANDROID_BROWSER_OPTIONS : undefined;
    void _expoWebBrowser.openBrowserAsync(url, options).catch((err: unknown) => {
      console.warn(`[${logTag}] redirect_internal: expo-web-browser failed:`, url, err);
    });
    return;
  }

  Linking.openURL(url).catch((err) => {
    console.warn(`[${logTag}] redirect_internal: Linking fallback failed:`, url, err);
  });
}
