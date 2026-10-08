/**
 * Wildcard Inline tab
 *
 * Mounts <EncatchInlineForm /> with no formId (wildcard slot).
 * Any showForm() call that has no exact-match slot will render here.
 */
import { useCallback, useRef } from 'react';
import { StyleSheet, Pressable, View as RNView } from 'react-native';
import { Text, View } from '@/components/Themed';
import { FormIdPicker } from '@/components/FormIdPicker';
import { InlineFormScrollScreen } from '@/components/InlineFormScrollScreen';
import { useEncatch, EncatchInlineForm } from '@encatch/react-native-sdk';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { useActiveFormId } from '@/hooks/useActiveFormId';
import { useTesterConfig } from '@/contexts/TesterConfigContext';

export default function InlineWildcardScreen() {
  const { showForm } = useEncatch();
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];
  const { setFormId } = useTesterConfig();
  const {
    suggestedIds,
    manualFormId,
    setManualFormId,
    selectedFormId,
    setSelectedFormId,
    activeFormId,
  } = useActiveFormId();
  const scrollToFormRef = useRef<() => void>(() => {});
  const formScrollYRef = useRef(0);

  const handleFormIdChange = (next: string) => {
    if (suggestedIds.length > 1) {
      setSelectedFormId(next);
    } else {
      setManualFormId(next);
    }
    setFormId(next);
  };

  const formPickerValue = suggestedIds.length > 1 ? selectedFormId : manualFormId;

  const handleScrollToFormReady = useCallback((scrollToForm: () => void) => {
    scrollToFormRef.current = scrollToForm;
  }, []);

  const getFormScrollY = useCallback(() => formScrollYRef.current, []);

  return (
    <InlineFormScrollScreen
      backgroundColor={colors.background}
      contentContainerStyle={styles.container}
      getFormScrollY={getFormScrollY}
      onScrollToFormReady={handleScrollToFormReady}>
      <Text style={[styles.title, { color: colors.text }]}>Wildcard Inline</Text>
      <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
        This slot has no formId — it catches any form that has no exact-match slot.
      </Text>

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <FormIdPicker
        formIds={suggestedIds}
        value={formPickerValue}
        onChange={handleFormIdChange}
        textColor={colors.text}
        borderColor={colors.tabIconDefault}
        placeholderColor={colors.tabIconDefault}
      />

      <Pressable
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          !activeFormId && styles.buttonDisabled,
        ]}
        onPress={() => activeFormId && showForm(activeFormId)}
        disabled={!activeFormId}>
        <Text style={styles.buttonText}>Show Form (renders inline below)</Text>
      </Pressable>

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <RNView
        style={styles.inlineFormContainer}
        onLayout={(e) => {
          formScrollYRef.current = e.nativeEvent.layout.y;
        }}>
        <EncatchInlineForm
          style={styles.inlineForm}
          onOverlayOpenChange={(open) => {
            if (open) scrollToFormRef.current();
          }}
        />
      </RNView>
    </InlineFormScrollScreen>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: 'bold' },
  hint: { fontSize: 12, marginTop: 8, textAlign: 'center', marginBottom: 12 },
  separator: { marginVertical: 20, height: 1, width: '80%' },
  button: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 12,
    width: '100%',
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  inlineFormContainer: { width: '100%' },
  inlineForm: { width: '100%' },
});
