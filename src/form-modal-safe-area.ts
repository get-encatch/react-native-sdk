import { Platform, StatusBar } from 'react-native';
import {
  initialWindowMetrics,
  type EdgeInsets,
} from 'react-native-safe-area-context';

const zeroInsets: EdgeInsets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Modal + statusBarTranslucent on Android often reports zero insets from
 * useSafeAreaInsets(). Fall back to launch metrics and StatusBar height so
 * the popup stays below the status bar and above the nav/task bar.
 */
export function resolveModalSafeAreaInsets(insets: EdgeInsets): EdgeInsets {
  const fallback = initialWindowMetrics?.insets ?? zeroInsets;

  if (Platform.OS === 'android') {
    const statusBarHeight = StatusBar.currentHeight ?? 0;
    return {
      top: Math.max(insets.top, fallback.top, statusBarHeight),
      bottom: Math.max(insets.bottom, fallback.bottom),
      left: Math.max(insets.left, fallback.left),
      right: Math.max(insets.right, fallback.right),
    };
  }

  return {
    top: Math.max(insets.top, fallback.top),
    bottom: Math.max(insets.bottom, fallback.bottom),
    left: Math.max(insets.left, fallback.left),
    right: Math.max(insets.right, fallback.right),
  };
}
