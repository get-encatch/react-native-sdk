/**
 * Optional frosted backdrop for modal overlays when darkOverlay is off.
 * Uses expo-blur when installed; no-ops otherwise.
 */
import React from 'react';
import { Platform, StyleSheet } from 'react-native';

type BlurViewProps = {
  intensity?: number;
  tint?: 'light' | 'dark' | 'default';
  style?: object;
  pointerEvents?: 'none' | 'auto' | 'box-none' | 'box-only';
  experimentalBlurMethod?: 'none' | 'dimezisBlurView';
};

type BlurViewComponent = React.ComponentType<BlurViewProps>;

let cachedBlurView: BlurViewComponent | null | undefined;

function loadBlurView(): BlurViewComponent | null {
  if (cachedBlurView !== undefined) return cachedBlurView;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedBlurView = (require('../optional/expo-blur.js')?.BlurView as BlurViewComponent | undefined) ?? null;
  } catch {
    cachedBlurView = null;
  }
  return cachedBlurView;
}

/** Frosted backdrop when darkOverlay is off (expo-blur intensity 0–100). */
export const MODAL_BACKDROP_BLUR_INTENSITY = Platform.OS === 'android' ? 72 : 52;

export const ModalBackdropBlur: React.FC<{
  activeMode: 'light' | 'dark';
}> = ({ activeMode }) => {
  const BlurView = loadBlurView();
  if (!BlurView) return null;

  return (
    <BlurView
      intensity={MODAL_BACKDROP_BLUR_INTENSITY}
      tint={activeMode === 'dark' ? 'dark' : 'light'}
      pointerEvents="none"
      {...(Platform.OS === 'android'
        ? { experimentalBlurMethod: 'dimezisBlurView' as const }
        : {})}
      style={StyleSheet.absoluteFillObject}
    />
  );
};
