/**
 * Theme-aware WebView loading overlay.
 *
 * FormWebViewSkeleton is used as an absoluteFill overlay on top of the WebView,
 * covering the full loading gap: from component mount through the native HTTP
 * fetch, through JS/CSS initialisation, until form:ready fires and
 * webViewReady becomes true.
 *
 * createFormWebViewRenderLoading is kept for API compatibility but is no
 * longer passed to the WebView's renderLoading prop — the overlay replaces it.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

export interface FormWebViewLoadingProps {
  backgroundColor: string;
  activeMode: 'light' | 'dark';
}

// ============================================================================
// Skeleton
// ============================================================================

export function FormWebViewSkeleton({
  backgroundColor,
  activeMode,
}: FormWebViewLoadingProps): React.ReactElement {
  const pulseAnim = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0.4,
          duration: 700,
          useNativeDriver: true,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulseAnim]);

  const rowColor =
    activeMode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)';

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <Animated.View style={{ opacity: pulseAnim, width: '100%' }}>
        {/* Header bar */}
        <View style={[styles.headerBar, { backgroundColor: rowColor }]} />

        {/* Question text rows */}
        <View style={[styles.textRowWide, { backgroundColor: rowColor }]} />
        <View style={[styles.textRowNarrow, { backgroundColor: rowColor }]} />

        {/* Input field placeholder */}
        <View style={[styles.inputBlock, { backgroundColor: rowColor }]} />

        {/* Button placeholder */}
        <View style={[styles.buttonBlock, { backgroundColor: rowColor }]} />
      </Animated.View>
    </View>
  );
}

// ============================================================================
// Legacy factory — kept for API compatibility
// ============================================================================

export function FormWebViewLoading(props: FormWebViewLoadingProps): React.ReactElement {
  return <FormWebViewSkeleton {...props} />;
}

export function createFormWebViewRenderLoading(
  backgroundColor: string,
  activeMode: 'light' | 'dark'
): () => React.ReactElement {
  return () => <FormWebViewSkeleton backgroundColor={backgroundColor} activeMode={activeMode} />;
}

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 28,
  },
  // ~16 px tall, 60 % wide — simulates a form section title
  headerBar: {
    height: 16,
    width: '60%',
    borderRadius: 8,
    marginBottom: 24,
  },
  // ~12 px tall, 90 % wide — first line of question text
  textRowWide: {
    height: 12,
    width: '90%',
    borderRadius: 6,
    marginBottom: 10,
  },
  // ~12 px tall, 65 % wide — second line of question text
  textRowNarrow: {
    height: 12,
    width: '65%',
    borderRadius: 6,
    marginBottom: 24,
  },
  // ~44 px tall, full width — simulates an input or answer option block
  inputBlock: {
    height: 44,
    width: '100%',
    borderRadius: 10,
    marginBottom: 20,
  },
  // ~44 px tall, 50 % wide, centred — simulates the primary action button
  buttonBlock: {
    height: 44,
    width: '50%',
    borderRadius: 10,
    alignSelf: 'center',
  },
});
