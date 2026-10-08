import type { Router } from 'expo-router';

/** Pops when app_navigate used push; falls back to tabs home when there is nothing to pop. */
export function popToPreviousOrHome(router: Router): void {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/(tabs)');
  }
}
