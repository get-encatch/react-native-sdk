/**
 * useEncatchFormWebView
 *
 * Shared WebView bridge logic used by both EncatchWebView (modal) and EncatchInlineForm (inline).
 *
 * Handles:
 *  - formPayload state + WebView instance keying
 *  - injectSDKMessage (Native → WebView)
 *  - handleFormReady (config + prefill injection, triggers caller's onReady callback)
 *  - handleWebViewMessage (all form:* messages from the WebView)
 *  - WebView URL building
 *  - Height resize notifications (via onHeightChange callback)
 *  - form:layout fullHeight flag (via onForceFullHeight callback)
 *  - formAnsweredTracked deduplication
 *  - submit / refine / upload / qnaWithAi proxying
 */
import React, { useRef, useState, useCallback, useMemo } from 'react';
import { Linking } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Encatch } from './encatch';
import {
  parsePendingCompletionCta,
  schedulePendingCompletionCta,
} from './pendingCompletionCta';
import {
  openRedirectInternalUrl,
  REDIRECT_INTERNAL_AFTER_CLOSE_DELAY_MS,
} from './redirect-browser';
import { buildFormWebViewUrl, uploadMimeType } from './form-webview-helpers';
import { traceFormResize } from './form-resize-trace';
import type {
  ShowFormPayload,
  SDKMessage,
  FormMessage,
  SubmitFormRequest,
  RefineTextRequest,
} from './types';

const REDIRECT_AFTER_IMMEDIATE_CLOSE_DELAY_MS = 50;

function getRedirectOpenDelayMs(action: string | undefined): number {
  return action === 'redirect_internal'
    ? REDIRECT_INTERNAL_AFTER_CLOSE_DELAY_MS
    : REDIRECT_AFTER_IMMEDIATE_CLOSE_DELAY_MS;
}

// ============================================================================
// Hook options
// ============================================================================

export interface UseEncatchFormWebViewOptions {
  /** Tag used in console warnings. */
  logTag: string;
  /** Called when the form should be closed (complete, close, remindmelater). */
  onClose: (options?: { immediate?: boolean }) => void;
  /** Called when the WebView reports a new content height. */
  onHeightChange: (height: number) => void;
  /** Called when the WebView requests full-height layout. */
  onForceFullHeight: (force: boolean) => void;
  /** Called once the WebView is ready and entrance can start. */
  onReady: () => void;
  /** Loads the web form page in inline (ScrollView-safe) or modal layout mode. */
  presentation?: 'inline' | 'modal';
}

// ============================================================================
// Hook return value
// ============================================================================

export interface UseEncatchFormWebViewResult {
  webViewRef: React.RefObject<WebView | null>;
  formPayload: ShowFormPayload | null;
  setFormPayload: React.Dispatch<React.SetStateAction<ShowFormPayload | null>>;
  webViewReady: boolean;
  setWebViewReady: React.Dispatch<React.SetStateAction<boolean>>;
  webViewReadyRef: React.MutableRefObject<boolean>;
  webViewInstanceKey: number;
  setWebViewInstanceKey: React.Dispatch<React.SetStateAction<number>>;
  webViewUrl: string;
  formAnsweredTracked: React.MutableRefObject<Set<string>>;
  pendingDismissResolverRef: React.MutableRefObject<(() => void) | null>;
  injectSDKMessage: (msg: SDKMessage) => void;
  handleFormReady: () => void;
  handleWebViewMessage: (event: WebViewMessageEvent) => Promise<void>;
  handleShouldStartLoad: (request: { url?: string; isTopFrame?: boolean }) => boolean;
}

// ============================================================================
// Hook
// ============================================================================

export function useEncatchFormWebView(
  options: UseEncatchFormWebViewOptions
): UseEncatchFormWebViewResult {
  const { logTag, onClose, onHeightChange, onForceFullHeight, onReady, presentation } = options;

  const webViewRef = useRef<WebView | null>(null);
  const [formPayload, setFormPayload] = useState<ShowFormPayload | null>(null);
  const [webViewReady, setWebViewReady] = useState(false);
  const [webViewInstanceKey, setWebViewInstanceKey] = useState(0);

  const webViewReadyRef = useRef(false);
  const formAnsweredTracked = useRef<Set<string>>(new Set());
  const pendingDismissResolverRef = useRef<(() => void) | null>(null);
  const pendingCompletionCtaRef = useRef<unknown>(null);

  // Keep stable refs to callbacks so inner useCallbacks don't re-bind on every render
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onHeightChangeRef = useRef(onHeightChange);
  onHeightChangeRef.current = onHeightChange;
  const onForceFullHeightRef = useRef(onForceFullHeight);
  onForceFullHeightRef.current = onForceFullHeight;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Keep a stable ref to formPayload for use inside callbacks
  const formPayloadRef = useRef<ShowFormPayload | null>(formPayload);
  formPayloadRef.current = formPayload;

  // ============================================================================
  // WebView URL
  // ============================================================================

  const webViewUrl = useMemo(() => {
    if (!formPayload) return '';
    return buildFormWebViewUrl(
      Encatch.webHost,
      formPayload.formId,
      webViewInstanceKey,
      Encatch.debugMode,
      presentation
    );
  }, [formPayload, webViewInstanceKey, presentation]);

  // ============================================================================
  // Inject message into WebView (Native → WebView)
  // ============================================================================

  const injectSDKMessage = useCallback((msg: SDKMessage) => {
    if (!webViewRef.current) return;
    const js = `
      (function () {
        var message = ${JSON.stringify(msg)};
        if (typeof window.__encatchReceiveSDKMessage === 'function') {
          window.__encatchReceiveSDKMessage(message);
          return true;
        }

        window.__encatchSDKMessageQueue = window.__encatchSDKMessageQueue || [];
        window.__encatchSDKMessageQueue.push(message);

        window.dispatchEvent(new MessageEvent('message', { data: message }));
        return true;
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(js);
  }, []);

  // ============================================================================
  // form:ready handler — called from onMessage and the onLoad fallback timer
  // ============================================================================

  const handleFormReady = useCallback(() => {
    if (webViewReadyRef.current) return;
    const payload = formPayloadRef.current;
    if (!payload) return;

    const { formConfig, resetMode, triggerType, prefillResponses, locale, theme, context } = payload;

    injectSDKMessage({
      type: 'sdk:formConfig',
      data: {
        ...formConfig,
        triggerType,
        context,
      },
    });

    if (resetMode === 'always') {
      injectSDKMessage({ type: 'sdk:resetData' });
    }

    if (prefillResponses && Object.keys(prefillResponses).length > 0) {
      injectSDKMessage({ type: 'sdk:prefillResponses', data: { responses: prefillResponses } });
    } else {
      const pending = Encatch.getPendingResponses();
      if (Object.keys(pending).length > 0) {
        injectSDKMessage({ type: 'sdk:prefillResponses', data: { responses: pending } });
        Encatch.clearPendingResponses();
      }
    }

    if (theme) {
      injectSDKMessage({ type: 'sdk:theme', data: { theme } });
    }

    if (locale) {
      injectSDKMessage({ type: 'sdk:locale', data: { locale } });
    }

    webViewReadyRef.current = true;
    setWebViewReady(true);
    onReadyRef.current();
  }, [injectSDKMessage]);

  // ============================================================================
  // WebView onMessage handler (WebView → Native)
  // ============================================================================

  const handleWebViewMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let parsed: FormMessage;
      try {
        parsed = JSON.parse(event.nativeEvent.data) as FormMessage;
      } catch {
        console.warn(`[${logTag}] Failed to parse WebView message:`, event.nativeEvent.data);
        return;
      }

      const { type, data } = parsed;

      switch (type) {
        case 'form:ready': {
          handleFormReady();
          break;
        }

        case 'form:resize': {
          const h = data?.height;
          if (typeof h === 'number' && h > 0) {
            traceFormResize(Encatch.debugMode, logTag, 'resize-request', {
              height: h,
              presentation: presentation ?? 'modal',
            });
            onHeightChangeRef.current(h);
          }
          break;
        }

        case 'form:layout': {
          onForceFullHeightRef.current(data?.fullHeight === true);
          break;
        }

        case 'form:themeData': {
          break;
        }

        case 'form:submit': {
          if (!data) break;
          if (data.pendingCompletionCta) {
            pendingCompletionCtaRef.current = data.pendingCompletionCta;
            console.log(`[${logTag}] exit_form: pendingCompletionCta cached on form:submit`, JSON.stringify(data.pendingCompletionCta));
          } else {
            console.log(`[${logTag}] exit_form: form:submit received — no pendingCompletionCta in payload`);
          }
          const submitReq: SubmitFormRequest = {
            triggerType: (data.triggerType as 'automatic' | 'manual') ?? 'manual',
            formDetails: {
              formConfigurationId: data.feedbackConfigurationId as string,
              isPartialSubmit: (data.isPartialSubmit as boolean) ?? false,
              feedbackIdentifier: data.feedbackIdentifier as string | undefined,
              responseLanguageCode: data.responseLanguageCode as string | undefined,
              response: data.response as any,
              completionTimeInSeconds: data.completionTimeInSeconds as number | undefined,
              context: data.context as Record<string, string | number | boolean> | undefined,
              visitedQuestionIds: data.visitedQuestionIds as string[] | undefined,
            },
          };
          Encatch.submitForm(submitReq).catch(() => {});
          Encatch.emitEvent('form:submit', { formId: parsed.formId, data });
          break;
        }

        case 'form:complete': {
          // Resolve the form identifier — the bridge page formId var may be empty when the
          // form URL does not carry a formId param; fall back to feedbackConfigurationId.
          const completeFormId =
            parsed.formId || (data?.feedbackConfigurationId as string | undefined) || '';
          console.log(`[${logTag}] exit_form: form:complete received — formId: "${completeFormId}" | payload pendingCompletionCta:`, JSON.stringify(data?.pendingCompletionCta ?? null), '| cached ref:', JSON.stringify(pendingCompletionCtaRef.current ?? null));
          Encatch.emitEvent('form:complete', { formId: completeFormId, data });
          Encatch._trackFormEvent('form:complete', data?.feedbackConfigurationId as string | undefined).catch(() => {});
          formAnsweredTracked.current.delete(completeFormId);
          const pending = parsePendingCompletionCta(data?.pendingCompletionCta ?? pendingCompletionCtaRef.current);
          pendingCompletionCtaRef.current = null;
          console.log(`[${logTag}] exit_form: parsed pending CTA:`, JSON.stringify(pending));
          const closeImmediately = !!pending && pending.action !== 'dismiss';
          console.log(`[${logTag}] exit_form: calling onClose — immediate:`, closeImmediately);
          onCloseRef.current(closeImmediately ? { immediate: true } : undefined);
          if (pending && completeFormId) {
            console.log(`[${logTag}] exit_form: scheduling pending CTA for formId:`, completeFormId);
            schedulePendingCompletionCta(completeFormId, pending, logTag);
          } else {
            console.log(`[${logTag}] exit_form: no pending CTA to schedule — pending:`, !!pending, '| formId:', completeFormId);
          }
          break;
        }

        case 'form:close': {
          Encatch.emitEvent('form:close', { formId: parsed.formId, data });
          formAnsweredTracked.current.delete((data?.feedbackConfigurationId as string | undefined) ?? parsed.formId ?? '');
          onCloseRef.current();
          break;
        }

        case 'form:started': {
          Encatch.emitEvent('form:started', { formId: parsed.formId, data });
          Encatch._trackFormEvent('form:started', data?.feedbackConfigurationId as string | undefined).catch(() => {});
          break;
        }

        case 'form:answered': {
          Encatch.emitEvent('form:answered', { formId: parsed.formId, data });
          const answeredKey = (data?.feedbackConfigurationId as string | undefined) ?? parsed.formId ?? '';
          if (answeredKey && !formAnsweredTracked.current.has(answeredKey)) {
            formAnsweredTracked.current.add(answeredKey);
            Encatch._trackFormEvent('form:answered', data?.feedbackConfigurationId as string | undefined).catch(() => {});
          }
          break;
        }

        case 'form:section:change': {
          Encatch.emitEvent('form:section:change', { formId: parsed.formId, data });
          break;
        }

        case 'form:show': {
          Encatch.emitEvent('form:show', { formId: parsed.formId, data });
          Encatch._trackFormEvent('form:show', data?.feedbackConfigurationId as string | undefined).catch(() => {});
          break;
        }

        case 'form:refineTextRequest': {
          if (!data) break;
          const refineParams: RefineTextRequest = {
            questionId: data.questionId as string,
            feedbackConfigurationId: data.feedbackConfigurationId as string,
            userText: data.userText as string,
          };
          try {
            const res = await Encatch.refineText(refineParams);
            injectSDKMessage({
              type: 'sdk:refineTextResponse',
              data: { requestId: data.requestId as string, ...res },
            });
          } catch {
            injectSDKMessage({
              type: 'sdk:refineTextResponse',
              data: { requestId: data.requestId as string, error: 'Refine text request failed' },
            });
          }
          break;
        }

        case 'form:error': {
          console.warn(`[${logTag}] form:error received:`, data);
          Encatch.emitEvent('form:error', { formId: parsed.formId, data });
          break;
        }

        case 'form:readyToDismiss': {
          if (pendingDismissResolverRef.current) {
            pendingDismissResolverRef.current();
          }
          break;
        }

        case 'form:uploadFileRequest': {
          if (!data) break;

          const requestId = data.requestId as string | undefined;
          const feedbackConfigurationId = data.feedbackConfigurationId as string;
          const questionId = data.questionId as string;
          const fileDataBase64 = data.fileData as string;
          const fileName = (data.fileName as string | undefined) ?? 'upload';
          const mimeType = uploadMimeType(data.mimeType as string | undefined);

          if (!fileDataBase64) {
            injectSDKMessage({ type: 'sdk:uploadFileResponse', data: { requestId, error: 'Missing file data' } });
            break;
          }

          const file = {
            uri: `data:${mimeType};base64,${fileDataBase64}`,
            name: fileName,
            type: mimeType,
          };

          Encatch.uploadFile({
            feedbackConfigurationId,
            questionId,
            file,
            fileName,
            onProgress: (percent) => {
              injectSDKMessage({ type: 'sdk:uploadFileProgress', data: { requestId, percent } });
            },
          })
            .then((res) => {
              injectSDKMessage({ type: 'sdk:uploadFileResponse', data: { requestId, fileUrl: res.fileUrl } });
            })
            .catch((err: Error) => {
              injectSDKMessage({ type: 'sdk:uploadFileResponse', data: { requestId, error: err?.message ?? 'Upload failed' } });
            });
          break;
        }

        case 'form:qnaWithAiRequest': {
          if (!data) break;
          const requestId = data.requestId as string | undefined;
          Encatch.streamQnaWithAi(
            {
              feedbackConfigurationId: data.feedbackConfigurationId as string,
              questionId: data.questionId as string,
              conversation: (data.conversation as Array<{ question: string; answer: string }>) ?? [],
            },
            {
              onChunk: (delta) => {
                injectSDKMessage({ type: 'sdk:qnaWithAiChunk', data: { requestId, delta } });
              },
              onDone: (answer) => {
                injectSDKMessage({ type: 'sdk:qnaWithAiDone', data: { requestId, answer } });
              },
            }
          ).catch((err: Error) => {
            injectSDKMessage({ type: 'sdk:qnaWithAiResponse', data: { requestId, error: err?.message ?? 'Q&A with AI stream failed' } });
          });
          break;
        }

        case 'form:remindmelater': {
          Encatch.emitEvent('form:remindmelater', { formId: parsed.formId ?? '', data });
          onCloseRef.current();
          break;
        }

        case 'form:ctaTriggered': {
          const ctaAction = data?.action as string | undefined;
          const ctaUrl = data?.url as string | undefined;

          if (ctaAction === 'app_navigate') {
            // Emit first so host Encatch.on() subscribers can navigate, then close
            // the WebView the same way form:close does for redirect/dismiss CTAs.
            Encatch.emitEvent('form:ctaTriggered', { formId: parsed.formId, data });
            onCloseRef.current();
          } else if (ctaAction === 'redirect_internal' && ctaUrl) {
            // Close the modal before opening Custom Tabs / SFSafariViewController so the
            // transparent overlay cannot block touches after the browser dismisses (Android).
            onCloseRef.current({ immediate: true });
            const openDelayMs = getRedirectOpenDelayMs(ctaAction);
            setTimeout(() => {
              openRedirectInternalUrl(ctaUrl, logTag);
              Encatch.emitEvent('form:ctaTriggered', { formId: parsed.formId, data });
            }, openDelayMs);
          } else if (ctaAction === 'redirect_external' && ctaUrl) {
            onCloseRef.current({ immediate: true });
            setTimeout(() => {
              Linking.openURL(ctaUrl).catch((err) => {
                console.warn(`[${logTag}] redirect_external: failed to open URL:`, ctaUrl, err);
              });
              Encatch.emitEvent('form:ctaTriggered', { formId: parsed.formId, data });
            }, REDIRECT_AFTER_IMMEDIATE_CLOSE_DELAY_MS);
          }
          break;
        }

        default:
          break;
      }
    },
    [logTag, handleFormReady, injectSDKMessage]
  );

  // ============================================================================
  // Navigation guard — intercept external links from inside the WebView
  // ============================================================================

  const handleShouldStartLoad = useCallback(
    (request: { url?: string; isTopFrame?: boolean }) => {
      const url = request.url;
      if (!url || request.isTopFrame === false) return true;
      if (url.startsWith('about:blank') || url.startsWith('data:') || url.startsWith('blob:')) return true;
      if (!webViewUrl) return true;

      try {
        const requested = new URL(url);
        const form = new URL(webViewUrl);
        if (requested.origin === form.origin && requested.pathname === form.pathname) {
          return true;
        }
      } catch {
        return true;
      }

      Linking.openURL(url).catch((err) => {
        console.warn(`[${logTag}] Failed to open external URL:`, url, err);
      });
      return false;
    },
    [logTag, webViewUrl]
  );

  return {
    webViewRef,
    formPayload,
    setFormPayload,
    webViewReady,
    setWebViewReady,
    webViewReadyRef,
    webViewInstanceKey,
    setWebViewInstanceKey,
    webViewUrl,
    formAnsweredTracked,
    pendingDismissResolverRef,
    injectSDKMessage,
    handleFormReady,
    handleWebViewMessage,
    handleShouldStartLoad,
  };
}
