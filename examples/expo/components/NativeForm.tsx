import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  StyleSheet,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Dimensions,
} from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useEncatch } from '@encatch/react-native-sdk';
import { buildSubmitRequest, type NativeFormResponse } from '@encatch/react-native-sdk';
import type { FormConfig, FormQuestion } from '@/types/formConfig';

interface NativeFormProps {
  visible: boolean;
  formConfig: FormConfig | null;
  onClose: () => void;
}

type FormStep = 'welcome' | 'questions' | 'end';

export function NativeForm({ visible, formConfig, onClose }: NativeFormProps) {
  const { submitForm, emitEvent, dismissForm } = useEncatch();
  const [step, setStep] = useState<FormStep>('welcome');
  const [responses, setResponses] = useState<Record<string, string | number>>({});
  const formStartTime = useRef<number | null>(null);

  useEffect(() => {
    if (visible && formConfig) {
      const hasWelcome = Object.values(formConfig.questionnaireFields?.questions ?? {}).some(
        (q) => q?.type === 'welcome'
      );
      setStep(hasWelcome ? 'welcome' : 'questions');
      emitEvent('form:show', { formId: formConfig.feedbackConfigurationId, data: {} });
    }
  }, [visible, formConfig, emitEvent]);

  if (!formConfig) return null;

  const formId = formConfig.feedbackConfigurationId;
  const questionnaire = formConfig.questionnaireFields;
  const questionsMap = questionnaire?.questions ?? {};

  const DISPLAY_ONLY_TYPES = new Set(['welcome', 'thank_you', 'message_panel', 'annotation']);

  const findQuestionByType = (type: string): FormQuestion | undefined =>
    Object.values(questionsMap).find((q) => q?.type === type);

  const welcomeQ = findQuestionByType('welcome');
  const thankYouQ = findQuestionByType('thank_you');

  const nextLabel = 'Next';
  const submitLabel = formConfig.otherConfigurationProperties?.otherFields?.submitButtonLabel ?? 'Submit';

  const sections = questionnaire?.sections ?? [];
  const questions: FormQuestion[] = sections.flatMap((s) =>
    s.questionIds.map((id) => questionsMap[id]).filter(
      (q): q is FormQuestion => Boolean(q) && !DISPLAY_ONLY_TYPES.has(q.type)
    )
  );

  const handleWelcomeNext = () => {
    formStartTime.current = Date.now();
    emitEvent('form:started', { formId, data: {} });
    if (questions.length > 0) setStep('questions');
    else setStep('end');
  };

  const handleQuestionsNext = () => {
    const nativeResponses: NativeFormResponse[] = Object.entries(responses).map(([questionId, value]) => {
      const q = questionsMap[questionId];
      return {
        questionId,
        type: q?.type ?? 'short_answer',
        value,
      };
    });

    const completionTimeInSeconds = formStartTime.current
      ? Math.round((Date.now() - formStartTime.current) / 1000)
      : undefined;

    const req = buildSubmitRequest(
      {
        formConfigurationId: formConfig.feedbackConfigurationId,
        triggerType: 'manual',
        completionTimeInSeconds,
      },
      nativeResponses
    );

    submitForm(req);
    emitEvent('form:submit', { formId, data: { response: req.formDetails.response } });
    emitEvent('form:complete', { formId, data: {} });
    dismissForm(formConfig.feedbackConfigurationId);
    setStep('end');
  };

  const handleResponseChange = (questionId: string, value: string | number) => {
    setResponses((prev) => ({ ...prev, [questionId]: value }));
  };

  const resetForm = () => {
    const hasWelcome = Object.values(formConfig.questionnaireFields?.questions ?? {}).some(
      (q) => q?.type === 'welcome'
    );
    setStep(hasWelcome ? 'welcome' : 'questions');
    setResponses({});
  };

  const handleClose = () => {
    if (formConfig && step !== 'end') {
      emitEvent('form:close', { formId: formConfig.feedbackConfigurationId, data: {} });
      dismissForm(formConfig.feedbackConfigurationId);
    }
    resetForm();
    onClose();
  };

  const renderQuestion = (q: FormQuestion) => {
    const value = responses[q.id];

    switch (q.type) {
      case 'rating':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionTitle}>{q.title}</Text>
            <View style={styles.ratingRow}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable
                  key={n}
                  style={[styles.ratingStar, (value as number) === n && styles.ratingStarActive]}
                  onPress={() => handleResponseChange(q.id, n)}>
                  <SymbolView
                    name={{ ios: 'star.fill', android: 'star', web: 'star' }}
                    tintColor={(value as number) === n ? '#f59e0b' : '#94a3b8'}
                    size={36}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        );
      case 'short_answer':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionTitle}>{q.title}</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Your answer"
              placeholderTextColor="#94a3b8"
              value={(value as string) ?? ''}
              onChangeText={(text) => handleResponseChange(q.id, text)}
            />
          </View>
        );
      case 'long_text':
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionTitle}>{q.title}</Text>
            <TextInput
              style={[styles.textInput, styles.textArea]}
              placeholder="Your answer"
              placeholderTextColor="#94a3b8"
              value={(value as string) ?? ''}
              onChangeText={(text) => handleResponseChange(q.id, text)}
              multiline
              numberOfLines={4}
            />
          </View>
        );
      default:
        return (
          <View key={q.id} style={styles.questionBlock}>
            <Text style={styles.questionTitle}>{q.title}</Text>
            <TextInput
              style={styles.textInput}
              placeholder="Your answer"
              placeholderTextColor="#94a3b8"
              value={(value as string) ?? ''}
              onChangeText={(text) => handleResponseChange(q.id, text)}
            />
          </View>
        );
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      onRequestClose={handleClose}>
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Pressable onPress={handleClose} style={styles.closeBtn}>
            <SymbolView
              name={{ ios: 'xmark.circle.fill', android: 'close', web: 'close' }}
              tintColor="#94a3b8"
              size={28}
            />
          </Pressable>
          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
          {step === 'welcome' && (
            <View style={styles.step}>
              <Text style={styles.welcomeTitle}>
                {welcomeQ?.title ?? 'Welcome'}
              </Text>
              {welcomeQ?.description && (
                <Text style={styles.welcomeDesc}>{welcomeQ.description}</Text>
              )}
              <Pressable
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                onPress={handleWelcomeNext}>
                <Text style={styles.primaryButtonText}>Get Started</Text>
              </Pressable>
            </View>
          )}

          {step === 'questions' && (
            <View style={styles.step}>
              {sections.map((section) => (
                <View key={section.id} style={styles.section}>
                  <Text style={styles.sectionTitle}>{section.title}</Text>
                  {section.questionIds.map((id) => questionsMap[id]).filter(Boolean).map(renderQuestion)}
                </View>
              ))}
            </View>
          )}

          {step === 'end' && (
            <View style={styles.step}>
              <Text style={styles.welcomeTitle}>
                {thankYouQ?.title ?? 'Thank You!'}
              </Text>
              {thankYouQ?.description && (
                <Text style={styles.welcomeDesc}>{thankYouQ.description}</Text>
              )}
              <Pressable
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                onPress={handleClose}>
                <Text style={styles.primaryButtonText}>Close</Text>
              </Pressable>
            </View>
          )}
          </ScrollView>
          {step === 'questions' && (
            <View style={styles.submitFooter}>
              <Pressable
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                onPress={handleQuestionsNext}>
                <Text style={styles.primaryButtonText}>{submitLabel}</Text>
              </Pressable>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 400,
    maxHeight: SCREEN_HEIGHT * 0.85,
    minHeight: 200,
    backgroundColor: '#0f172a',
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  closeBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 10,
    padding: 4,
  },
  content: {
    maxHeight: SCREEN_HEIGHT * 0.55,
  },
  submitFooter: {
    padding: 20,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(148, 163, 184, 0.2)',
  },
  contentInner: {
    padding: 20,
    paddingTop: 44,
    paddingBottom: 40,
  },
  step: {
    gap: 24,
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#f8fafc',
  },
  welcomeDesc: {
    fontSize: 16,
    color: '#94a3b8',
    lineHeight: 24,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e2e8f0',
    marginBottom: 16,
  },
  questionBlock: {
    marginBottom: 20,
  },
  questionTitle: {
    fontSize: 16,
    fontWeight: '500',
    color: '#f8fafc',
    marginBottom: 8,
  },
  ratingRow: {
    flexDirection: 'row',
    gap: 8,
  },
  ratingStar: {
    padding: 4,
  },
  ratingStarActive: {
    opacity: 1,
  },
  textInput: {
    backgroundColor: 'rgba(30, 41, 59, 0.8)',
    borderWidth: 1,
    borderColor: 'rgba(99, 102, 241, 0.3)',
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    color: '#f8fafc',
  },
  textArea: {
    minHeight: 100,
    textAlignVertical: 'top',
  },
  primaryButton: {
    backgroundColor: '#6366f1',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonPressed: {
    opacity: 0.9,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
