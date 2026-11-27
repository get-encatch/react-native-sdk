import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The gateway's secure-identify check.
 *
 * Source (encatch-user, branch Mil-2026-v2-release-10):
 * - user-gateway-service/ugw-auth/src/session.rs  validate_user_signature_and_session_time
 * - user-gateway-service/ugw-auth/src/hash.rs     generate_hmac_signature (hex HMAC-SHA256)
 * - user-gateway-service/ugw-core/src/headers.rs  X-User-Name, X-User-Signature, X-User-Session-Time
 *
 * Only identify-user is checked. Policy (gateway since 2026-11-27, encatch-user !722):
 * identity not required; the session time applies only to a key with a secret; a signed
 * time must be exactly 13 digits (epoch ms) and at most 5 minutes in the future; expiry
 * compared in whole minutes.
 */
export interface SignatureKey {
  /** The key's secret. Without one, the signature check is skipped. */
  secret?: string;
  /** Signature lifetime in minutes. When > 0 (and the key has a secret), the timestamp is signed and checked. */
  sessionTimeMinutes?: number;
}

export type SignatureResult =
  | 'ok'
  | 'missing-signature'
  | 'missing-timestamp'
  | 'invalid-timestamp'
  | 'invalid-signature'
  | 'expired';

/** How far ahead of the gateway's clock a signed time may be. */
export const FUTURE_SKEW_MS = 5 * 60_000;

/** Hex HMAC-SHA256, as the customer's backend and the gateway compute it. */
export function hmacHex(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

/** `headers` keys are matched case-insensitively. */
export function checkIdentifySignature(
  headers: Record<string, string | undefined>,
  key: SignatureKey,
  nowMs: number = Date.now()
): SignatureResult {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const nonEmpty = (v?: string) => (v ? v : undefined);
  const identity = nonEmpty(lower['x-user-name']);
  const signature = nonEmpty(lower['x-user-signature']);
  const timestamp = nonEmpty(lower['x-user-session-time']);
  const expiry = key.sessionTimeMinutes ?? 0;

  if (!identity) return 'ok';

  if (key.secret) {
    if (!signature) return 'missing-signature';
    let data = identity;
    if (expiry > 0) {
      if (!timestamp) return 'missing-timestamp';
      data = `${identity}${timestamp}`;
    }
    const a = Buffer.from(signature);
    const b = Buffer.from(hmacHex(data, key.secret));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid-signature';
  }

  // The session time is part of the signature: a key without a secret has none to expire.
  if (expiry <= 0 || !key.secret) return 'ok';
  if (!timestamp) return 'missing-timestamp';
  // Exactly 13 digits: the signed data is `name + time` with no separator, so a looser
  // time would let one signature pass for another name (`alice1` + T as `alice` + `1T`).
  if (!/^\d{13}$/.test(timestamp)) return 'invalid-timestamp';
  if (Number(timestamp) > nowMs + FUTURE_SKEW_MS) return 'invalid-timestamp';
  const ageMinutes = Math.trunc((nowMs - Number(timestamp)) / 60_000);
  return ageMinutes > expiry ? 'expired' : 'ok';
}
