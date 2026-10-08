import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useColorScheme } from '@/components/useColorScheme';
import Colors from '@/constants/Colors';
import { EncatchConfig } from '@/constants/Config';
import type { TesterSetupValues } from '@/contexts/TesterConfigContext';

interface SetupScreenProps {
  initialApiKey?: string;
  initialFormId?: string;
  initialInterceptorFormId?: string;
  onContinue: (values: TesterSetupValues) => void;
}

export default function SetupScreen({
  initialApiKey = EncatchConfig.apiKey || '',
  initialFormId = EncatchConfig.formId,
  initialInterceptorFormId = '',
  onContinue,
}: SetupScreenProps) {
  const [apiKey, setApiKey] = useState(initialApiKey);
  const [formId, setFormId] = useState(initialFormId);
  const [interceptorFormId, setInterceptorFormId] = useState(initialInterceptorFormId);
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme];

  const canContinue = apiKey.trim().length > 0 && formId.trim().length > 0;

  const handleContinue = () => {
    if (!canContinue) return;
    onContinue({
      apiKey: apiKey.trim(),
      formId: formId.trim(),
      interceptorFormId: interceptorFormId.trim(),
    });
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: colors.text }]}>Encatch SDK Setup</Text>
        <Text style={[styles.subtitle, { color: colors.tabIconDefault }]}>
          Enter your API key and feedback configuration id. Saved values persist until you clear them in Settings.
        </Text>

        <Text style={[styles.label, { color: colors.text }]}>API Key</Text>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
          placeholder="API Key"
          placeholderTextColor={colors.tabIconDefault}
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.label, { color: colors.text }]}>Feedback configuration ID</Text>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
          placeholder="Feedback configuration ID"
          placeholderTextColor={colors.tabIconDefault}
          value={formId}
          onChangeText={setFormId}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.label, { color: colors.text }]}>Interceptor test form ID (optional)</Text>
        <Text style={[styles.fieldHint, { color: colors.tabIconDefault }]}>
          When set, showForm for this id is blocked and shown in the native interceptor carousel.
        </Text>
        <TextInput
          style={[styles.input, { color: colors.text, borderColor: colors.tabIconDefault }]}
          placeholder="Same as feedback config id or leave empty"
          placeholderTextColor={colors.tabIconDefault}
          value={interceptorFormId}
          onChangeText={setInterceptorFormId}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          style={[styles.button, !canContinue && styles.buttonDisabled]}
          onPress={handleContinue}
          disabled={!canContinue}>
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    marginBottom: 24,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  fieldHint: {
    fontSize: 12,
    marginBottom: 8,
  },
  input: {
    height: 48,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    fontSize: 16,
    marginBottom: 16,
  },
  button: {
    height: 48,
    backgroundColor: '#3B82F6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
