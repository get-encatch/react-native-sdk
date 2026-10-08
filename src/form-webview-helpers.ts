/**
 * Shared helpers used by both EncatchWebView (modal) and EncatchInlineForm (inline).
 */
import { Platform, type ColorSchemeName, type ViewStyle } from 'react-native';

// ============================================================================
// Color utilities
// ============================================================================

export function hexWithAlpha(hex: string, alphaHex = '4D'): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 6) return `#${h}${alphaHex}`;
  if (h.length === 8) return `#${h}`;
  return `#000000${alphaHex}`;
}

/**
 * React Native View backgroundColor only accepts hex, rgb(a), hsl(a), and named colors.
 * Form themes store shadcn tokens as oklch(...) which RN silently ignores (shows white).
 */
function isReactNativeColor(value: string): boolean {
  const v = value.trim();
  if (/^#[0-9A-Fa-f]{3,8}$/.test(v)) return true;
  if (/^(rgb|rgba|hsl|hsla)\(/i.test(v)) return true;
  return false;
}

export function normalizeColorForNative(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return isReactNativeColor(trimmed) ? trimmed : fallback;
}

/**
 * Extracts --background (falling back to --popover) from the shadcn-variables
 * JSON string stored in themes[mode].theme and normalizes it to a React Native
 * compatible color value (hex / rgb / rgba / hsl).
 */
export function getBackgroundColor(themeJson: string | undefined, fallback: string): string {
  if (!themeJson || themeJson === '{}') return fallback;
  try {
    const vars = JSON.parse(themeJson) as Record<string, string>;
    const value = vars['--background'] ?? vars['--popover'];
    if (typeof value !== 'string' || value.length === 0) return fallback;
    return normalizeColorForNative(value, fallback);
  } catch {
    return fallback;
  }
}

export function resolveSystemColorScheme(scheme: ColorSchemeName | null | undefined): 'light' | 'dark' {
  return scheme === 'dark' ? 'dark' : 'light';
}

/**
 * Resolves which theme mode ("light" | "dark") is active for the form.
 * Respects the form's shareableMode setting first, then falls back to
 * the device's system color scheme.
 */
export function resolveActiveMode(
  shareableMode: string | undefined,
  systemScheme: 'light' | 'dark'
): 'light' | 'dark' {
  if (shareableMode === 'light') return 'light';
  if (shareableMode === 'dark') return 'dark';
  return systemScheme === 'dark' ? 'dark' : 'light';
}

const DEFAULT_OVERLAY_RGBA = 'rgba(0, 0, 0, 0.5)';
/** Matches shareable encatch.ts OVERLAY_OPACITY fallback for colors without explicit alpha. */
const OVERLAY_FALLBACK_ALPHA = 0.4;

type ThemeModeConfig = {
  theme?: string;
  overlayColor?: string;
};

/**
 * Reads inApp.darkOverlay with legacy featureSettings.darkOverlay fallback.
 */
export function resolveDarkOverlayFromFormConfig(
  formConfig: { appearanceProperties?: Record<string, unknown> } | undefined
): boolean {
  const appearanceProperties = formConfig?.appearanceProperties;
  const inApp = appearanceProperties?.inApp as { darkOverlay?: boolean } | undefined;
  const featureSettings = appearanceProperties?.featureSettings as { darkOverlay?: boolean } | undefined;
  return (inApp?.darkOverlay ?? featureSettings?.darkOverlay) === true;
}

/**
 * Overlay base color from theme JSON — aligned with shareable encatch.ts getOverlayColorFromTheme().
 */
export function getOverlayColorFromTheme(themeConfig: ThemeModeConfig | undefined): string {
  if (themeConfig?.overlayColor) {
    return themeConfig.overlayColor;
  }

  const themeJson = themeConfig?.theme;
  if (themeJson == null || themeJson === '' || themeJson === '{}') {
    return DEFAULT_OVERLAY_RGBA;
  }

  try {
    const vars = JSON.parse(themeJson) as Record<string, string>;
    const color =
      vars['overlayColor'] ??
      vars['--encatch-overlay-color'] ??
      vars['--overlay'] ??
      vars['--popover'];
    return typeof color === 'string' && color.length > 0 ? color : DEFAULT_OVERLAY_RGBA;
  } catch {
    return DEFAULT_OVERLAY_RGBA;
  }
}

/**
 * Return rgba for modal backdrop. Preserves explicit alpha in rgba(...) or #RRGGBBAA;
 * otherwise applies fallbackAlpha — same rules as shareable encatch.ts withAlpha().
 */
export function colorWithAlpha(color: string, fallbackAlpha = OVERLAY_FALLBACK_ALPHA): string {
  const a = Math.max(0, Math.min(1, fallbackAlpha));
  const s = color.trim();

  const rgbaMatch = s.match(/^rgba\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i);
  if (rgbaMatch) {
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${rgbaMatch[4]})`;
  }

  const rgbMatch = s.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${a})`;
  }

  const hexMatch = s.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) {
      hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const alpha = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : a;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  return `rgba(0, 0, 0, ${a})`;
}

/**
 * Modal backdrop color when darkOverlay is enabled; transparent when disabled.
 * RN always keeps pointer-events on the modal shell (unlike web pointer-events: none).
 */
export function resolveModalOverlayBackgroundColor(
  formConfig: { appearanceProperties?: Record<string, unknown> } | undefined,
  activeMode: 'light' | 'dark',
  darkOverlay: boolean
): string {
  if (!darkOverlay) return 'transparent';

  const themes = formConfig?.appearanceProperties?.themes as
    | { light?: ThemeModeConfig; dark?: ThemeModeConfig }
    | undefined;
  const base = getOverlayColorFromTheme(themes?.[activeMode]);
  return normalizeColorForNative(colorWithAlpha(base), DEFAULT_OVERLAY_RGBA);
}

export function uploadMimeType(mimeType: string | undefined): string {
  const baseMimeType = mimeType?.split(';')[0]?.trim();
  return baseMimeType || 'application/octet-stream';
}

// ============================================================================
// Modal-specific layout helpers (kept here so both EncatchWebView and tests
// can import them cleanly, but not needed by the inline presenter)
// ============================================================================

/** Corner roundness preset — matches web-form-engine-core and iframe-manager. */
export type CornerStyle = 'sharp' | 'soft' | 'round';

/** In-app content width preset — matches web-form-engine-core and iframe-manager. */
export type InAppSize = 'compact' | 'standard' | 'spacious';

/** Matches iframe-manager mobile breakpoint (window.innerWidth < 600). */
export const IN_APP_MOBILE_BREAKPOINT_PX = 600;

export type PopupBorderRadii = {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
};

/**
 * Maps corners preset to px (24px = 1.5rem for round), aligned with App.svelte resolveRadius().
 */
export function resolveCornerRadiusPx(corners: CornerStyle): number {
  if (corners === 'sharp') return 2;
  if (corners === 'round') return 24;
  return 10;
}

/**
 * Reads appearance.appearance.corners with legacy featureSettings.corners fallback.
 */
export function resolveCornersFromFormConfig(
  formConfig: { appearanceProperties?: Record<string, unknown> } | undefined
): CornerStyle {
  const appearanceProperties = formConfig?.appearanceProperties;
  const appearance = appearanceProperties?.appearance as { corners?: string } | undefined;
  const featureSettings = appearanceProperties?.featureSettings as { corners?: string } | undefined;
  const value = appearance?.corners ?? featureSettings?.corners;
  if (value === 'sharp' || value === 'soft' || value === 'round') return value;
  return 'soft';
}

/**
 * Reads inApp.size with legacy featureSettings.inAppSize fallback.
 */
export function resolveInAppSizeFromFormConfig(
  formConfig: { appearanceProperties?: Record<string, unknown> } | undefined
): InAppSize {
  const appearanceProperties = formConfig?.appearanceProperties;
  const inApp = appearanceProperties?.inApp as { size?: string } | undefined;
  const featureSettings = appearanceProperties?.featureSettings as { inAppSize?: string } | undefined;
  const value = inApp?.size ?? featureSettings?.inAppSize;
  if (value === 'compact' || value === 'spacious') return value;
  return 'standard';
}

/**
 * Reads inApp.position with legacy selectedPosition fallback.
 */
export function resolveSelectedPositionFromFormConfig(
  formConfig: { appearanceProperties?: Record<string, unknown> } | undefined
): string {
  const appearanceProperties = formConfig?.appearanceProperties;
  const inApp = appearanceProperties?.inApp as { position?: string } | undefined;
  return (
    inApp?.position ??
    (appearanceProperties?.selectedPosition as string | undefined) ??
    'middle-center'
  );
}

export function isMobileLayout(screenWidth: number): boolean {
  return screenWidth < IN_APP_MOBILE_BREAKPOINT_PX;
}

/**
 * Collapse left/right anchors to center on mobile — matches iframe-manager normalizePosition().
 */
export function normalizePosition(position: string, screenWidth: number): string {
  if (position === 'full-center' || position === 'full') return 'full-center';
  if (!isMobileLayout(screenWidth)) return position;
  if (position.startsWith('top')) return 'top-center';
  if (position.startsWith('bottom')) return 'bottom-center';
  return 'middle-center';
}

export function isCenterAlignedPosition(position: string): boolean {
  return position.endsWith('-center') || position === 'center';
}

/**
 * Popup shell max-width in px — aligned with iframe-manager getInAppMaxWidth().
 * full-center fills the safe-area box (100% width, flex height); content width is set in the form engine.
 */
export function resolveInAppMaxWidthPx(
  size: InAppSize,
  position: string,
  screenWidth: number,
  horizontalInsetPx = 0
): number {
  const available = Math.max(screenWidth - horizontalInsetPx * 2, 100);
  if (position === 'full-center') return available;

  const centered = isCenterAlignedPosition(position);
  const presetWidth = centered
    ? size === 'compact'
      ? 480
      : size === 'spacious'
        ? 720
        : 600
    : size === 'compact'
      ? 320
      : size === 'spacious'
        ? 500
        : 400;

  // Match iframe-manager: preset only, capped by available viewport (no legacy % cap).
  return Math.min(presetWidth, available);
}

export function getPositionLayout(position: string) {
  let justifyContent: 'flex-start' | 'flex-end' | 'center' = 'center';
  let alignItems: 'flex-start' | 'flex-end' | 'center' = 'center';

  if (position.startsWith('top')) justifyContent = 'flex-start';
  else if (position.startsWith('bottom')) justifyContent = 'flex-end';

  if (position.endsWith('left')) alignItems = 'flex-start';
  else if (position.endsWith('right')) alignItems = 'flex-end';

  return { justifyContent, alignItems };
}

/**
 * Per-corner radii for the modal shell. Edges that touch the screen stay square (0);
 * other corners use the resolved corners preset radius.
 */
export function getBorderRadii(
  position: string,
  corners: CornerStyle = 'soft'
): PopupBorderRadii {
  if (position === 'full-center' || position === 'full') {
    return {
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
    };
  }

  const radius = resolveCornerRadiusPx(corners);
  const touchesTop = position.includes('top');
  const touchesBottom = position.includes('bottom');
  const touchesLeft = position.endsWith('left');
  const touchesRight = position.endsWith('right');

  return {
    borderTopLeftRadius: touchesTop || touchesLeft ? 0 : radius,
    borderTopRightRadius: touchesTop || touchesRight ? 0 : radius,
    borderBottomLeftRadius: touchesBottom || touchesLeft ? 0 : radius,
    borderBottomRightRadius: touchesBottom || touchesRight ? 0 : radius,
  };
}

/** Uniform radii for inline embeds — matches web-sdk iframe-manager inline innerWrapper. */
export function getInlineBorderRadii(corners: CornerStyle = 'soft'): PopupBorderRadii {
  const radius = resolveCornerRadiusPx(corners);
  return {
    borderTopLeftRadius: radius,
    borderTopRightRadius: radius,
    borderBottomLeftRadius: radius,
    borderBottomRightRadius: radius,
  };
}

/**
 * Modal card elevation — matches web-sdk iframe-manager:
 * box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3)
 * Not used for full-center or inline embeds.
 */
export function getModalPopupShadowStyle(): ViewStyle {
  return (
    Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 20 },
        shadowOpacity: 0.3,
        shadowRadius: 60,
      },
      android: {
        elevation: 20,
      },
      default: {},
    }) ?? {}
  );
}

export function getAnimationConfig(position: string) {
  if (position.startsWith('top')) {
    return { type: 'slide', tx: 0, ty: -100 };
  }
  if (position.startsWith('bottom')) {
    return { type: 'slide', tx: 0, ty: 100 };
  }
  if (position.endsWith('left')) {
    return { type: 'slide', tx: -100, ty: 0 };
  }
  if (position.endsWith('right')) {
    return { type: 'slide', tx: 100, ty: 0 };
  }
  return { type: 'scale', tx: 0, ty: 0 };
}

/**
 * Builds the WebView source URL for the react-native-sdk-form page.
 */
export function buildFormWebViewUrl(
  webHost: string,
  formId: string,
  instanceKey: number,
  debugMode: boolean,
  presentation?: 'inline' | 'modal'
): string {
  const params: Record<string, string> = {
    formId,
    ts: String(instanceKey),
  };
  if (debugMode) params.debug = 'true';
  if (presentation === 'inline') params.presentation = 'inline';
  return `${webHost}/s/react-native-sdk-form?${new URLSearchParams(params).toString()}`;
}
