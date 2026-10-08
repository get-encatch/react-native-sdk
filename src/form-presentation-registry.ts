/**
 * Inline slot registry for EncatchInlineForm.
 *
 * Maintains an ordered list of mounted inline slots. When showForm fires,
 * resolvePresentationTarget() determines whether it should render inline
 * (matching slot found) or fall through to the modal EncatchWebView.
 *
 * Routing rules:
 *  1. Exact match  — first slot whose formId matches the payload ids wins.
 *  2. Wildcard     — first slot with no formId catches anything not exact-matched.
 *  3. Modal        — no inline slot registered or none match.
 */
import { uuidv7 } from 'uuidv7';
import type { ShowFormResponse } from './types';

// ============================================================================
// Types
// ============================================================================

export interface InlineSlot {
  slotId: string;
  formId?: string;
}

export interface ShowFormResolutionPayload {
  /** Slug/uuid as passed to showForm(), or formConfigurationId from automatic triggers */
  formId: string;
  formConfig: ShowFormResponse;
}

export type PresentationTarget =
  | { type: 'inline'; slotId: string }
  | { type: 'modal' };

// ============================================================================
// Registry (module-level singleton, intentionally simple)
// ============================================================================

const _slots: InlineSlot[] = [];

/**
 * Register a new inline slot on component mount.
 * Returns an opaque slotId to use with unregisterInlineSlot / updateInlineSlot.
 * Registration order is preserved — first-registered wins for wildcard resolution.
 */
export function registerInlineSlot(formId?: string): string {
  const slotId = uuidv7();
  _slots.push({ slotId, formId });
  return slotId;
}

/**
 * Remove an inline slot on component unmount.
 */
export function unregisterInlineSlot(slotId: string): void {
  const idx = _slots.findIndex((s) => s.slotId === slotId);
  if (idx !== -1) _slots.splice(idx, 1);
}

/**
 * Update the formId of an existing slot without changing its registration order.
 * Called when the EncatchInlineForm formId prop changes after mount.
 */
export function updateInlineSlot(slotId: string, formId?: string): void {
  const slot = _slots.find((s) => s.slotId === slotId);
  if (slot) slot.formId = formId;
}

// ============================================================================
// Resolver
// ============================================================================

/**
 * Determine whether the given showForm payload should render inline or modal.
 *
 * ID matching checks the slot's formId against:
 *  - payload.formId  (the slug/uuid passed by the caller, or formConfigurationId)
 *  - payload.formConfig.feedbackConfigurationId  (server-resolved id)
 *
 * Single pass: find the first exact match, then the first wildcard; else modal.
 */
export function resolvePresentationTarget(
  payload: ShowFormResolutionPayload
): PresentationTarget {
  const candidateIds = new Set([
    payload.formId,
    payload.formConfig.feedbackConfigurationId,
  ].filter(Boolean));

  let firstWildcard: InlineSlot | undefined;

  for (const slot of _slots) {
    if (slot.formId) {
      if (candidateIds.has(slot.formId)) {
        return { type: 'inline', slotId: slot.slotId };
      }
    } else if (!firstWildcard) {
      firstWildcard = slot;
    }
  }

  if (firstWildcard) {
    return { type: 'inline', slotId: firstWildcard.slotId };
  }

  return { type: 'modal' };
}

/** Exposed for testing only — do not use in production code. */
export function _getSlots(): readonly InlineSlot[] {
  return _slots;
}

/** Exposed for testing only — clears the registry. */
export function _clearSlots(): void {
  _slots.length = 0;
}
