/**
 * Form config types matching the Encatch API response structure.
 */

export interface FormQuestion {
  id: string;
  title: string;
  description?: string;
  type: 'rating' | 'short_answer' | 'long_text' | 'single_choice' | 'multiple_choice' | string;
  required?: boolean;
  options?: { label: string; value: string }[];
  sectionId?: string;
}

export interface FormSection {
  id: string;
  title: string;
  questionIds: string[];
}

export interface QuestionnaireFields {
  questions: Record<string, FormQuestion>;
  sections: FormSection[];
  selectedLanguages?: { label: string; value: string }[];
}

export interface FormConfig {
  feedbackConfigurationId: string;
  formConfiguration?: {
    formTitle?: string;
    formDescription?: string;
  };
  questionnaireFields?: QuestionnaireFields;
  otherConfigurationProperties?: {
    otherFields?: {
      previousButtonLabel?: string;
      submitButtonLabel?: string;
    };
  };
}
