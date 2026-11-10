const insets = { top: 0, bottom: 0, left: 0, right: 0 };
export const SafeAreaProvider = ({ children }: { children?: unknown }) => children ?? null;
// Renders its children, so content inside it (such as the modal form's WebView) mounts in tests.
export const SafeAreaView = ({ children }: { children?: unknown }) => children ?? null;
export const initialWindowMetrics = { insets, frame: { x: 0, y: 0, width: 390, height: 844 } };
export const useSafeAreaInsets = () => insets;
