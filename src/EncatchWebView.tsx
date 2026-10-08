/**
 * EncatchWebView
 *
 * Drop-in component that renders the Encatch form inside a WebView overlay.
 * Place once anywhere in your app's root layout — no props required.
 *
 * Responsibilities:
 *  - Subscribes to the internal Encatch event emitter (showForm / dismissForm)
 *    and handles only events where presentation === 'modal'.
 *  - Loads the remote react-native-sdk-form URL in a react-native-webview
 *  - Bridges postMessages bidirectionally via useEncatchFormWebView hook
 *  - Animated entrance/exit (slide from position or scale from center)
 *  - Responsive width from inAppSize preset; mobile collapses left/right to center
 *  - full-center fills safe-area width/height (overlay still covers full screen)
 *  - Safe-area-aware height (respects notch, status bar, home indicator)
 *  - Rendered through a native Modal so it sits above the entire app tree
 */
import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import {
  StyleSheet,
  Dimensions,
  Animated,
  Appearance,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  View,
  type ColorSchemeName,
  type LayoutChangeEvent,
} from 'react-native';
import {
  SafeAreaProvider,
  SafeAreaView,
  initialWindowMetrics,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Encatch, _internalEmitter } from './encatch';
import { useEncatchFormWebView } from './useEncatchFormWebView';
import {
  getPositionLayout,
  getBorderRadii,
  resolveCornersFromFormConfig,
  resolveDarkOverlayFromFormConfig,
  resolveModalOverlayBackgroundColor,
  resolveInAppSizeFromFormConfig,
  resolveSelectedPositionFromFormConfig,
  normalizePosition,
  resolveInAppMaxWidthPx,
  getAnimationConfig,
  getBackgroundColor,
  getModalPopupShadowStyle,
  resolveActiveMode,
  resolveSystemColorScheme,
} from './form-webview-helpers';
import { FormWebViewSkeleton } from './FormWebViewLoading';
import { ModalBackdropBlur } from './ModalBackdropBlur';
import type { ShowFormPayload } from './types';
import { traceFormResize } from './form-resize-trace';
import { resolveModalSafeAreaInsets } from './form-modal-safe-area';

// ============================================================================
// Inner component (must be a descendant of SafeAreaProvider)
// ============================================================================

const EncatchWebViewInner: React.FC = () => {
  const hookInsets = useSafeAreaInsets();
  const insets = useMemo(
    () => resolveModalSafeAreaInsets(hookInsets),
    [hookInsets]
  );

  // Modal visibility & closing state
  const [visible, setVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  const [systemColorScheme, setSystemColorScheme] = useState<'light' | 'dark'>(() =>
    resolveSystemColorScheme(Appearance.getColorScheme())
  );
  useEffect(() => {
    const subscription = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemColorScheme(resolveSystemColorScheme(colorScheme as ColorSchemeName));
    });
    return () => subscription.remove();
  }, []);

  // Keyboard visibility and height
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const isKeyboardVisibleRef = useRef(false);
  isKeyboardVisibleRef.current = isKeyboardVisible;

  // Measured height of the Modal's root overlay, plus the tallest value seen
  // for the current window size. If the overlay shrinks while the keyboard is
  // up, Android has already resized the Modal window for the IME (adjustResize)
  // and we must not lift the popup a second time.
  const [overlayHeight, setOverlayHeight] = useState(0);
  const overlayBaselineHeightRef = useRef(0);

  // Dynamic sizing
  const [screenWidth, setScreenWidth] = useState(Dimensions.get('window').width);
  const [screenHeight, setScreenHeight] = useState(Dimensions.get('window').height);
  const animatedHeight = useRef(new Animated.Value(300)).current;
  const heightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAppliedHeightRef = useRef(0);
  /** Raw, uncapped content height last reported by the WebView (`form:resize`). */
  const lastContentHeightRef = useRef(0);
  const keyboardSettleUntilRef = useRef(0);
  const keyboardSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entry animation refs
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const translateXAnim = useRef(new Animated.Value(0)).current;
  const translateYAnim = useRef(new Animated.Value(0)).current;

  // Incremented on every close attempt and every new showForm.
  const closeGenerationRef = useRef(0);

  // ============================================================================
  // Height update (debounced, capped at maxHeightFraction of viewport)
  // ============================================================================

  const maxDialogHeightRef = useRef(screenHeight * 0.8);
  const forceFullHeightRef = useRef(false);
  const isFullCenterRef = useRef(false);

  const [forceFullHeight, setForceFullHeight] = useState(false);
  forceFullHeightRef.current = forceFullHeight;

  const resolveLayoutPosition = useCallback(
    (formConfig: ShowFormPayload['formConfig'] | undefined) => {
      const raw = resolveSelectedPositionFromFormConfig(formConfig);
      return normalizePosition(raw, screenWidth);
    },
    [screenWidth]
  );

  // Applies min(rawHeight, currentCap) to the animated height. Shared by both
  // WebView-driven resize (`updateHeight`) and the keyboard-open/close resync
  // effect below, so the popup always reflects "as much of rawHeight as fits
  // within maxHeightFraction of the currently available space".
  const applyPopupHeight = useCallback(
    (rawHeight: number, options?: { animate?: boolean; reason?: string }) => {
      if (forceFullHeightRef.current || isFullCenterRef.current) return;
      const cap = maxDialogHeightRef.current;
      const target = Math.min(rawHeight, cap);
      if (Math.abs(target - lastAppliedHeightRef.current) <= 2) {
        traceFormResize(Encatch.debugMode, 'EncatchWebView', 'resize-skipped', {
          reason: 'unchanged',
          requestedHeight: rawHeight,
          cappedHeight: target,
          cap,
          source: options?.reason,
        });
        return;
      }
      traceFormResize(Encatch.debugMode, 'EncatchWebView', 'resize-applied', {
        requestedHeight: rawHeight,
        cappedHeight: target,
        cap,
        isKeyboardVisible: isKeyboardVisibleRef.current,
        source: options?.reason,
      });
      lastAppliedHeightRef.current = target;
      if (options?.animate === false) {
        animatedHeight.setValue(target);
        return;
      }
      Animated.timing(animatedHeight, {
        toValue: target,
        duration: 150,
        useNativeDriver: false,
      }).start();
    },
    [animatedHeight]
  );

  const updateHeight = useCallback(
    (newHeight: number) => {
      if (forceFullHeightRef.current || isFullCenterRef.current) return;
      lastContentHeightRef.current = newHeight;
      if (Date.now() < keyboardSettleUntilRef.current) {
        traceFormResize(Encatch.debugMode, 'EncatchWebView', 'resize-skipped', {
          reason: 'keyboard-settle',
          requestedHeight: newHeight,
          settleUntil: keyboardSettleUntilRef.current,
        });
        return;
      }
      if (heightTimeoutRef.current) clearTimeout(heightTimeoutRef.current);
      heightTimeoutRef.current = setTimeout(() => {
        applyPopupHeight(newHeight, { reason: 'form-resize' });
      }, 10);
    },
    [applyPopupHeight]
  );

  // form:resize messages are ignored while the keyboard animates (see
  // updateHeight). When the settle window ends, re-apply the latest content
  // height once, so a resize that arrived during it is not lost — e.g. moving
  // to a taller page with Next while the keyboard is closing, which otherwise
  // left the popup at the previous page's height.
  const startKeyboardSettle = useCallback(
    (settleMs: number) => {
      keyboardSettleUntilRef.current = Date.now() + settleMs;
      if (keyboardSettleTimerRef.current) clearTimeout(keyboardSettleTimerRef.current);
      keyboardSettleTimerRef.current = setTimeout(() => {
        keyboardSettleTimerRef.current = null;
        const content = lastContentHeightRef.current;
        if (content > 0) {
          applyPopupHeight(content, { reason: 'keyboard-settle-end' });
        }
      }, settleMs);
    },
    [applyPopupHeight]
  );

  useEffect(() => {
    return () => {
      if (heightTimeoutRef.current) clearTimeout(heightTimeoutRef.current);
      if (keyboardSettleTimerRef.current) clearTimeout(keyboardSettleTimerRef.current);
    };
  }, []);

  // ============================================================================
  // Animations
  // ============================================================================

  const runEntranceAnimation = useCallback(
    (position: string) => {
      const cfg = getAnimationConfig(position);
      translateXAnim.setValue(cfg.tx);
      translateYAnim.setValue(cfg.ty);
      scaleAnim.setValue(cfg.type === 'scale' ? 0.8 : 1);
      fadeAnim.setValue(0);

      const anims: Animated.CompositeAnimation[] = [
        Animated.timing(fadeAnim, { toValue: 1, duration: 300, useNativeDriver: false }),
      ];

      if (cfg.type === 'slide') {
        anims.push(
          Animated.spring(translateXAnim, { toValue: 0, tension: 50, friction: 8, useNativeDriver: false }),
          Animated.spring(translateYAnim, { toValue: 0, tension: 50, friction: 8, useNativeDriver: false })
        );
      } else {
        anims.push(
          Animated.spring(scaleAnim, { toValue: 1, tension: 50, friction: 8, useNativeDriver: false })
        );
      }

      Animated.parallel(anims).start();
    },
    [fadeAnim, scaleAnim, translateXAnim, translateYAnim]
  );

  const runExitAnimation = useCallback(
    (onDone: () => void, pos: string) => {
      const cfg = getAnimationConfig(pos);
      const anims: Animated.CompositeAnimation[] = [
        Animated.timing(fadeAnim, { toValue: 0, duration: 250, useNativeDriver: false }),
      ];

      if (cfg.type === 'slide') {
        anims.push(
          Animated.spring(translateXAnim, { toValue: cfg.tx, tension: 50, friction: 8, useNativeDriver: false }),
          Animated.spring(translateYAnim, { toValue: cfg.ty, tension: 50, friction: 8, useNativeDriver: false })
        );
      } else {
        anims.push(
          Animated.spring(scaleAnim, { toValue: 0.8, tension: 50, friction: 8, useNativeDriver: false })
        );
      }

      Animated.parallel(anims).start(() => onDone());
    },
    [fadeAnim, scaleAnim, translateXAnim, translateYAnim]
  );

  // ============================================================================
  // Close handler
  // ============================================================================

  // Keep a stable ref to the current formPayload so handleClose can read the
  // position without capturing a stale closure value.
  const formPayloadForCloseRef = useRef<ShowFormPayload | null>(null);

  const clearModalState = useCallback(() => {
    setVisible(false);
    bridge.webViewReadyRef.current = false;
    bridge.setWebViewReady(false);
    bridge.setFormPayload(null);
    setIsClosing(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClose = useCallback((options?: { immediate?: boolean }) => {
    if (isClosing) return;
    setIsClosing(true);
    const generation = ++closeGenerationRef.current;
    Encatch.setFormVisible(false);

    if (options?.immediate) {
      fadeAnim.stopAnimation();
      scaleAnim.stopAnimation();
      translateXAnim.stopAnimation();
      translateYAnim.stopAnimation();
      clearModalState();
      return;
    }

    const pos = resolveLayoutPosition(formPayloadForCloseRef.current?.formConfig);
    runExitAnimation(() => {
      if (closeGenerationRef.current !== generation) return;
      clearModalState();
    }, pos);
  }, [isClosing, runExitAnimation, resolveLayoutPosition, fadeAnim, scaleAnim, translateXAnim, translateYAnim, clearModalState]);

  // ============================================================================
  // Shared WebView bridge hook
  // ============================================================================

  const bridge = useEncatchFormWebView({
    logTag: 'EncatchWebView',
    onClose: handleClose,
    onHeightChange: updateHeight,
    onForceFullHeight: (force) => {
      setForceFullHeight(force);
      forceFullHeightRef.current = force;
    },
    // Entrance animation fires immediately on showForm (below), so onReady is
    // a no-op here — it simply lets handleFormReady mark webViewReady = true,
    // which removes the skeleton overlay.
    onReady: () => {},
  });

  // Keep formPayloadForCloseRef in sync with bridge.formPayload.
  formPayloadForCloseRef.current = bridge.formPayload;

  // ============================================================================
  // Derived layout values
  // ============================================================================

  const formConfig = bridge.formPayload?.formConfig;
  const effectivePosition = useMemo(
    () => resolveLayoutPosition(formConfig),
    [formConfig, resolveLayoutPosition]
  );
  const isFullCenter = effectivePosition === 'full-center';
  isFullCenterRef.current = isFullCenter;

  const inAppSize = useMemo(
    () => resolveInAppSizeFromFormConfig(formConfig),
    [formConfig]
  );

  const { popupBgColor, activeMode, modalOverlayBackgroundColor, darkOverlay } = useMemo(() => {
    const appearanceProperties = (formPayloadForCloseRef.current?.formConfig as any)?.appearanceProperties;
    const payloadTheme = formPayloadForCloseRef.current?.theme;
    const shareableMode = appearanceProperties?.featureSettings?.shareableMode as string | undefined;
    const effectiveMode = payloadTheme ?? shareableMode;
    const activeMode = resolveActiveMode(effectiveMode, systemColorScheme);
    const themeJson = appearanceProperties?.themes?.[activeMode]?.theme as string | undefined;
    const fallback = activeMode === 'dark' ? '#1a1a1a' : '#ffffff';
    const darkOverlay = resolveDarkOverlayFromFormConfig(formPayloadForCloseRef.current?.formConfig);
    return {
      popupBgColor: getBackgroundColor(themeJson, fallback),
      activeMode,
      darkOverlay,
      modalOverlayBackgroundColor: resolveModalOverlayBackgroundColor(
        formPayloadForCloseRef.current?.formConfig,
        activeMode,
        darkOverlay
      ),
    };
  }, [bridge.formPayload, systemColorScheme]);

  const horizontalSafeInset = Math.max(insets.left, insets.right);

  const popupWidth = useMemo(
    () =>
      resolveInAppMaxWidthPx(
        inAppSize,
        effectivePosition,
        screenWidth,
        isFullCenter ? 0 : horizontalSafeInset
      ),
    [inAppSize, effectivePosition, screenWidth, isFullCenter, horizontalSafeInset]
  );

  const maxHeightFractionValue = useMemo(() => {
    const raw = (formPayloadForCloseRef.current?.formConfig as any)?.appearanceProperties?.featureSettings?.maxDialogHeightPercentInApp;
    const fraction = typeof raw === 'number' ? raw / 100 : 0.8;
    return fraction;
  }, [bridge.formPayload]);

  // "Full" space available to the modal, ignoring the keyboard — top/bottom
  // safe-area insets removed, but not the IME. This is what maxHeightFraction
  // is measured against, so the popup's target size doesn't depend on whether
  // the keyboard happens to be up.
  //
  // `insets.bottom` also stands in for a persistent bottom system bar (e.g. a
  // gesture-navigation pill) that Android keeps reserved even while the IME is
  // showing. RN's `Keyboard` module only reports the IME's own height, so
  // without subtracting insets.bottom too, our container would end up sized a
  // few dozen px too tall while the keyboard is up — its lower edge would
  // overlap the real keyboard/nav-bar area. The WebView notices that overlap
  // (its internal visualViewport shrinks to compensate) while our layout-side
  // height would not, so the two disagree: content sized against
  // `100%`/layout-viewport (headers, footers) ends up positioned outside
  // what's actually visible, appearing to "scroll away".
  const usableHeightFull = useMemo(
    () => Math.max(screenHeight - insets.top - insets.bottom, 100),
    [screenHeight, insets]
  );

  // The RN <Modal> renders in its own Android window. We render it
  // edge-to-edge (navigationBarTranslucent), so it is normally not shrunk for
  // the IME, and on both platforms we manually subtract the measured keyboard
  // height to know how much room is actually left above it. (When Android does
  // resize the window anyway, the overlay shrinks by the same amount, so this
  // budget is still correct — only the lift offset below must be skipped.)
  const usableHeight = useMemo(() => {
    const h = isKeyboardVisible ? usableHeightFull - keyboardHeight : usableHeightFull;
    return Math.max(h, 100);
  }, [isKeyboardVisible, usableHeightFull, keyboardHeight]);

  // The popup's target height is maxHeightFraction of the FULL screen (not of
  // the keyboard-reduced space) — so it keeps the same absolute size it had
  // before the keyboard opened, as long as that still fits above the keyboard.
  // If it doesn't fit, fall back to using all of the remaining space above the
  // keyboard (100% of it) rather than only maxHeightFraction of an
  // already-shrunk area, which would waste room unnecessarily.
  const fullScreenTarget = usableHeightFull * maxHeightFractionValue;
  const maxDialogHeight = isKeyboardVisible
    ? Math.min(fullScreenTarget, usableHeight)
    : fullScreenTarget;
  const forcedHeight = usableHeight * 0.95;
  const usesFixedViewportHeight = forceFullHeight;

  // Keep the ref in sync so debounced updateHeight can access it without stale closures.
  maxDialogHeightRef.current = isFullCenter ? usableHeight : maxDialogHeight;

  // Re-sync the popup height whenever the available space changes (keyboard
  // show/hide, orientation change, etc.) — not just when the WebView sends a
  // new form:resize message. Without this, the popup would only ever shrink
  // when a resize happened to fire mid-keyboard-animation, and would never
  // grow back to fill 75% of the screen once the keyboard closes.
  useEffect(() => {
    if (forceFullHeightRef.current || isFullCenterRef.current) return;
    const content = lastContentHeightRef.current;
    if (content <= 0) return;
    applyPopupHeight(content, { animate: false, reason: 'keyboard-or-viewport-change' });
  }, [maxDialogHeight, applyPopupHeight]);

  // ============================================================================
  // Orientation tracking
  // ============================================================================

  useEffect(() => {
    const sub = Dimensions.addEventListener('change', ({ window }) => {
      setScreenWidth(window.width);
      setScreenHeight(window.height);
      overlayBaselineHeightRef.current = 0;
    });
    return () => sub.remove();
  }, []);

  // ============================================================================
  // Keyboard visibility tracking
  // ============================================================================

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      traceFormResize(Encatch.debugMode, 'EncatchWebView', 'keyboard-show', {
        keyboardHeight: e.endCoordinates.height,
        screenHeight,
        platform: Platform.OS,
      });
      setKeyboardHeight(e.endCoordinates.height);
      setIsKeyboardVisible(true);
      if (Platform.OS === 'ios') {
        startKeyboardSettle(250);
      }
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      traceFormResize(Encatch.debugMode, 'EncatchWebView', 'keyboard-hide', {
        screenHeight,
        platform: Platform.OS,
      });
      setKeyboardHeight(0);
      setIsKeyboardVisible(false);
      startKeyboardSettle(350);
      traceFormResize(Encatch.debugMode, 'EncatchWebView', 'keyboard-settle', {
        settleMs: 350,
      });
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, [screenHeight, startKeyboardSettle]);

  // ============================================================================
  // Internal emitter listeners — modal only, filter inline events
  // ============================================================================

  useEffect(() => {
    const onShowForm = (payload: ShowFormPayload) => {
      if (payload.presentation === 'inline') {
        // An inline slot is handling this form — clear any active modal state.
        if (visible) {
          closeGenerationRef.current += 1;
          fadeAnim.stopAnimation();
          scaleAnim.stopAnimation();
          translateXAnim.stopAnimation();
          translateYAnim.stopAnimation();
          setVisible(false);
          setIsClosing(false);
          bridge.setWebViewReady(false);
          bridge.webViewReadyRef.current = false;
          bridge.setFormPayload(null);
          Encatch.setFormVisible(false);
        }
        return;
      }

      // presentation === 'modal': replace any in-flight animation / form.
      closeGenerationRef.current += 1;
      fadeAnim.stopAnimation();
      scaleAnim.stopAnimation();
      translateXAnim.stopAnimation();
      translateYAnim.stopAnimation();
      bridge.setWebViewInstanceKey((key) => key + 1);
      bridge.setFormPayload(payload);
      setIsClosing(false);
      bridge.webViewReadyRef.current = false;
      bridge.setWebViewReady(false);
      setForceFullHeight(false);
      forceFullHeightRef.current = false;
      lastAppliedHeightRef.current = 0;
      lastContentHeightRef.current = 0;
      keyboardSettleUntilRef.current = 0;
      if (keyboardSettleTimerRef.current) {
        clearTimeout(keyboardSettleTimerRef.current);
        keyboardSettleTimerRef.current = null;
      }
      overlayBaselineHeightRef.current = 0;
      setOverlayHeight(0);
      fadeAnim.setValue(0);
      setVisible(true);
      animatedHeight.setValue(300);
      Encatch.setFormVisible(true);
      // Animate the card in immediately so the user sees the skeleton rather
      // than a fully invisible modal while the WebView boots.
      const pos = resolveLayoutPosition(payload.formConfig);
      isFullCenterRef.current = pos === 'full-center';
      runEntranceAnimation(pos);
    };

    const onDismissForm = () => {
      if (!visible) return;
      const pos = resolveLayoutPosition(formPayloadForCloseRef.current?.formConfig);
      const generation = ++closeGenerationRef.current;
      setIsClosing(true);
      Encatch.setFormVisible(false);
      runExitAnimation(() => {
        if (closeGenerationRef.current !== generation) return;
        setVisible(false);
        bridge.webViewReadyRef.current = false;
        bridge.setWebViewReady(false);
        bridge.setFormPayload(null);
        setIsClosing(false);
      }, pos);
    };

    _internalEmitter.on('showForm', onShowForm);
    _internalEmitter.on('dismissForm', onDismissForm);

    return () => {
      _internalEmitter.off('showForm', onShowForm);
      _internalEmitter.off('dismissForm', onDismissForm);
    };
  }, [visible, runEntranceAnimation, runExitAnimation, resolveLayoutPosition, screenWidth, animatedHeight, bridge, fadeAnim, scaleAnim, translateXAnim, translateYAnim, formPayloadForCloseRef]);

  // ============================================================================
  // Styles
  // ============================================================================

  const { justifyContent, alignItems } = useMemo(
    () => getPositionLayout(effectivePosition),
    [effectivePosition]
  );
  const corners = useMemo(
    () => resolveCornersFromFormConfig(formConfig),
    [formConfig]
  );
  const borderRadii = useMemo(
    () => getBorderRadii(effectivePosition, corners),
    [effectivePosition, corners]
  );

  // While the keyboard is visible, drop the bottom safe-area edge on both
  // platforms — the manual keyboard offset below already accounts for the
  // occluded space, so adding the nav/gesture-bar inset on top would leave
  // an extra gap (or double-count it once the keyboard closes and edges
  // flip back).
  const safeAreaEdges = useMemo((): ('top' | 'bottom' | 'left' | 'right')[] => {
    if (isFullCenter) {
      return isKeyboardVisible ? ['top'] : ['top', 'bottom'];
    }
    if (isKeyboardVisible) {
      return ['top', 'left', 'right'];
    }
    return ['top', 'bottom', 'left', 'right'];
  }, [isFullCenter, isKeyboardVisible]);

  // iOS gets its keyboard-avoidance from <KeyboardAvoidingView behavior="padding">
  // below (enabled only on iOS). On Android, KeyboardAvoidingView's
  // "height"/"position" behaviors are known to jitter inside a Modal, so we
  // lift the popup manually instead by padding the bottom of the flex
  // container by the measured keyboard height. Include insets.bottom
  // (gesture-nav/system bar) in the lift amount too — see usableHeight comment
  // above for why keyboardHeight alone under-counts it.
  //
  // The edge-to-edge Modal window is normally not resized for the IME, but RN
  // sets SOFT_INPUT_ADJUST_RESIZE on it, and RN versions without
  // navigationBarTranslucent (or OEM quirks) can still shrink it. If the
  // overlay has already shrunk by a meaningful part of the keyboard height,
  // the system did the lift for us — adding our own on top would push the
  // popup a full keyboard-height too high (behind the status bar).
  const overlayShrink =
    overlayBaselineHeightRef.current > 0 && overlayHeight > 0
      ? overlayBaselineHeightRef.current - overlayHeight
      : 0;
  const modalWindowResizedForKeyboard =
    isKeyboardVisible && keyboardHeight > 0 && overlayShrink >= keyboardHeight * 0.5;
  const androidKeyboardOffset =
    Platform.OS === 'android' && isKeyboardVisible && !modalWindowResizedForKeyboard
      ? keyboardHeight + insets.bottom
      : 0;

  const handleOverlayLayout = useCallback((e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    if (h > overlayBaselineHeightRef.current) {
      overlayBaselineHeightRef.current = h;
    }
    setOverlayHeight(h);
  }, []);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        overlay: {
          flex: 1,
          // darkOverlay off → transparent but modal still blocks touches (unlike web).
          backgroundColor: modalOverlayBackgroundColor,
        },
        popupShell: {
          ...borderRadii,
        },
        popupContainer: {
          ...borderRadii,
          overflow: 'hidden',
          backgroundColor: popupBgColor,
          flex: 1,
        },
        popupContainerStandalone: {
          ...borderRadii,
          overflow: 'hidden',
          maxHeight: isFullCenter ? undefined : usesFixedViewportHeight ? forcedHeight : maxDialogHeight,
          backgroundColor: popupBgColor,
        },
      }),
    [modalOverlayBackgroundColor, popupBgColor, borderRadii, isFullCenter, usesFixedViewportHeight, forcedHeight, maxDialogHeight]
  );

  const modalCardTransform = useMemo(
    () => [
      { scaleX: scaleAnim },
      { scaleY: scaleAnim },
      { translateX: translateXAnim },
      { translateY: translateYAnim },
    ],
    [scaleAnim, translateXAnim, translateYAnim]
  );

  const modalCardLayoutStyle = useMemo(
    () => ({
      height: usesFixedViewportHeight ? forcedHeight : animatedHeight,
      width: popupWidth,
      maxHeight: usesFixedViewportHeight ? forcedHeight : maxDialogHeight,
    }),
    [usesFixedViewportHeight, forcedHeight, animatedHeight, popupWidth, maxDialogHeight]
  );

  // ============================================================================
  // Render
  // ============================================================================

  if (!bridge.formPayload) return null;

  const popupChrome = (
    <>
      <WebView
        ref={bridge.webViewRef}
        key={bridge.webViewInstanceKey}
        source={{ uri: bridge.webViewUrl }}
        onMessage={bridge.handleWebViewMessage}
        onShouldStartLoadWithRequest={bridge.handleShouldStartLoad}
        onLoad={() => {
          setTimeout(() => {
            if (!bridge.webViewReadyRef.current) {
              console.log('[EncatchWebView] form:ready not received after load - triggering fallback');
              bridge.handleFormReady();
            }
          }, 300);
        }}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="compatibility"
        scrollEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
        style={{ flex: 1, backgroundColor: popupBgColor, ...borderRadii }}
        containerStyle={{ flex: 1, backgroundColor: popupBgColor, ...borderRadii }}
        onError={(e) => console.warn('[EncatchWebView] Load error:', e.nativeEvent)}
        onHttpError={(e) => console.warn('[EncatchWebView] HTTP error:', e.nativeEvent.statusCode, e.nativeEvent.url)}
      />
      {!bridge.webViewReady && (
        <View pointerEvents="auto" style={StyleSheet.absoluteFillObject}>
          <FormWebViewSkeleton backgroundColor={popupBgColor} activeMode={activeMode} />
        </View>
      )}
    </>
  );

  return (
    // Modal gives us true app-level stacking (above navigators, drawers, etc.)
    // and handles the Android hardware back button via onRequestClose.
    // animationType="none" because we run our own animated entrance/exit.
    // statusBarTranslucent lets the backdrop cover the Android status bar.
    // navigationBarTranslucent makes RN draw the Modal's dialog window
    // edge-to-edge (decorFitsSystemWindows=false). Without it, on hosts that
    // are not edge-to-edge (targetSdk < 35 or Android < 15 with RN's
    // edgeToEdgeEnabled off) the dialog window keeps decorFitsSystemWindows=true
    // and RN's SOFT_INPUT_ADJUST_RESIZE shrinks it by the keyboard height —
    // on top of our own androidKeyboardOffset, pushing the popup up past the
    // status bar. Older RN versions ignore the prop; the onLayout-based
    // resize detection below covers them.
    <Modal
      visible={visible && !!bridge.formPayload}
      transparent
      animationType="none"
      onRequestClose={() => handleClose()}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <Animated.View
        style={[styles.overlay, { opacity: fadeAnim }]}
        onLayout={handleOverlayLayout}
        // Always capture touches while the modal is open (RN cannot pass through like web).
        pointerEvents={visible && !isClosing ? 'auto' : 'none'}
      >
        {!darkOverlay && <ModalBackdropBlur activeMode={activeMode} />}
        <SafeAreaView style={{ flex: 1 }} edges={safeAreaEdges}>
        {/* KeyboardAvoidingView pushes the popup above the keyboard on iOS.
            On Android, the nested View's androidKeyboardOffset (paddingBottom)
            does the same job manually, since the edge-to-edge Modal window is
            normally not resized/padded by the system (see
            modalWindowResizedForKeyboard for when it is) and
            KeyboardAvoidingView's non-iOS behaviors jitter here.
            IMPORTANT: the padding must live on a View *inside*
            KeyboardAvoidingView, not on KeyboardAvoidingView's own `style`
            prop — with behavior="padding", RN always overwrites
            style.paddingBottom with its own (0 when disabled) computed value,
            which was silently discarding this offset and leaving the popup
            pinned to the very bottom of the screen, hidden behind the keyboard.
            SafeAreaView keeps the popup below the status bar / above the nav bar.
            The dim backdrop still covers the full screen including system bars. */}
        <KeyboardAvoidingView
          enabled={Platform.OS === 'ios'}
          behavior="padding"
          keyboardVerticalOffset={0}
          style={{ flex: 1 }}
        >
          <View
            style={{
              flex: 1,
              paddingBottom: androidKeyboardOffset,
              justifyContent: isFullCenter ? 'flex-start' : justifyContent,
              alignItems: isFullCenter ? 'stretch' : alignItems,
            }}
          >
          <Animated.View
            style={
              isFullCenter
                ? [
                    styles.popupContainerStandalone,
                    {
                      flex: 1,
                      width: '100%',
                      alignSelf: 'stretch',
                      transform: modalCardTransform,
                    },
                  ]
                : [
                    styles.popupShell,
                    getModalPopupShadowStyle(),
                    modalCardLayoutStyle,
                    { transform: modalCardTransform },
                  ]
            }
          >
            {isFullCenter ? (
              popupChrome
            ) : (
              <Animated.View style={styles.popupContainer}>{popupChrome}</Animated.View>
            )}
          </Animated.View>
          </View>
        </KeyboardAvoidingView>
        </SafeAreaView>
      </Animated.View>
      </SafeAreaProvider>
    </Modal>
  );
};

// ============================================================================
// Public export
// ============================================================================

/**
 * Wraps the inner implementation in a SafeAreaProvider so the SDK is
 * self-contained — host apps that already have a SafeAreaProvider at the
 * root are unaffected (nested providers are safe per library docs).
 *
 * initialMetrics seeds the provider with the current window metrics so
 * insets are valid on the very first frame inside the Modal, avoiding the
 * zero-inset flicker that can occur when the provider mounts cold.
 */
export const EncatchWebView: React.FC = () => (
  <SafeAreaProvider
    initialMetrics={initialWindowMetrics}
    pointerEvents="box-none"
    style={hostStyles.safeAreaProvider}
  >
    <EncatchWebViewInner />
  </SafeAreaProvider>
);

const hostStyles = StyleSheet.create({
  // Keep the SDK host mounted for event subscriptions without taking space in
  // the host app's layout. The actual form UI is rendered through Modal.
  safeAreaProvider: {
    ...StyleSheet.absoluteFillObject,
  },
});

export default EncatchWebView;
