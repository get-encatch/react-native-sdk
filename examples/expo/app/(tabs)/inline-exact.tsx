/**
 * Exact Inline tab
 *
 * Mounts <EncatchInlineForm formId="..." /> with the form id from config.
 * showForm() calls for that specific form id will render here; other forms
 * remain unaffected and fall through to the wildcard slot or modal.
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

export default function InlineExactScreen() {
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
  const pinnedFormId = activeFormId;

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
      <Text style={[styles.title, { color: colors.text }]}>Exact Inline</Text>
      <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
        Pin this slot to a feedback configuration ID.
        {'\n'}Only that form renders inline here; any other form id falls through to modal.
      </Text>

      <FormIdPicker
        formIds={suggestedIds}
        value={formPickerValue}
        onChange={handleFormIdChange}
        textColor={colors.text}
        borderColor={colors.tabIconDefault}
        placeholderColor={colors.tabIconDefault}
      />

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      <Pressable
        style={({ pressed }) => [
          styles.button,
          pressed && styles.buttonPressed,
          !pinnedFormId && styles.buttonDisabled,
        ]}
        onPress={() => pinnedFormId && showForm(pinnedFormId)}
        disabled={!pinnedFormId}>
        <Text style={styles.buttonText}>Show Exact Form (renders inline below)</Text>
      </Pressable>

      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />

      {pinnedFormId ? (
        <RNView
          style={styles.inlineFormContainer}
          onLayout={(e) => {
            formScrollYRef.current = e.nativeEvent.layout.y;
          }}>
          <EncatchInlineForm
            key={pinnedFormId}
            formId={pinnedFormId}
            minHeight={100}
            style={styles.inlineForm}
            onOverlayOpenChange={(open) => {
              if (open) scrollToFormRef.current();
            }}
          />
        </RNView>
      ) : (
        <Text style={[styles.hint, { color: colors.tabIconDefault }]}>
          Enter a feedback configuration ID above.
        </Text>
      )}
    </InlineFormScrollScreen>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: 'bold' },
  hint: { fontSize: 12, marginTop: 8, textAlign: 'center' },
  separator: { marginVertical: 20, height: 1, width: '80%' },
  button: {
    backgroundColor: '#8B5CF6',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 8,
    width: '100%',
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  inlineFormContainer: { width: '100%' },
  inlineForm: { width: '100%' },
});
