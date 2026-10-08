/**
 * @encatch/react-native — Public API
 */

export { Encatch } from './encatch';
export { DEFAULT_API_BASE_URL, DEFAULT_WEB_HOST } from './constants';
export { EncatchProvider, useEncatch } from './EncatchProvider';
export { EncatchWebView } from './EncatchWebView';
export { EncatchInlineForm } from './EncatchInlineForm';
export type { EncatchInlineFormProps } from './EncatchInlineForm';
export { buildSubmitRequest } from './form-helpers';

export type { NativeFormResponse, BuildSubmitRequestOptions, NativeFormValue } from './form-helpers';
export type {
  EncatchConfig,
  ShowFormInterceptorPayload,
  UserTraits,
  IdentifyOptions,
  SecureOptions,
  StartSessionOptions,
  Theme,
  ShowFormOptions,
  ResetMode,
  EventType,
  EventCallback,
  EventPayload,
  ApiDeviceInfo,
  ShowFormResponse,
  SubmitFormRequest,
  FormDetails,
  QuestionResponse,
  QuestionAnswer,
  QuestionType,
  RefineTextRequest,
  RefineTextResponse,
  // New structured answer types
  AnnotationMarker,
  SignatureAnswer,
  FileUploadAnswerItem,
  PhoneNumberAnswer,
  AddressAnswer,
  VideoAudioAnswer,
  SchedulerAnswer,
  QnaWithAiPair,
  PaymentsUpiAnswer,
  // Upload / stream public API types
  QnaWithAiConversationTurn,
  QnaWithAiRequest,
  QnaWithAiResponse,
  UploadFileRequest,
  UploadFileResponse,
} from './types';

export type { EncatchContextValue, EncatchProviderProps } from './EncatchProvider';
