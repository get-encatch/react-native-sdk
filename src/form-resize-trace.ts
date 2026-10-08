/**
 * Optional resize tracing when Encatch.debugMode is enabled.
 */

export type FormResizeTraceEvent =
  | 'resize-request'
  | 'resize-applied'
  | 'resize-skipped'
  | 'keyboard-show'
  | 'keyboard-hide'
  | 'keyboard-settle';

export function traceFormResize(
  enabled: boolean,
  logTag: string,
  event: FormResizeTraceEvent,
  details: Record<string, unknown>
): void {
  if (!enabled) return;
  console.log(`[${logTag}] resize:${event}`, details);
}
