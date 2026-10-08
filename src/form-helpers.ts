/**
 * Helpers for custom native forms (when using onBeforeShowForm interceptor).
 * Use these to build SubmitFormRequest from your native form responses.
 */
import type {
  SubmitFormRequest,
  FormDetails,
  QuestionResponse,
  QuestionAnswer,
  QuestionType,
  SignatureAnswer,
  FileUploadAnswerItem,
  PhoneNumberAnswer,
  AddressAnswer,
  VideoAudioAnswer,
  SchedulerAnswer,
  QnaWithAiPair,
  PaymentsUpiAnswer,
} from './types';

/**
 * The value type accepted by NativeFormResponse.
 * Complex question types pass their structured answer object directly in `value`
 * while simple scalar types use string | number | string[].
 */
export type NativeFormValue =
  | string
  | number
  | boolean
  | string[]
  | SignatureAnswer
  | FileUploadAnswerItem[]
  | PhoneNumberAnswer
  | AddressAnswer
  | VideoAudioAnswer
  | SchedulerAnswer
  | QnaWithAiPair[]
  | PaymentsUpiAnswer
  | Record<string, unknown>;

export interface NativeFormResponse {
  questionId: string;
  type: string;
  value: NativeFormValue;
}

export interface BuildSubmitRequestOptions {
  triggerType?: 'automatic' | 'manual';
  formConfigurationId: string;
  responseLanguageCode?: string;
  completionTimeInSeconds?: number;
  isPartialSubmit?: boolean;
  feedbackIdentifier?: string;
  /**
   * Arbitrary caller-provided metadata to attach to this submission.
   * Date values must be pre-serialized to ISO strings before calling buildSubmitRequest().
   */
  context?: Record<string, string | number | boolean>;
}

/**
 * Maps a native form question type + value to the QuestionAnswer format.
 * Covers all 33 question types defined in the schema.
 *
 * For simple scalar types (rating, nps, etc.) pass a primitive value.
 * For complex types (signature, file_upload, phone_number, etc.) pass the
 * fully constructed structured object — the helper forwards it as-is.
 *
 * Display-only types (welcome, thank_you, message_panel, exit_form) carry
 * no answer payload and return {}.
 */
function toQuestionAnswer(type: string, value: NativeFormValue): QuestionAnswer {
  const toNum = (v: NativeFormValue): number =>
    typeof v === 'number' ? v : parseInt(String(v), 10);
  const toStr = (v: NativeFormValue): string => String(v);
  const toStrArr = (v: NativeFormValue): string[] =>
    Array.isArray(v) ? (v as string[]).map(String) : [String(v)];

  switch (type as QuestionType) {
    // ---- Numeric scales ----
    case 'rating':
      return { rating: toNum(value) };
    case 'nps':
      return { nps: toNum(value) };
    case 'csat':
      return { csat: toNum(value) };
    case 'opinion_scale':
      return { opinionScale: toNum(value) };

    // ---- Text ----
    case 'short_answer':
      return { shortAnswer: toStr(value) };
    case 'long_text':
      return { longText: toStr(value) };
    case 'email':
      return { email: toStr(value) };
    case 'number':
      return { number: toStr(value) };
    case 'website':
      return { website: toStr(value) };

    // ---- Single / Multiple choice ----
    case 'single_choice':
      return { singleChoice: toStr(value) };
    case 'multiple_choice_multiple':
      return { multipleChoiceMultiple: toStrArr(value) };
    case 'picture_choice':
      return { pictureChoice: toStrArr(value) };
    case 'ranking':
      return { ranking: toStrArr(value) };

    // ---- Boolean / Consent ----
    case 'yes_no':
      return { yesNo: value === true || value === 'true' || value === 1 };
    case 'consent':
      return { consent: value === true || value === 'true' || value === 1 };

    // ---- Date ----
    case 'date':
      return { date: toStr(value) };

    // ---- Matrix ----
    case 'rating_matrix':
      return { ratingMatrix: value as Record<string, number | string> };
    case 'matrix_single_choice':
      return { matrixSingleChoice: value as Record<string, string> };
    case 'matrix_multiple_choice':
      return { matrixMultipleChoice: value as Record<string, string[]> };

    // ---- Nested selection ----
    case 'nested_selection':
      return { nestedSelection: toStrArr(value) };

    // ---- Annotation ----
    case 'annotation':
      return { annotation: value as QuestionAnswer['annotation'] };

    // ---- Complex structured answers (pass through as-is) ----
    case 'signature':
      return { signature: value as SignatureAnswer };
    case 'file_upload':
      return { fileUpload: value as FileUploadAnswerItem[] };
    case 'phone_number':
      return { phoneNumber: value as PhoneNumberAnswer };
    case 'address':
      return { address: value as AddressAnswer };
    case 'video_audio':
      return { videoAudio: value as VideoAudioAnswer };
    case 'scheduler':
      return { scheduler: value as SchedulerAnswer };
    case 'qna_with_ai':
      return { qnaWithAi: value as QnaWithAiPair[] };
    case 'payments_upi':
      return { paymentsUpi: value as PaymentsUpiAnswer };

    // ---- Display-only types (no answer payload) ----
    case 'welcome':
    case 'thank_you':
    case 'message_panel':
    case 'exit_form':
      return {};

    default:
      // Unknown type: store as shortAnswer for forward-compatibility
      return { shortAnswer: toStr(value) };
  }
}

/**
 * Builds a SubmitFormRequest from native form responses.
 * Use when you have a custom native form and need to submit to the Encatch API.
 *
 * @example
 * ```ts
 * const responses = [
 *   { questionId: 'q1', type: 'rating', value: 5 },
 *   { questionId: 'q2', type: 'short_answer', value: 'Great product!' },
 * ];
 * const req = buildSubmitRequest(
 *   { formConfigurationId: formConfig.feedbackConfigurationId, context: { plan: 'pro' } },
 *   responses
 * );
 * Encatch.submitForm(req);
 * ```
 */
export function buildSubmitRequest(
  options: BuildSubmitRequestOptions,
  responses: NativeFormResponse[]
): SubmitFormRequest {
  const questions: QuestionResponse[] = responses.map((r) => ({
    questionId: r.questionId,
    type: r.type as QuestionType,
    answer: toQuestionAnswer(r.type, r.value),
  }));

  const formDetails: FormDetails = {
    formConfigurationId: options.formConfigurationId,
    responseLanguageCode: options.responseLanguageCode,
    completionTimeInSeconds: options.completionTimeInSeconds,
    isPartialSubmit: options.isPartialSubmit,
    feedbackIdentifier: options.feedbackIdentifier,
    response: { questions },
    context: options.context,
  };

  return {
    triggerType: options.triggerType ?? 'manual',
    formDetails,
  };
}
