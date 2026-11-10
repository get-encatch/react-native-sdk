type Listener = (state: string) => void;
const appStateListeners = new Set<Listener>();

export const AppState = {
  currentState: 'active',
  addEventListener(_type: string, listener: Listener) {
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  },
};

/** Test helper: simulate the app moving between background and foreground. */
export function __setAppState(state: string): void {
  AppState.currentState = state;
  for (const l of [...appStateListeners]) l(state);
}

export const Platform = {
  OS: 'ios',
  Version: '17.0',
  select<T>(spec: { ios?: T; default?: T }): T | undefined {
    return spec.ios ?? spec.default;
  },
};

export const Dimensions = {
  get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
  addEventListener: () => ({ remove() {} }),
};

export const Linking = {
  openURL: async (_url: string) => {},
  canOpenURL: async (_url: string) => true,
};

// UI stand-ins: the published bundle (test/characterization) imports these at
// module level. Tests never render components.
const Noop = () => null;
/** Layout stand-in: renders its children (so nested components, e.g. a WebView, appear in the tree). */
const PassThrough = ({ children }: { children?: unknown }) => (children ?? null) as any;
export const View = PassThrough;
export const Text = PassThrough;
export const Pressable = PassThrough;
export const Modal = PassThrough;
export const ActivityIndicator = Noop;
export const KeyboardAvoidingView = PassThrough;
export const StatusBar = { currentHeight: 0 };
export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  flatten: (s: unknown) => s,
  absoluteFill: {},
  absoluteFillObject: {},
  hairlineWidth: 1,
};
class AnimatedValue {
  constructor(public value: number) {}
  setValue(v: number) { this.value = v; }
  stopAnimation() {}
  interpolate() { return this; }
}
const anim = () => ({ start: (cb?: () => void) => cb?.(), stop() {} });
export const Animated = {
  Value: AnimatedValue,
  View: PassThrough,
  Text: PassThrough,
  timing: anim,
  spring: anim,
  parallel: anim,
  sequence: anim,
  loop: anim,
  delay: anim,
  stagger: anim,
  event: () => () => {},
  add: (a: unknown) => a,
  multiply: (a: unknown) => a,
  createAnimatedComponent: <T,>(c: T): T => c,
};
export const Easing = {
  linear: (t: number) => t,
  ease: (t: number) => t,
  in: (f: unknown) => f,
  out: (f: unknown) => f,
  inOut: (f: unknown) => f,
  bezier: () => (t: number) => t,
  cubic: (t: number) => t,
};
export const Keyboard = { addListener: () => ({ remove() {} }), dismiss() {} };
export const BackHandler = { addEventListener: () => ({ remove() {} }) };
export const useWindowDimensions = () => Dimensions.get();
export const Appearance = {
  getColorScheme: () => 'light' as const,
  addChangeListener: () => ({ remove() {} }),
};
export const useColorScheme = () => 'light' as const;
export const PixelRatio = { get: () => 3, roundToNearestPixel: (n: number) => n, getFontScale: () => 1 };
export const I18nManager = { isRTL: false };
