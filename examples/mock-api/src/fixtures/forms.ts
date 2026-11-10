/**
 * A show-form reply body. It passes `fetchFeedbackDetailsResponseSchema` from
 * `@encatch/schema` (checked in test/contract.test.ts), so the real survey page on
 * form.dev.encatch.com can render it: one rating question and one long-text question.
 */
export function showFormReply(formId: string, title: string, feedbackIdentifier: string) {
  return {
    feedbackConfigurationId: formId,
    feedbackIdentifier,
    formConfiguration: {
      formTitle: title,
      formDescription: 'Served by the local Encatch mock API',
      formSlug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    },
    questionnaireFields: {
      questions: {
        'q-rating': {
          id: 'q-rating',
          type: 'rating',
          title: 'How would you rate the app?',
          required: true,
          status: 'P',
          numberOfRatings: 5,
        },
        'q-text': {
          id: 'q-text',
          type: 'long_text',
          title: 'Anything else you would like to tell us?',
          required: false,
          status: 'P',
        },
      },
      // The survey page renders questions through their section; an empty list shows none.
      sections: [
        {
          id: 'section-1',
          title: title,
          showTitle: false,
          showDescription: false,
          inAppSingleQuestion: false,
          questionIds: ['q-rating', 'q-text'],
        },
      ],
      translations: {},
      selectedLanguages: [{ value: 'en', label: 'English' }],
    },
    otherConfigurationProperties: {
      isEnabled: true,
      otherFields: { questionNumber: false, submitButtonLabel: 'Submit', previousButtonLabel: 'Back' },
      translations: {},
    },
    appearanceProperties: {
      themeConfiguration: {
        themes: { light: {}, dark: {} },
        featureSettings: { customPosition: false },
        selectedPosition: 'bottom-center',
        selectedIconPosition: 'bottom-right',
      },
    },
    partialResponseEnabled: false,
  };
}
