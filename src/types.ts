/**
 * All shared TypeScript interfaces and types for the Encatch React Native SDK.
 */

import type { Answer, QuestionResponse, FormDetails, SubmitFormRequest } from '@encatch/schema';

/**
 * All supported question answer shapes.
 * Re-exported from @encatch/schema — covers every question type.
 */
export type { Answer as QuestionAnswer, QuestionResponse, FormDetails, SubmitFormRequest };

// ============================================================================
// Config (matches web SDK EncatchConfig, with RN-only additions)
// ============================================================================

export interface EncatchConfig {
  /**
   * Base URL used for all API calls.
   * Defaults to 'https://api.encatch.com'.
   */
  apiBaseUrl?: string;
  /**
   * Base URL used to load the react-native-sdk-form WebView page.
   * Defaults to 'https://form.encatch.com'.
   * Override this only if your web host differs from the default form host.
   */
  webHost?: string;
  /** Default theme for forms. Defaults to 'system'. */
  theme?: Theme;
  /** When true, the form overlay is displayed full-screen. */
  isFullScreen?: boolean;
  /** Enable verbose SDK logging to the console. */
  debugMode?: boolean;
  /** Override app version (default: auto-detected from native app) */
  appVersion?: string;
  /**
   * Override the Android package name / iOS bundle ID sent as the Referer
   * header, which the Encatch API requires. Auto-detected via expo-application
   * (Expo) or react-native-device-info (bare React Native); set this when
   * neither is installed, otherwise API calls are rejected.
   */
  appPackageId?: string;
  /**
   * Optional interceptor called before any form is shown (manual or automatic).
   * If it returns false (or Promise<false>), the SDK form will not open; the app
   * can show a custom widget using the payload. Prefills are cleared when false.
   */
  onBeforeShowForm?: (payload: ShowFormInterceptorPayload) => boolean | Promise<boolean>;
}

// ============================================================================
// Show form interceptor payload
// ============================================================================

export interface ShowFormInterceptorPayload {
  formId: string;
  formConfig: ShowFormResponse;
  resetMode: ResetMode;
  triggerType: 'automatic' | 'manual';
  /** Pre-filled responses from addToResponse() */
  prefillResponses: Record<string, unknown>;
  locale?: string;
  theme?: Theme;
  /** Serialized caller context (Dates already converted to ISO strings) */
  context?: Record<string, string | number | boolean>;
}

// ============================================================================
// startSession options (matches web SDK StartSessionOptions)
// ============================================================================

export interface StartSessionOptions {
  /** When true, do not call the immediate ping (30s ping interval still runs) */
  skipImmediatePing?: boolean;
  /** When true, do not send the initial trackScreen for the current screen (screen listeners still run) */
  skipImmediateTrackScreen?: boolean;
}


// ============================================================================
// User
// ============================================================================

export interface UserTraits {
  /** Set user attributes (overwrites existing values) */
  $set?: Record<string, any>;
  /** Set user attributes only if they don't already exist */
  $setOnce?: Record<string, any>;
  /** Increment numeric user attributes */
  $increment?: Record<string, number>;
  /** Decrement numeric user attributes */
  $decrement?: Record<string, number>;
  /** Remove user attributes */
  $unset?: string[];
}

export interface SecureOptions {
  signature: string;
  generatedDateTimeinUTC?: string;
}

export interface IdentifyOptions {
  locale?: string;
  country?: string;
  secure?: SecureOptions;
}

// ============================================================================
// Theme
// ============================================================================

export type Theme = 'light' | 'dark' | 'system';

// ============================================================================
// Form display options
// ============================================================================

/**
 * Reset mode for form data when showing a form.
 * - 'always': Clear form data every time showForm is called (default)
 * - 'on-complete': Clear form data only if form was previously completed
 * - 'never': Never clear form data (preserve user's previous answers)
 */
export type ResetMode = 'always' | 'on-complete' | 'never';

/**
 * Context values that can be attached to a form submission.
 * Date values are automatically serialized to ISO strings before being sent.
 */
export type ContextValue = string | number | Date | boolean;

export interface ShowFormOptions {
  /**
   * Controls when form data should be cleared.
   * @default 'always'
   */
  reset?: ResetMode;
  /**
   * Arbitrary key-value pairs attached to the form submission.
   * Useful for passing caller-side metadata (e.g. plan tier, feature flag states).
   * Date values are automatically serialized to ISO 8601 strings.
   */
  context?: Record<string, ContextValue>;
}

/** Internal only — extends ShowFormOptions with triggerType. */
export interface InternalShowFormOptions extends ShowFormOptions {
  triggerType?: 'automatic' | 'manual';
}

/** Wire-format payload for exit_form completion CTAs deferred to the native SDK timer. */
export interface PendingCompletionCta {
  action: 'dismiss' | 'app_navigate' | 'redirect_internal' | 'redirect_external';
  url?: string;
  route?: string;
  surface: 'inApp' | 'link';
  trigger: 'auto';
  autoTriggerDelayMs: number;
}

// ============================================================================
// Events
// ============================================================================

export type EventType =
  | 'form:show'
  | 'form:started'
  | 'form:submit'
  | 'form:complete'
  | 'form:close'
  | 'form:dismissed'
  | 'form:error'
  | 'form:section:change'
  | 'form:answered'
  | 'form:remindmelater'
  /**
   * Fired when a completionCta action triggers on a thank_you or exit_form screen.
   * payload.data: { action, route?, url?, surface, trigger }
   *
   * - action "app_navigate": host navigates to data.route in Encatch.on(); the SDK
   *   closes the form overlay automatically after emitting this event.
   * - action "redirect_internal": SDK opened data.url in the in-app browser; form is closing.
   * - action "redirect_external": SDK opened data.url in the system browser; form is closing.
   */
  | 'form:ctaTriggered';

export interface EventPayload {
  formId?: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

export type EventCallback = (eventType: EventType, payload: EventPayload) => void;

// ============================================================================
// PostMessage protocol — form -> native (outbound from WebView)
// ============================================================================

export type FormMessageType =
  | 'form:ready'
  | 'form:submit'
  | 'form:complete'
  | 'form:close'
  | 'form:error'
  | 'form:resize'
  | 'form:layout'
  | 'form:closeButton'
  | 'form:themeData'
  | 'form:refineTextRequest'
  | 'form:started'
  | 'form:answered'
  | 'form:section:change'
  | 'form:show'
  | 'form:readyToDismiss'
  | 'form:uploadFileRequest'   // File upload proxy request to native
  | 'form:qnaWithAiRequest'    // Q&A with AI streaming proxy request to native
  | 'form:remindmelater'       // Remind me later event
  | 'form:ctaTriggered';       // Completion CTA action (app_navigate / redirect_internal / redirect_external)

export interface FormMessage {
  type: FormMessageType;
  formId: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// PostMessage protocol — native -> form (inbound to WebView)
// ============================================================================

export type SDKMessageType =
  | 'sdk:formConfig'
  | 'sdk:theme'
  | 'sdk:locale'
  | 'sdk:resetData'
  | 'sdk:prefillResponses'
  | 'sdk:refineTextResponse'
  | 'sdk:submitPartialBeforeDismiss'
  | 'sdk:uploadFileResponse'    // File upload result (success or error)
  | 'sdk:uploadFileProgress'    // File upload progress update (0–100)
  | 'sdk:qnaWithAiResponse'     // Q&A with AI error response (pre-stream or validation failure)
  | 'sdk:qnaWithAiChunk'        // Q&A with AI streaming delta chunk
  | 'sdk:qnaWithAiDone';        // Q&A with AI stream complete — final authoritative answer

export interface SDKMessage {
  type: SDKMessageType;
  data?: Record<string, unknown>;
}

// ============================================================================
// API Device Info
// ============================================================================

export interface ApiDeviceInfo {
  $deviceOs?: string;
  $deviceVersion?: string;
  $deviceOsVersion?: string;
  $deviceType?: string;
  $deviceSize?: 'mobile' | 'tablet' | 'desktop';
  $sdkVersion?: string;
  $appVersion?: string;
  $app?: string;
  $deviceLanguage?: string;
  $userLanguage?: string;
  $countryCode?: string;
  $preferredTheme?: string;
  $timezone?: string;
  $urlOrScreenName?: string;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface IdentifyUserRequest {
  userName?: string;
  userId?: string;
  userSignature?: string;
  $deviceInfo?: ApiDeviceInfo;
  userAttributes?: UserTraits;
  $feedbackTransactions?: string;
}

export interface IdentifyUserResponse {
  message: string;
  userId?: string;
  formConfigurationId?: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface TrackEventRequest {
  eventName: string;
  feedbackConfigurationId?: string;
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

export interface TrackEventResponse {
  message: string;
  formConfigurationId?: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface TrackScreenRequest {
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

export interface TrackScreenResponse {
  message: string;
  formConfigurationId?: string;
  nextFeedbackId?: string;
  onPageDelay?: number;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface ShowFormRequest {
  formSlugOrId: string;
  triggerType?: 'automatic' | 'manual';
  language?: string;
  /** Source tracking key-value pairs filtered by the form's sourceTrackingFields allowlist */
  sourceTrackingFieldValues?: Record<string, string>;
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

export interface ShowFormResponse {
  feedbackConfigurationId: string;
  feedbackIdentifier?: string;
  triggerType?: 'automatic' | 'manual';
  formConfiguration?: Record<string, unknown>;
  questionnaireFields?: any;
  otherConfigurationProperties?: any;
  appearanceProperties?: any;
  partialResponseEnabled?: boolean;
  /** Contact properties returned by the server for Liquid variable substitution via {{ contact.key }} syntax */
  contact?: Record<string, unknown>;
  /**
   * Optional customer CDN URL for form i18n (one multi-lang flat JSON).
   * Defined in `@encatch/schema` as `projectI18nFileUrlSchema` on fetch/show-form responses.
   * e.g. `https://cdn…/i18n/v12.json`. Omit or null → host per-lang defaults.
   */
  projectI18nFileUrl?: string | null;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface DismissFormRequest {
  formConfigurationId?: string;
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

export interface DismissFormResponse {
  message?: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface PingRequest {
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

export interface PingResponse {
  message: string;
  action?: string;
  formConfigurationId?: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export interface RefineTextRequest {
  questionId: string;
  feedbackConfigurationId: string;
  userText: string;
  $deviceInfo?: ApiDeviceInfo;
  $feedbackTransactions?: string;
}

// ============================================================================
// Q&A with AI types
// ============================================================================

/**
 * A single turn in the conversation history sent to the qna-with-ai endpoints.
 * Structurally identical to QnaWithAiPair — kept as a separate alias so call-site
 * intent is clear (request payload vs stored answer).
 */
export interface QnaWithAiConversationTurn {
  question: string;
  answer: string;
}

export interface QnaWithAiRequest {
  feedbackConfigurationId: string;
  questionId: string;
  /** Ordered history of previous Q&A turns for context */
  conversation: QnaWithAiConversationTurn[];
}

export interface QnaWithAiResponse {
  answer: string;
}

// ============================================================================
// Upload file types
// ============================================================================

/**
 * Parameters for the uploadFile method.
 * Accepts either a standard Blob or a React Native file descriptor
 * (the { uri, name?, type? } object returned by image pickers and document pickers).
 */
export interface UploadFileRequest {
  /** The form's server-issued configuration ID */
  feedbackConfigurationId: string;
  /** The question ID the file belongs to */
  questionId: string;
  /** The file to upload — Blob or RN file descriptor */
  file: Blob | { uri: string; name?: string; type?: string };
  /**
   * File name to send to the server (e.g. "signature.png").
   * Defaults to "upload" when omitted.
   */
  fileName?: string;
  /**
   * Optional progress callback — receives upload percentage (0–100).
   * Useful for driving a progress bar in custom UIs.
   */
  onProgress?: (percent: number) => void;
}

export interface UploadFileResponse {
  /** Permanent URL of the uploaded file */
  fileUrl: string;
}

export interface RefineTextResponse {
  message?: string;
  refinedText?: string;
  status?: number;
  error?: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

export type QuestionType =
  | 'rating'
  | 'single_choice'
  | 'nps'
  | 'nested_selection'
  | 'multiple_choice_multiple'
  | 'short_answer'
  | 'long_text'
  | 'annotation'
  | 'welcome'
  | 'thank_you'
  | 'message_panel'
  | 'yes_no'
  | 'rating_matrix'
  | 'matrix_single_choice'
  | 'matrix_multiple_choice'
  | 'exit_form'
  | 'consent'
  | 'date'
  | 'csat'
  | 'opinion_scale'
  | 'ranking'
  | 'picture_choice'
  | 'signature'
  | 'file_upload'
  | 'email'
  | 'number'
  | 'website'
  | 'phone_number'
  | 'address'
  | 'video_audio'
  | 'scheduler'
  | 'qna_with_ai'
  | 'payments_upi';

// ============================================================================
// Structured answer types for complex question types
// ============================================================================

export interface AnnotationMarker {
  markerNo: string;
  timeline: string;
  comment: string;
}

export interface SignatureAnswer {
  /** The signing method the respondent used */
  mode: 'type' | 'draw' | 'upload';
  /** Secure URL to the signature artifact for draw and upload modes */
  fileUrl?: string;
  /** The name the respondent typed for type mode */
  typedName?: string;
}

export interface FileUploadAnswerItem {
  /** Secure URL to the uploaded file */
  fileUrl: string;
  /** Original filename as provided by the respondent */
  fileName: string;
  /** File size in megabytes */
  fileSizeMb: number;
  /** MIME type of the uploaded file */
  mimeType?: string;
}

export interface PhoneNumberAnswer {
  /** Dialing country code including the + prefix (e.g. '+1', '+91') */
  countryCode: string;
  /** Local phone number without the country code */
  number: string;
  /** Full phone number in E.164 format (e.g. '+14155552671') */
  e164?: string;
}

export interface AddressAnswer {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
}

export interface VideoAudioAnswer {
  /** The answer mode the respondent chose */
  mode: 'video' | 'audio' | 'photo' | 'text';
  /** Secure URL to the recorded, captured, or uploaded media file */
  fileUrl?: string;
  /** Written answer for text mode */
  text?: string;
  /** Actual recording length in seconds for video and audio modes */
  durationSeconds?: number;
  /** Auto-generated transcript for video and audio recordings */
  transcriptText?: string;
}

export type SchedulerAnswer =
  | {
      provider: 'google_calendar';
      /** Unix timestamp in seconds as a string when the respondent confirmed the booking */
      bookedAt: string;
    }
  | {
      provider: 'calendly';
      /** ISO 8601 datetime of the booked slot start */
      slotStart: string;
      /** ISO 8601 datetime of the booked slot end */
      slotEnd: string;
      /** Calendly event UUID */
      eventId?: string;
      /** Unix timestamp in seconds as a string when the respondent completed the booking */
      bookedAt: string;
    };

/** A single Q&A exchange stored as part of a qna_with_ai answer */
export interface QnaWithAiPair {
  question: string;
  answer: string;
}

export interface PaymentsUpiAnswer {
  /** Respondent-entered UPI transaction ID / UTR; self-reported and not verified by Encatch */
  transactionId: string;
  /** Opaque Encatch-generated reconciliation reference */
  encatchPaymentReference: string;
  /** INR amount shown to the respondent (decimal string, e.g. "99.5" or "100") */
  amount: string;
  currency: 'INR';
  payeeVpa: string;
  payeeName?: string;
  sourceEmail?: string;
  upiIntentUri?: string;
  /** Always true: Encatch records this answer but does not verify the payment */
  selfReported: true;
}

// ============================================================================
// QuestionAnswer, QuestionResponse, FormDetails, SubmitFormRequest
// Re-exported from @encatch/schema at the top of this file.
// ============================================================================

export interface SubmitFormResponse {
  message: string;
  pingAgainIn?: number;
  pingOnNextPageVisit?: boolean;
  $feedbackTransactions?: string;
}

// ============================================================================
// Internal emitter event map (native SDK <-> EncatchWebView / EncatchInlineForm)
// ============================================================================

/**
 * Shared payload carried by the internal 'showForm' emitter event.
 * Used by EncatchWebView (modal) and EncatchInlineForm (inline) alike.
 */
export interface ShowFormPayload {
  formId: string;
  formConfig: ShowFormResponse;
  resetMode: ResetMode;
  triggerType: 'automatic' | 'manual';
  prefillResponses?: Record<string, unknown>;
  locale?: string;
  theme?: Theme;
  /** Serialized caller context (Dates already converted to ISO strings) */
  context?: Record<string, string | number | boolean>;
  /** Resolved presentation target: 'inline' renders in EncatchInlineForm, 'modal' in EncatchWebView */
  presentation: 'inline' | 'modal';
  /** Set when presentation === 'inline'; identifies the specific registered slot */
  inlineSlotId?: string;
}

export interface EncatchInternalEvents {
  showForm: ShowFormPayload;
  dismissForm: { formConfigurationId?: string };
  sendToWebView: SDKMessage;
  /** Fired when user identity changes — identified (userName + userId present) or cleared */
  userIdentified: { userName: string | null; userId: string | null };
}

// ============================================================================
// Storage value types
// ============================================================================

export interface SessionData {
  sessionId: string;
  expiresAt: number;
}

export interface FeedbackTransactionEntry {
  [formConfigId: string]: {
    hasEverCompleted?: boolean;
    hasEverSeen?: boolean;
  };
}
