/**
 * ScrollView shell for inline EncatchInlineForm demo tabs.
 *
 * Pair with EncatchInlineForm (fixed WebView height; host owns keyboard scroll).
 * Do not wrap in KeyboardAvoidingView — use automaticallyAdjustKeyboardInsets only.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  Keyboard,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type InlineFormScrollScreenProps = {
  backgroundColor: string;
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Y offset of the inline form within scroll content — wrap form in onLayout to set this. */
  getFormScrollY?: () => number;
  /** Receives scrollToForm — pass to EncatchInlineForm onOverlayOpenChange. */
  onScrollToFormReady?: (scrollToForm: () => void) => void;
  children: ReactNode;
};

export function InlineFormScrollScreen({
  backgroundColor,
  contentContainerStyle,
  getFormScrollY,
  onScrollToFormReady,
  children,
}: InlineFormScrollScreenProps) {
  const scrollRef = useRef<ScrollView>(null);
  const getFormScrollYRef = useRef(getFormScrollY);
  getFormScrollYRef.current = getFormScrollY;

  const scrollFormIntoView = useCallback(() => {
    requestAnimationFrame(() => {
      const y = getFormScrollYRef.current?.() ?? 0;
      scrollRef.current?.scrollTo({
        y: Math.max(0, y - 24),
        animated: true,
      });
    });
  }, []);

  useEffect(() => {
    onScrollToFormReady?.(scrollFormIntoView);
  }, [onScrollToFormReady, scrollFormIntoView]);

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardDidShow', () => {
      setTimeout(scrollFormIntoView, 100);
    });
    return () => showSub.remove();
  }, [scrollFormIntoView]);

  return (
    <View style={[styles.flex, { backgroundColor }]}>
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={contentContainerStyle}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive">
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
