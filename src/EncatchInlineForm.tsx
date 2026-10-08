/**
 * EncatchInlineForm
 *
 * Renders the Encatch form inline within the host layout — no modal, no overlay.
 * Place it anywhere in a screen's component tree.
 *
 * Routing (resolved before this component receives anything):
 *  - Exact match: <EncatchInlineForm formId="slug" /> catches showForm('slug')
 *  - Wildcard:    <EncatchInlineForm /> catches any form not claimed by an exact slot
 *  - Fallback:    when no inline slot is registered, EncatchWebView (modal) takes over
 *
 * Slot registration is tied to screen focus (via useIsFocused when available) so
 * background tab screens do not intercept showForm meant for the modal.
 *
 * ScrollView embedding:
 *  - WebView scroll is disabled; the host ScrollView scrolls the sized widget.
 *  - Normal form content grows to its reported height so long forms remain reachable
 *    through the host ScrollView.
 *  - QnA/Scheduler overlays freeze to a capped widget height instead of expanding to
 *    full screen or clipping the underlying form content.
 *  - Host apps should use automaticallyAdjustKeyboardInsets / scroll-into-view when
 *    the keyboard opens (WebView focus is not native — SDK does not shrink on keyboard).
 *  - The web form page receives presentation=inline for overlay CSS (height: 100%).
 *
 * Single-active-form contract:
 *  - When a showForm targets a different presenter, this component clears its
 *    active payload so only one form is ever visible at a time.
 *  - On unmount while a form is active: SDK visibility state is cleared; no
 *    dismiss API call is made — the user simply chose not to fill.
 */
import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import {
  View,
  Animated,
  Appearance,
  Dimensions,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Encatch, _internalEmitter } from './encatch';
import {
  registerInlineSlot,
  unregisterInlineSlot,
} from './form-presentation-registry';
import { useEncatchFormWebView } from './useEncatchFormWebView';
import {
  getBackgroundColor,
  getInlineBorderRadii,
  resolveActiveMode,
  resolveCornersFromFormConfig,
  resolveSystemColorScheme,
} from './form-webview-helpers';
import { FormWebViewSkeleton } from './FormWebViewLoading';
import { buildInlineWebViewSizingFixScript } from './form-inline-webview-helpers';
import type { ShowFormPayload } from './types';

// ============================================================================
// Optional navigation import — register inline slot only while screen is focused
// ============================================================================

let useIsFocused: (() => boolean) | null = null;
try {
  const reactNavigation = require('../optional/react-navigation-native.js');
  useIsFocused = reactNavigation?.useIsFocused ?? null;
} catch {
  /* @react-navigation/native not installed — slot stays registered while mounted */
}

// ============================================================================
// Props
// ============================================================================

export interface EncatchInlineFormProps {
  /**
   * When set, this slot only catches showForm() calls for this exact form id (slug or uuid).
   * When omitted, this is a wildcard slot that catches any unmatched form.
   */
  formId?: string;
  /** Outer container layout style. */
  style?: StyleProp<ViewStyle>;
  /**
   * Optional minimum height floor in points after the first form:resize.
   * Defaults to 0 (height comes from form content only). Before the first resize,
   * a 1px placeholder keeps the WebView mountable for the loading overlay.
   */
  minHeight?: number;
  /**
   * Called when an in-form overlay (QnA with AI, Scheduler) opens or closes.
   * Host apps can use this to adjust outer ScrollView scroll/keyboard behavior.
   */
  onOverlayOpenChange?: (open: boolean) => void;
}

// ============================================================================
// Component
// ============================================================================

// Visible skeleton height used before the first form:resize arrives.
const LOADING_SKELETON_HEIGHT = 300;

export const EncatchInlineForm: React.FC<EncatchInlineFormProps> = ({
  formId: formIdProp,
  style,
  minHeight = 0,
  onOverlayOpenChange,
}) => {
  const slotIdRef = useRef<string | null>(null);
  const isFocused = useIsFocused?.() ?? true;

  // Height driven by form:resize messages (0 until the first resize).
  const [contentHeight, setContentHeight] = useState(0);
  const contentHeightRef = useRef(0);
  /** Frozen widget height while QnA/Scheduler overlay is open (no screen expansion). */
  const [overlayFrozenHeight, setOverlayFrozenHeight] = useState<number | null>(null);
  const overlayActiveRef = useRef(false);
  const maxContentHeightRef = useRef(Math.round(Dimensions.get('window').height * 0.8));

  const [screenHeight, setScreenHeight] = useState(Dimensions.get('window').height);
  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setScreenHeight(window.height);
    });
    return () => sub.remove();
  }, []);

  // System color scheme for background color resolution.
  const [systemColorScheme, setSystemColorScheme] = useState<'light' | 'dark'>(() =>
    resolveSystemColorScheme(Appearance.getColorScheme())
  );
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(resolveSystemColorScheme(colorScheme));
    });
    return () => sub.remove();
  }, []);

  // Keyboard — host ScrollView handles insets/scroll (WebView focus is not native).

  const handleClose = useCallback(() => {
    bridge.setFormPayload(null);
    bridge.setWebViewReady(false);
    bridge.webViewReadyRef.current = false;
    overlayActiveRef.current = false;
    setOverlayFrozenHeight(null);
    Encatch.setFormVisible(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resolveContentHeight = useCallback(
    (h: number) => (minHeight > 0 ? Math.max(h, minHeight) : h),
    [minHeight]
  );

  const handleHeightChange = useCallback(
    (h: number) => {
      if (overlayActiveRef.current) return;
      const nextHeight = resolveContentHeight(h);
      contentHeightRef.current = nextHeight;
      setContentHeight(nextHeight);
    },
    [resolveContentHeight]
  );

  const handleForceFullHeight = useCallback(
    (force: boolean) => {
      overlayActiveRef.current = force;
      if (force) {
        const baseHeight =
          contentHeightRef.current > 0
            ? resolveContentHeight(contentHeightRef.current)
            : minHeight > 0
              ? minHeight
              : LOADING_SKELETON_HEIGHT;
        setOverlayFrozenHeight(Math.min(baseHeight, maxContentHeightRef.current));
      } else {
        setOverlayFrozenHeight(null);
      }
      onOverlayOpenChange?.(force);
    },
    [minHeight, onOverlayOpenChange, resolveContentHeight]
  );

  const bridge = useEncatchFormWebView({
    logTag: 'EncatchInlineForm',
    onClose: handleClose,
    onHeightChange: handleHeightChange,
    onForceFullHeight: handleForceFullHeight,
    onReady: () => {},
    presentation: 'inline',
  });

  const maxContentHeight = useMemo(() => {
    const raw = (bridge.formPayload?.formConfig as any)?.appearanceProperties?.featureSettings
      ?.maxDialogHeightPercentInApp;
    const fraction = typeof raw === 'number' ? raw / 100 : 0.8;
    return Math.round(screenHeight * fraction);
  }, [bridge.formPayload, screenHeight]);

  maxContentHeightRef.current = maxContentHeight;

  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;

  const injectInlineSizingFix = useCallback(() => {
    bridge.webViewRef.current?.injectJavaScript(buildInlineWebViewSizingFixScript());
  }, [bridge.webViewRef]);

  useEffect(() => {
    if (!bridge.formPayload || !bridge.webViewReady) return;
    injectInlineSizingFix();
  }, [bridge.formPayload, bridge.webViewReady, bridge.webViewInstanceKey, injectInlineSizingFix]);

  // Register the inline routing slot only while this screen is focused.
  // Tab navigators keep screens mounted in the background; without this, a
  // wildcard slot on a hidden tab would steal showForm from the modal.
  useEffect(() => {
    if (!isFocused) {
      if (slotIdRef.current) {
        unregisterInlineSlot(slotIdRef.current);
        slotIdRef.current = null;
      }
      const activeBridge = bridgeRef.current;
      activeBridge.setFormPayload(null);
      activeBridge.setWebViewReady(false);
      activeBridge.webViewReadyRef.current = false;
      overlayActiveRef.current = false;
      setOverlayFrozenHeight(null);
      Encatch.setFormVisible(false);
      return;
    }

    const slotId = registerInlineSlot(formIdProp);
    slotIdRef.current = slotId;
    return () => {
      unregisterInlineSlot(slotId);
      if (slotIdRef.current === slotId) {
        slotIdRef.current = null;
      }
    };
  }, [isFocused, formIdProp]);

  // ============================================================================
  // Internal emitter listeners
  // ============================================================================

  useEffect(() => {
    const onShowForm = (payload: ShowFormPayload) => {
      const mySlotId = slotIdRef.current;

      if (payload.presentation === 'inline' && payload.inlineSlotId === mySlotId) {
        // This event is for us — load the form.
        bridge.setWebViewInstanceKey((k) => k + 1);
        bridge.setFormPayload(payload);
        bridge.setWebViewReady(false);
        bridge.webViewReadyRef.current = false;
        contentHeightRef.current = 0;
        setContentHeight(0);
        overlayActiveRef.current = false;
        setOverlayFrozenHeight(null);
        Encatch.setFormVisible(true);
      } else {
        // A different presenter is taking over — clear our payload to maintain
        // the single-active-form contract.
        bridge.setFormPayload((current) => {
          if (current !== null) {
            Encatch.setFormVisible(false);
          }
          return null;
        });
        bridge.setWebViewReady(false);
        bridge.webViewReadyRef.current = false;
      }
    };

    const onDismissForm = () => {
      if (!bridge.formPayload) return;
      bridge.setFormPayload(null);
      bridge.setWebViewReady(false);
      bridge.webViewReadyRef.current = false;
      Encatch.setFormVisible(false);
    };

    _internalEmitter.on('showForm', onShowForm);
    _internalEmitter.on('dismissForm', onDismissForm);
    return () => {
      _internalEmitter.off('showForm', onShowForm);
      _internalEmitter.off('dismissForm', onDismissForm);
    };
  }, [bridge, minHeight]);

  // On unmount while form is active — clear visibility state; no API call.
  useEffect(() => {
    return () => {
      if (bridge.formPayload) {
        Encatch.setFormVisible(false);
      }
    };
  }, [bridge.formPayload]);

  // ============================================================================
  // Background color (matches what the WebView renders to avoid white flash)
  // ============================================================================

  const { bgColor, activeMode } = useMemo(() => {
    const appearanceProperties = (bridge.formPayload?.formConfig as any)?.appearanceProperties;
    const payloadTheme = bridge.formPayload?.theme;
    const shareableMode = appearanceProperties?.featureSettings?.shareableMode as string | undefined;
    const effectiveMode = payloadTheme ?? shareableMode;
    const activeMode = resolveActiveMode(effectiveMode, systemColorScheme);
    const themeJson = appearanceProperties?.themes?.[activeMode]?.theme as string | undefined;
    const fallback = activeMode === 'dark' ? '#1a1a1a' : '#ffffff';
    return {
      bgColor: getBackgroundColor(themeJson, fallback),
      activeMode,
    };
  }, [bridge.formPayload, systemColorScheme]);

  const borderRadii = useMemo(() => {
    const corners = resolveCornersFromFormConfig(bridge.formPayload?.formConfig);
    return getInlineBorderRadii(corners);
  }, [bridge.formPayload]);

  // ============================================================================
  // Render
  // ============================================================================

  if (!bridge.formPayload) {
    // Slot is mounted but no form is active — render nothing (zero size unless style says otherwise).
    return <View style={[{ height: 0 }, style]} />;
  }

  const webViewHeight =
    overlayFrozenHeight ??
    (contentHeight > 0
      ? resolveContentHeight(contentHeight)
      : minHeight > 0
        ? minHeight
        : LOADING_SKELETON_HEIGHT);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.webViewWrapper,
          style,
          borderRadii,
          {
            height: webViewHeight,
            backgroundColor: bgColor,
          },
        ]}
      >
        <WebView
          ref={bridge.webViewRef}
          key={bridge.webViewInstanceKey}
          source={{ uri: bridge.webViewUrl }}
          onMessage={bridge.handleWebViewMessage}
          onShouldStartLoadWithRequest={bridge.handleShouldStartLoad}
          onLoad={() => {
            injectInlineSizingFix();
            setTimeout(() => {
              if (!bridge.webViewReadyRef.current) {
                bridge.handleFormReady();
              }
              injectInlineSizingFix();
            }, 300);
          }}
          javaScriptEnabled
          domStorageEnabled
          mixedContentMode="compatibility"
          scrollEnabled={false}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          style={{ flex: 1, backgroundColor: bgColor, ...borderRadii }}
          containerStyle={{ flex: 1, backgroundColor: bgColor, ...borderRadii }}
          onError={(e) => console.warn('[EncatchInlineForm] Load error:', e.nativeEvent)}
          onHttpError={(e) => console.warn('[EncatchInlineForm] HTTP error:', e.nativeEvent.statusCode, e.nativeEvent.url)}
        />
        {!bridge.webViewReady && (
          <View pointerEvents="auto" style={StyleSheet.absoluteFillObject}>
            <FormWebViewSkeleton backgroundColor={bgColor} activeMode={activeMode} />
          </View>
        )}
      </Animated.View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  webViewWrapper: {
    width: '100%',
    overflow: 'hidden',
  },
});

export default EncatchInlineForm;
